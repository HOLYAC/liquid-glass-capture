import CoreImage
import CoreMedia
import CoreVideo
import CryptoKit
import Darwin
import ImageIO
import ReplayKit
import UIKit
import UniformTypeIdentifiers

final class ReplayKitCompositorCaptureDaemon {
  private let writeQueue = DispatchQueue(label: "liquid-glass-capture.replaykit.write")
  private let ciContext = CIContext()
  private var activeSession: ReplayKitCaptureSession?

  func start(
    label: String,
    metadata: [String: Any],
    props: [String: Any],
    viewportPx: [String: Int],
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    guard activeSession == nil else {
      completion(.failure(Self.error("ReplayKit compositor capture is already active")))
      return
    }

    do {
      let session = try ReplayKitCaptureSession(
        label: label,
        metadata: metadata,
        props: props,
        viewportPx: viewportPx
      )
      activeSession = session

      let recorder = RPScreenRecorder.shared()
      recorder.isMicrophoneEnabled = false
      recorder.startCapture(handler: { [weak self, weak session] sampleBuffer, bufferType, error in
        guard let self, let session else {
          return
        }

        if let error {
          session.recordError(error.localizedDescription)
          return
        }

        guard bufferType == .video else {
          return
        }

        self.writeQueue.async {
          self.writeFrame(sampleBuffer: sampleBuffer, session: session)
        }
      }, completionHandler: { error in
        if let error {
          self.activeSession = nil
          completion(.failure(error))
          return
        }

        completion(.success(session.startPayload()))
      })
    } catch {
      completion(.failure(error))
    }
  }

  func stop(completion: @escaping (Result<[String: Any], Error>) -> Void) {
    guard let session = activeSession else {
      completion(.failure(Self.error("ReplayKit compositor capture is not active")))
      return
    }

    activeSession = nil
    RPScreenRecorder.shared().stopCapture { error in
      if let error {
        session.recordError(error.localizedDescription)
      }

      self.writeQueue.async {
        do {
          let payload = try session.finish()
          completion(.success(payload))
        } catch {
          completion(.failure(error))
        }
      }
    }
  }

  private func writeFrame(sampleBuffer: CMSampleBuffer, session: ReplayKitCaptureSession) {
    guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      session.recordError("Missing CVPixelBuffer for ReplayKit video sample")
      return
    }

    guard let frameSlot = session.reserveFrameSlot() else {
      return
    }

    let ciImage = CIImage(cvPixelBuffer: imageBuffer)
    guard let cgImage = ciContext.createCGImage(
      ciImage,
      from: ciImage.extent,
      format: .RGBA8,
      colorSpace: Self.displayP3ColorSpace()
    ) else {
      session.recordError("Could not create CGImage from ReplayKit frame")
      return
    }

    let pngData = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
      pngData,
      UTType.png.identifier as CFString,
      1,
      nil
    ) else {
      session.recordError("Could not create PNG destination for ReplayKit frame")
      return
    }

    CGImageDestinationAddImage(destination, cgImage, nil)
    guard CGImageDestinationFinalize(destination) else {
      session.recordError("Could not finalize ReplayKit frame PNG")
      return
    }

    do {
      var rawFrameMetadata: [String: Any]?
      if let rawFrame = session.captureRawFrame(from: imageBuffer, slot: frameSlot) {
        rawFrameMetadata = rawFrame
      }

      try (pngData as Data).write(to: frameSlot.pngUrl, options: .atomic)
      let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
      session.commitFrame(
        slot: frameSlot,
        ptsSeconds: timestamp.seconds,
        width: cgImage.width,
        height: cgImage.height,
        sha256: Self.sha256Hex(pngData as Data),
        rawFrame: rawFrameMetadata
      )
    } catch {
      session.recordError(error.localizedDescription)
    }
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func displayP3ColorSpace() -> CGColorSpace {
    CGColorSpace(name: CGColorSpace.displayP3) ?? CGColorSpaceCreateDeviceRGB()
  }

  private static func error(_ message: String) -> NSError {
    NSError(domain: "ReplayKitCompositorCaptureDaemon", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

private final class ReplayKitCaptureSession {
  private let lock = NSLock()
  private let ciContext = CIContext()
  private var nextFrameIndex = 0
  private var frameRecords: [[String: Any]] = []
  private var errors: [String] = []
  private let captureRawFrames: Bool
  private let captureRawPixels: Bool
  private let maxFrames: Int
  private let startedAt = Date()
  private let initialThermalState = ProcessInfo.processInfo.thermalState

  let id: String
  let sessionDir: URL
  let frameDir: URL
  let rawFrameDir: URL
  let metadata: [String: Any]
  let props: [String: Any]
  let viewportPx: [String: Int]

  init(label: String, metadata: [String: Any], props: [String: Any], viewportPx: [String: Int]) throws {
    let fileManager = FileManager.default
    let rootDir = try fileManager
      .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("LiquidGlassCaptures", isDirectory: true)
      .appendingPathComponent("Compositor", isDirectory: true)

    let stamp = Int(Date().timeIntervalSince1970 * 1000)
    let safeLabel = label
      .replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
      .prefix(48)
    id = "\(stamp)-\(safeLabel)-replaykit"
    sessionDir = rootDir.appendingPathComponent(id, isDirectory: true)
    frameDir = sessionDir.appendingPathComponent("frames", isDirectory: true)
    rawFrameDir = sessionDir.appendingPathComponent("raw", isDirectory: true)
    self.metadata = metadata
    self.props = props
    self.viewportPx = viewportPx
    maxFrames = max(1, min(metadata["maxFrames"] as? Int ?? 180, 900))
    let maxFidelity = (metadata["maxFidelity"] as? Bool) == true
    captureRawPixels = maxFidelity || (metadata["captureRawPixels"] as? Bool) == true
    captureRawFrames = maxFidelity
      || (metadata["captureRawFrames"] as? Bool) == true
      || captureRawPixels

    try fileManager.createDirectory(at: frameDir, withIntermediateDirectories: true)
    if captureRawFrames {
      try fileManager.createDirectory(at: rawFrameDir, withIntermediateDirectories: true)
    }
  }

  func reserveFrameSlot() -> ReplayKitFrameSlot? {
    lock.lock()
    defer { lock.unlock() }

    guard nextFrameIndex < maxFrames else {
      return nil
    }

    let index = nextFrameIndex
    nextFrameIndex += 1
    let name = String(format: "%06d.png", index)
    return ReplayKitFrameSlot(
      index: index,
      pngUrl: frameDir.appendingPathComponent(name),
      rawSourceUrl: captureRawFrames
        ? rawFrameDir.appendingPathComponent(String(format: "%06d.source.raw", index))
        : nil,
      rawDisplayUrl: captureRawPixels
        ? rawFrameDir.appendingPathComponent(String(format: "%06d.display.rgba", index))
        : nil
    )
  }

  func captureRawFrame(from imageBuffer: CVPixelBuffer, slot: ReplayKitFrameSlot) -> [String: Any]? {
    guard let rawSourceUrl = slot.rawSourceUrl else {
      return nil
    }

    let pixelFormat = CVPixelBufferGetPixelFormatType(imageBuffer)
    let sourceFormat = Self.pixelFormatName(for: pixelFormat)
    let sourceCapture = captureRawBuffer(from: imageBuffer, sourceFormat: sourceFormat)
    guard let sourceCapture else {
      return nil
    }

    do {
      try sourceCapture.data.write(to: rawSourceUrl, options: .atomic)
    } catch {
      recordError("Could not write source raw frame \(slot.index): \(error.localizedDescription)")
      return nil
    }

    var displayManifest: [String: Any]?
    if let rawDisplayUrl = slot.rawDisplayUrl,
       let display = captureDisplayRGBA(from: imageBuffer) {
      do {
        try display.data.write(to: rawDisplayUrl, options: .atomic)
        displayManifest = [
          "path": relativePath(for: rawDisplayUrl),
          "format": Self.kCVPixelFormatType_32RGBAString,
          "colorSpace": "display-p3",
          "width": display.width,
          "height": display.height,
          "bytesPerRow": display.bytesPerRow,
          "byteCount": display.byteCount,
          "sha256": Self.sha256Hex(display.data)
        ]
      } catch {
        recordError("Could not write display raw frame \(slot.index): \(error.localizedDescription)")
      }
    }

    var manifest: [String: Any] = [
      "path": relativePath(for: rawSourceUrl),
      "format": sourceCapture.format,
      "sourceFormat": sourceFormat,
      "colorSpace": "source-native",
      "width": sourceCapture.width,
      "height": sourceCapture.height,
      "bytesPerRow": sourceCapture.bytesPerRow,
      "byteCount": sourceCapture.byteCount,
      "sha256": Self.sha256Hex(sourceCapture.data)
    ]

    if let sourcePlanes = sourceCapture.sourcePlanes {
      manifest["source_planes"] = sourcePlanes
    }
    if let displayManifest {
      manifest["display"] = displayManifest
    }
    return manifest
  }

  private func captureRawBuffer(from imageBuffer: CVPixelBuffer, sourceFormat: String) -> RawBufferCapture? {
    if CVPixelBufferGetPlaneCount(imageBuffer) > 1 {
      return capturePlanarRawBuffer(from: imageBuffer)
    }
    return captureSinglePlaneRawBuffer(from: imageBuffer, sourceFormat: sourceFormat)
  }

  private func captureSinglePlaneRawBuffer(
    from imageBuffer: CVPixelBuffer,
    sourceFormat: String
  ) -> RawBufferCapture? {
    let width = CVPixelBufferGetWidth(imageBuffer)
    let height = CVPixelBufferGetHeight(imageBuffer)
    guard width > 0, height > 0 else {
      return nil
    }
    let lockResult = CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
    guard lockResult == kCVReturnSuccess else {
      return nil
    }
    defer {
      CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly)
    }

    guard let baseAddress = CVPixelBufferGetBaseAddress(imageBuffer) else {
      return nil
    }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer)
    let byteCount = bytesPerRow * height
    guard byteCount > 0 else {
      return nil
    }
    let bytes = Data(bytes: baseAddress, count: byteCount)
    return RawBufferCapture(
      data: bytes,
      width: width,
      height: height,
      bytesPerRow: bytesPerRow,
      byteCount: byteCount,
      format: sourceFormat,
      sourcePlanes: [
        [
          "index": 0,
          "format": sourceFormat,
          "width": width,
          "height": height,
          "bytesPerRow": bytesPerRow,
          "byteCount": byteCount,
          "byteOffset": 0,
          "sha256": Self.sha256Hex(bytes)
        ]
      ]
    )
  }

  private func capturePlanarRawBuffer(from imageBuffer: CVPixelBuffer) -> RawBufferCapture? {
    let planeCount = CVPixelBufferGetPlaneCount(imageBuffer)
    guard planeCount > 1 else {
      return nil
    }

    let width = CVPixelBufferGetWidth(imageBuffer)
    let height = CVPixelBufferGetHeight(imageBuffer)
    guard width > 0, height > 0 else {
      return nil
    }
    let pixelFormat = CVPixelBufferGetPixelFormatType(imageBuffer)
    let lockResult = CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
    guard lockResult == kCVReturnSuccess else {
      return nil
    }
    defer {
      CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly)
    }

    var packed = Data()
    var sourcePlanes: [[String: Any]] = []
    var maxBytesPerRow = 0
    for planeIndex in 0..<planeCount {
      guard let planeAddress = CVPixelBufferGetBaseAddressOfPlane(imageBuffer, planeIndex) else {
        return nil
      }
      let planeWidth = CVPixelBufferGetWidthOfPlane(imageBuffer, planeIndex)
      let planeHeight = CVPixelBufferGetHeightOfPlane(imageBuffer, planeIndex)
      let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(imageBuffer, planeIndex)
      guard planeWidth > 0, planeHeight > 0, bytesPerRow > 0 else {
        return nil
      }
      let planeByteCount = bytesPerRow * planeHeight
      let planeData = Data(bytes: planeAddress, count: planeByteCount)
      let planeManifest: [String: Any] = [
        "index": planeIndex,
        "format": Self.rawPlaneFormat(for: pixelFormat, index: planeIndex),
        "width": planeWidth,
        "height": planeHeight,
        "bytesPerRow": bytesPerRow,
        "byteCount": planeByteCount,
        "byteOffset": packed.count,
        "sha256": Self.sha256Hex(planeData)
      ]
      packed.append(planeData)
      sourcePlanes.append(planeManifest)
      maxBytesPerRow = max(maxBytesPerRow, bytesPerRow)
    }

    return RawBufferCapture(
      data: packed,
      width: width,
      height: height,
      bytesPerRow: maxBytesPerRow,
      byteCount: packed.count,
      format: Self.pixelFormatName(for: pixelFormat),
      sourcePlanes: sourcePlanes
    )
  }

  private func captureDisplayRGBA(from imageBuffer: CVPixelBuffer) -> RGBACaptureResult? {
    let ciImage = CIImage(cvPixelBuffer: imageBuffer, options: nil)
    let extent = ciImage.extent.integral
    let renderWidth = Int(extent.width)
    let renderHeight = Int(extent.height)
    guard renderWidth > 0, renderHeight > 0 else {
      return nil
    }
    let bytesPerRow = renderWidth * 4
    let byteCount = bytesPerRow * renderHeight
    var raw = Data(count: byteCount)
    let didRender = raw.withUnsafeMutableBytes { bytes in
      let ptr = bytes.bindMemory(to: UInt8.self).baseAddress
      guard let base = ptr else {
        return false
      }
      ciContext.render(
        ciImage,
        toBitmap: base,
        rowBytes: bytesPerRow,
        bounds: extent,
        format: .RGBA8,
        colorSpace: Self.displayP3ColorSpace()
      )
      return true
    }
    if !didRender {
      return nil
    }
    return RGBACaptureResult(
      data: raw,
      width: renderWidth,
      height: renderHeight,
      bytesPerRow: bytesPerRow,
      byteCount: byteCount
    )
  }

  func commitFrame(
    slot: ReplayKitFrameSlot,
    ptsSeconds: Double,
    width: Int,
    height: Int,
    sha256: String,
    rawFrame: [String: Any]?
  ) {
    lock.lock()
    var record: [String: Any] = [
      "index": slot.index,
      "ptsSeconds": ptsSeconds,
      "png": relativePath(for: slot.pngUrl),
      "sha256": sha256,
      "width": width,
      "height": height
    ]

    if let rawFrame {
      record["raw"] = rawFrame
    }

    frameRecords.append(record)
    lock.unlock()
  }

  func recordError(_ message: String) {
    lock.lock()
    errors.append(message)
    lock.unlock()
  }

  func startPayload() -> [String: Any] {
    [
      "schema_version": "1.2.0",
      "status": "started",
      "capture_kind": "compositor",
      "id": id,
      "sessionDir": sessionDir.path,
      "frameDir": frameDir.path
    ]
  }

  func finish() throws -> [String: Any] {
    lock.lock()
    let frames = frameRecords.sorted { left, right in
      (left["index"] as? Int ?? 0) < (right["index"] as? Int ?? 0)
    }
    let capturedErrors = errors
    lock.unlock()

    guard let firstFrame = frames.first,
          let basePath = firstFrame["png"] as? String,
          let baseSha = firstFrame["sha256"] as? String else {
      throw NSError(
        domain: "ReplayKitCompositorCaptureDaemon",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "ReplayKit compositor capture produced no video frames"]
      )
    }

    let sceneId = metadata["sceneId"] as? String ?? "S00_NULL"
    let rigId = metadata["rigId"] as? String ?? "R0"
    let stateId = metadata["stateId"] as? String ?? "compositor"
    let touchPhase = metadata["touchPhase"] as? String ?? "rest"
    let shape = (metadata["shape"] as? String) ?? (props["shape"] as? String) ?? "capsule"
    let phase = (metadata["phase"] as? String) ?? (props["phase"] as? String) ?? "rest"
    let maskPack = GlassMaskPackBuilder.make(
      sceneId: sceneId,
      stateId: stateId,
      shape: shape,
      phase: phase,
      touchPhase: touchPhase
    )
    let maskURL = sessionDir.appendingPathComponent("glass_core_mask_pack_v1.json")
    let maskData = try JSONSerialization.data(withJSONObject: maskPack, options: [.prettyPrinted, .sortedKeys])
    try maskData.write(to: maskURL, options: .atomic)

    let jsonURL = sessionDir.appendingPathComponent("\(id).capture.json")
    let frameManifestURL = sessionDir.appendingPathComponent("frame_manifest.json")
    let sustainedDurationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
    let refreshHz = Double(UIScreen.main.maximumFramesPerSecond)
    let finalThermalState = Self.thermalStateString(ProcessInfo.processInfo.thermalState)
    var framePack: [String: Any] = [
      "base_png_sha256": baseSha,
      "base_png_path": basePath,
      "sequence_paths": frames.compactMap { $0["png"] as? String },
      "sequence_timestamps_ms": Self.sequenceTimestampsMS(frames),
      "mask_pack_sha256": Self.sha256Hex(maskData),
      "mask_pack_path": relativePath(for: maskURL),
      "touch_phase": touchPhase,
      "animation_t": 0,
      "sustained_duration_ms": sustainedDurationMs
    ]
    if let trajectorySourceSHA256 = metadata["trajectorySourceSha256"] as? String {
      framePack["trajectory_source_sha256"] = trajectorySourceSHA256
    }
    if let captureTimelinePackId = metadata["captureTimelinePackId"] as? String {
      framePack["capture_timeline_pack_id"] = captureTimelinePackId
    }
    if let captureTimelineId = metadata["captureTimelineId"] as? String {
      framePack["capture_timeline_id"] = captureTimelineId
    }
    if let captureTimelineSHA256 = metadata["captureTimelineSha256"] as? String {
      framePack["capture_timeline_sha256"] = captureTimelineSHA256
    }
    if captureRawFrames {
      let manifest = try writeFrameManifest(to: frameManifestURL, frames: frames)
      framePack["frame_manifest_path"] = manifest.path
      framePack["frame_manifest_sha256"] = manifest.sha256
    }

    var environment: [String: Any] = [
      "appearance": metadata["appearance"] as? String ?? "dark",
      "reduce_transparency": UIAccessibility.isReduceTransparencyEnabled,
      "reduce_motion": UIAccessibility.isReduceMotionEnabled,
      "content_seed": metadata["contentSeed"] as? String ?? Self.contentSeed(for: stateId),
      "viewport_px": viewportPx,
      "capture_timestamp_ns": "\(UInt64(startedAt.timeIntervalSince1970 * 1_000_000_000))"
    ]
    if let backgroundAssetHash = metadata["backgroundAssetHash"] as? String {
      environment["background_asset_hash"] = backgroundAssetHash
    }
    if let backgroundPackId = metadata["backgroundPackId"] as? String {
      environment["background_pack_id"] = backgroundPackId
    }
    if let backgroundId = metadata["backgroundId"] as? String {
      environment["background_id"] = backgroundId
    }
    if let backgroundPackSHA256 = metadata["backgroundPackSha256"] as? String {
      environment["background_pack_sha256"] = backgroundPackSHA256
    }
    if let geometryPackId = metadata["geometryPackId"] as? String {
      environment["geometry_pack_id"] = geometryPackId
    }
    if let geometryId = metadata["geometryId"] as? String {
      environment["geometry_id"] = geometryId
    }
    if let geometryPackSHA256 = metadata["geometryPackSha256"] as? String {
      environment["geometry_pack_sha256"] = geometryPackSHA256
    }

    var deviceInfo: [String: Any] = [
      "model_name": UIDevice.current.model,
      "model_identifier": Self.hardwareModelIdentifier(),
      "os_name": "iOS",
      "os_version": UIDevice.current.systemVersion,
      "os_build": ProcessInfo.processInfo.operatingSystemVersionString,
      "sdk_build": Bundle.main.infoDictionary?["DTSDKBuild"] as? String ?? "runtime-unknown",
      "screen_scale": Double(UIScreen.main.scale),
      "refresh_hz": refreshHz,
      "thermal_state_start": Self.thermalStateString(initialThermalState),
      "thermal_state_end": finalThermalState,
      "low_power_mode": ProcessInfo.processInfo.isLowPowerModeEnabled
    ]
    if let deviceMatrixRole = metadata["deviceMatrixRole"] as? String {
      deviceInfo["device_matrix_role"] = deviceMatrixRole
    }

    var artifact: [String: Any] = [
      "schema_version": "1.2.0",
      "id": id,
      "rig_id": rigId,
      "scene_id": sceneId,
      "state_id": stateId,
      "git_commit": metadata["gitCommit"] as? String ?? "device-local",
      "technical_class": "INVALID",
      "verdict_class": "INVALID",
      "invalid_reason": "REPLAYKIT_CAPTURE_UNQUALIFIED",
      "null_qualification": metadata["nullQualification"] as? String ?? "fail",
      "capture_kind": "compositor",
      "device_info": deviceInfo,
      "environment": environment,
      "color": [
        "embedded_icc_profile": "Display P3",
        "icc_sha256": Self.displayP3ICCSHA256() ?? "missing-display-p3-icc",
        "working_space": "display-p3-linear",
        "stored_transfer": "srgb-transfer",
        "white_point": "D65"
      ],
      "frame_pack": framePack,
      "shader": [
        "pipeline": Self.shaderPipeline(rigId: rigId, mode: props["mode"] as? String)
      ],
      "perf": Self.perfBlock(frames: frames, refreshHz: refreshHz),
      "energy": Self.energyBlock(),
      "integrity": [
        "artifact_sha256": "pending",
        "producer_version": "ReplayKitCompositorCaptureDaemon.v1"
      ]
    ]

    var jsonData = try JSONSerialization.data(withJSONObject: artifact, options: [.prettyPrinted, .sortedKeys])
    var integrity = artifact["integrity"] as? [String: Any] ?? [:]
    integrity["artifact_sha256"] = Self.sha256Hex(jsonData)
    artifact["integrity"] = integrity
    jsonData = try JSONSerialization.data(withJSONObject: artifact, options: [.prettyPrinted, .sortedKeys])
    try jsonData.write(to: jsonURL, options: .atomic)

    artifact["status"] = "stopped"
    artifact["jsonPath"] = jsonURL.path
    artifact["sessionDir"] = sessionDir.path
    artifact["frameCount"] = frames.count
    artifact["replaykitErrors"] = capturedErrors
    return artifact
  }

  private static func thermalStateString(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal:
      return "nominal"
    case .fair:
      return "fair"
    case .serious:
      return "serious"
    case .critical:
      return "critical"
    @unknown default:
      return "fair"
    }
  }

  private static func contentSeed(for stateId: String) -> String {
    switch stateId {
    case "s00_flat_grey":
      return "s00-flat-p3-grey-v1"
    case "s00_hard_edge":
      return "s00-hard-edge-v1"
    case "s00_p3_ramp":
      return "s00-p3-ramp-v1"
    case "s00_smooth_gradient":
      return "s00-smooth-gradient-v1"
    case "rest":
      return "s01-search-selection-v1"
    case "drag":
      return "s02-loupe-text-drag-v1"
    case "press":
      return "s03-press-control-v1"
    case "morph":
      return "s04-twin-capsule-morph-v1"
    case "floating_rest":
      return "s05-floating-bar-v1"
    case "tiny_rest":
      return "s06-tiny-control-v1"
    case "busy_photo_rest":
      return "s07-busy-photo-procedural-v1"
    case "p3_gradient_rest":
      return "s08-p3-saturated-gradient-v1"
    case "near_white_rest":
      return "s09-near-white-v1"
    case "near_black_rest":
      return "s10-near-black-v1"
    case "video_frame_rest":
      return "s11-video-high-frequency-procedural-v1"
    case "system_material_rest":
      return "s12-system-material-adjacency-procedural-v1"
    default:
      return "manual-\(stateId)"
    }
  }

  private static func shaderPipeline(rigId: String, mode: String?) -> String {
    switch rigId {
    case "R0", "R1":
      return "passthrough"
    case "C0":
      return mode == "substrate_only" ? "passthrough" : "uniform_calibration"
    case "C1":
      return "baked_verdict"
    case "DOM_C":
      return "dom_css"
    case "DX_REPLAY":
      return "dx_replay"
    default:
      return "passthrough"
    }
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func writeFrameManifest(to manifestURL: URL, frames: [[String: Any]]) throws -> FrameManifestWriteResult {
    let manifest: [String: Any] = [
      "schema_version": "1.0.0",
      "frame_count": frames.count,
      "frames": frames
    ]
    let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
    try manifestData.write(to: manifestURL, options: .atomic)
    return FrameManifestWriteResult(
      path: relativePath(for: manifestURL),
      sha256: Self.sha256Hex(manifestData)
    )
  }

  private func relativePath(for url: URL) -> String {
    let base = sessionDir.standardizedFileURL.path
    let path = url.standardizedFileURL.path
    let prefix = base.hasSuffix("/") ? base : "\(base)/"
    if path.hasPrefix(prefix) {
      return String(path.dropFirst(prefix.count))
    }
    return path
  }

  private static func pixelFormatName(for pixelFormat: OSType) -> String {
    switch pixelFormat {
    case kCVPixelFormatType_32BGRA:
      "kCVPixelFormatType_32BGRA"
    case kCVPixelFormatType_32ARGB:
      "kCVPixelFormatType_32ARGB"
    case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
      "kCVPixelFormatType_420YpCbCr8BiPlanarFullRange"
    case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
      "kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange"
    default:
      String(format: "0x%08X", pixelFormat)
    }
  }

  private static func rawPlaneFormat(for pixelFormat: OSType, index: Int) -> String {
    switch pixelFormat {
    case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
         kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
      return index == 0 ? "Y_PLANE" : "UV_PLANE_PACKED"
    default:
      return "plane_\(index)"
    }
  }

  private static let kCVPixelFormatType_32RGBAString = "kCVPixelFormatType_32RGBA"

  private static func sequenceTimestampsMS(_ frames: [[String: Any]]) -> [Double] {
    let seconds = frames.compactMap { $0["ptsSeconds"] as? Double }
    guard let first = seconds.first else {
      return []
    }
    return seconds.map { ($0 - first) * 1000.0 }
  }

  private static func perfBlock(frames: [[String: Any]], refreshHz: Double) -> [String: Any] {
    let intervals = frameIntervalsMS(frames)
    var block: [String: Any] = [
      "measurement_source": "replaykit_sample_buffer_pts_proxy",
      "dropped_frames": droppedFrameEstimate(intervals)
    ]

    if !intervals.isEmpty {
      let p95 = quantile(intervals, 0.95)
      block["frame_interval_ms_p95"] = p95
      block["full_frame_ms_p95"] = p95
      block["compositor_frame_ms_p95"] = p95
      if let degradation = sustainedDegradationPct(intervals) {
        block["sustained_degradation_pct"] = degradation
      }
    }
    if refreshHz > 0 {
      block["refresh_budget_ms"] = 1000.0 / refreshHz
    }
    return block
  }

  private static func energyBlock() -> [String: Any] {
    [
      "trace_available": false,
      "trace_status": "trace_unavailable",
      "measurement_source": "thermal_state_only_no_power_trace"
    ]
  }

  private static func frameIntervalsMS(_ frames: [[String: Any]]) -> [Double] {
    let seconds = frames.compactMap { $0["ptsSeconds"] as? Double }.sorted()
    guard seconds.count >= 2 else {
      return []
    }
    var intervals: [Double] = []
    for index in 1..<seconds.count {
      intervals.append((seconds[index] - seconds[index - 1]) * 1000.0)
    }
    return intervals
  }

  private static func droppedFrameEstimate(_ intervals: [Double]) -> Int {
    guard !intervals.isEmpty else {
      return 0
    }
    let median = quantile(intervals, 0.5)
    guard median > 0 else {
      return 0
    }
    return intervals.filter { $0 > median * 1.5 }.count
  }

  private static func sustainedDegradationPct(_ intervals: [Double]) -> Double? {
    guard intervals.count >= 6 else {
      return nil
    }
    let bucketSize = max(1, intervals.count / 3)
    let first = mean(Array(intervals.prefix(bucketSize)))
    let last = mean(Array(intervals.suffix(bucketSize)))
    guard first > 0 else {
      return nil
    }
    return max(0, (last - first) / first * 100.0)
  }

  private static func quantile(_ values: [Double], _ q: Double) -> Double {
    guard !values.isEmpty else {
      return 0
    }
    let sorted = values.sorted()
    let position = Double(sorted.count - 1) * q
    let lower = Int(floor(position))
    let upper = Int(ceil(position))
    if lower == upper {
      return sorted[lower]
    }
    let weight = position - Double(lower)
    return sorted[lower] * (1 - weight) + sorted[upper] * weight
  }

  private static func mean(_ values: [Double]) -> Double {
    guard !values.isEmpty else {
      return 0
    }
    return values.reduce(0, +) / Double(values.count)
  }

  private static func hardwareModelIdentifier() -> String {
    var info = utsname()
    uname(&info)
    return withUnsafePointer(to: &info.machine) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: 1) { rebound in
        String(cString: rebound)
      }
    }
  }

  private static func displayP3ColorSpace() -> CGColorSpace {
    CGColorSpace(name: CGColorSpace.displayP3) ?? CGColorSpaceCreateDeviceRGB()
  }

  private static func displayP3ICCSHA256() -> String? {
    guard let colorSpace = CGColorSpace(name: CGColorSpace.displayP3),
          let iccData = colorSpace.copyICCData() as Data? else {
      return nil
    }
    return sha256Hex(iccData)
  }
}

private struct ReplayKitFrameSlot {
  let index: Int
  let pngUrl: URL
  let rawSourceUrl: URL?
  let rawDisplayUrl: URL?
}

private struct FrameManifestWriteResult {
  let path: String
  let sha256: String
}

private struct RawBufferCapture {
  let data: Data
  let width: Int
  let height: Int
  let bytesPerRow: Int
  let byteCount: Int
  let format: String
  let sourcePlanes: [[String: Any]]?
}

private struct RGBACaptureResult {
  let data: Data
  let width: Int
  let height: Int
  let bytesPerRow: Int
  let byteCount: Int
}
