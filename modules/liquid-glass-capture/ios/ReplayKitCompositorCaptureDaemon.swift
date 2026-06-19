import CoreImage
import CoreMedia
import CryptoKit
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
    guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else {
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
      try (pngData as Data).write(to: frameSlot.url, options: .atomic)
      let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
      session.commitFrame(
        slot: frameSlot,
        ptsSeconds: timestamp.seconds,
        width: cgImage.width,
        height: cgImage.height,
        sha256: Self.sha256Hex(pngData as Data)
      )
    } catch {
      session.recordError(error.localizedDescription)
    }
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func error(_ message: String) -> NSError {
    NSError(domain: "ReplayKitCompositorCaptureDaemon", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

private final class ReplayKitCaptureSession {
  private let lock = NSLock()
  private var nextFrameIndex = 0
  private var frameRecords: [[String: Any]] = []
  private var errors: [String] = []
  private let maxFrames: Int
  private let startedAt = Date()

  let id: String
  let sessionDir: URL
  let frameDir: URL
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
    self.metadata = metadata
    self.props = props
    self.viewportPx = viewportPx
    maxFrames = max(1, min(metadata["maxFrames"] as? Int ?? 180, 900))

    try fileManager.createDirectory(at: frameDir, withIntermediateDirectories: true)
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
    return ReplayKitFrameSlot(index: index, url: frameDir.appendingPathComponent(name))
  }

  func commitFrame(slot: ReplayKitFrameSlot, ptsSeconds: Double, width: Int, height: Int, sha256: String) {
    lock.lock()
    frameRecords.append([
      "index": slot.index,
      "ptsSeconds": ptsSeconds,
      "png": slot.url.path,
      "sha256": sha256,
      "width": width,
      "height": height
    ])
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

    let maskURL = sessionDir.appendingPathComponent("glass_core_mask_pack_v1.json")
    let maskData = try JSONSerialization.data(withJSONObject: Self.maskPack(), options: [.prettyPrinted, .sortedKeys])
    try maskData.write(to: maskURL, options: .atomic)

    let sceneId = metadata["sceneId"] as? String ?? "S00_NULL"
    let rigId = metadata["rigId"] as? String ?? "R0"
    let stateId = metadata["stateId"] as? String ?? "compositor"
    let jsonURL = sessionDir.appendingPathComponent("\(id).capture.json")
    let touchPhase = metadata["touchPhase"] as? String ?? "rest"

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
      "device_info": [
        "model_name": UIDevice.current.model,
        "model_identifier": UIDevice.current.model,
        "os_name": "iOS",
        "os_version": UIDevice.current.systemVersion,
        "os_build": ProcessInfo.processInfo.operatingSystemVersionString,
        "sdk_build": Bundle.main.infoDictionary?["DTSDKBuild"] as? String ?? "runtime-unknown",
        "screen_scale": Double(UIScreen.main.scale),
        "refresh_hz": Double(UIScreen.main.maximumFramesPerSecond),
        "thermal_state_start": Self.thermalStateString(ProcessInfo.processInfo.thermalState),
        "thermal_state_end": Self.thermalStateString(ProcessInfo.processInfo.thermalState),
        "low_power_mode": ProcessInfo.processInfo.isLowPowerModeEnabled
      ],
      "environment": [
        "appearance": metadata["appearance"] as? String ?? "dark",
        "reduce_transparency": UIAccessibility.isReduceTransparencyEnabled,
        "reduce_motion": UIAccessibility.isReduceMotionEnabled,
        "content_seed": metadata["contentSeed"] as? String ?? Self.contentSeed(for: stateId),
        "viewport_px": viewportPx,
        "capture_timestamp_ns": "\(UInt64(startedAt.timeIntervalSince1970 * 1_000_000_000))"
      ],
      "color": [
        "embedded_icc_profile": "Display P3",
        "icc_sha256": "replaykit-unverified-display-p3",
        "working_space": "display-p3-linear",
        "stored_transfer": "srgb-transfer",
        "white_point": "D65"
      ],
      "frame_pack": [
        "base_png_sha256": baseSha,
        "base_png_path": basePath,
        "sequence_paths": frames.compactMap { $0["png"] as? String },
        "mask_pack_sha256": Self.sha256Hex(maskData),
        "mask_pack_path": maskURL.path,
        "touch_phase": touchPhase,
        "animation_t": 0,
        "sustained_duration_ms": Int(Date().timeIntervalSince(startedAt) * 1000)
      ],
      "shader": [
        "pipeline": Self.shaderPipeline(rigId: rigId, mode: props["mode"] as? String)
      ],
      "perf": [
        "dropped_frames": 0
      ],
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

  private static func maskPack() -> [String: Any] {
    [
      "schema_version": "1.2.0",
      "mask_pack_id": "glass_core_mask_pack_v1",
      "masks": [
        ["id": "core"],
        ["id": "edge_band"],
        ["id": "highlight"],
        ["id": "text"],
        ["id": "text_halo"],
        ["id": "background_control"],
        ["id": "motion_path"],
        ["id": "compositor_region"],
        ["id": "product_focus"]
      ]
    ]
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
}

private struct ReplayKitFrameSlot {
  let index: Int
  let url: URL
}
