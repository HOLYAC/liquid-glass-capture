import ExpoModulesCore
import CryptoKit
import SwiftUI
import UIKit
import WebKit

public final class LiquidGlassCaptureView: ExpoView {
  private let model = NativeHarnessModel()
  private let compositorCapture = ReplayKitCompositorCaptureDaemon()
  private let nullQualification = NullQualificationService()
  private var host: UIHostingController<NativeCaptureRootView>?

  public var mode: CaptureMode {
    get { model.mode }
    set { model.mode = newValue }
  }

  public var rig: RigKind {
    get { model.rig }
    set { model.rig = newValue }
  }

  public var substrate: SubstrateKind {
    get { model.substrate }
    set { model.substrate = newValue }
  }

  public var probeShape: ProbeShape {
    get { model.shape }
    set { model.shape = newValue }
  }

  public var phase: ProbePhase {
    get { model.phase }
    set { model.phase = newValue }
  }

  public var tint: GlassTint {
    get { model.tint }
    set { model.tint = newValue }
  }

  public var interactive: Bool {
    get { model.interactive }
    set { model.interactive = newValue }
  }

  public var autoplay: Bool {
    get { model.autoplay }
    set { model.autoplay = newValue }
  }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black

    let controller = UIHostingController(rootView: NativeCaptureRootView(model: model))
    controller.view.backgroundColor = .clear
    host = controller
    addSubview(controller.view)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    host?.view.frame = bounds
  }

  public func captureSnapshot(label: String, metadata: [String: Any]) throws -> [String: Any] {
    if bounds.width < 1 || bounds.height < 1 {
      throw NSError(domain: "LiquidGlassCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "View has no drawable bounds"])
    }

    layoutIfNeeded()

    let format = UIGraphicsImageRendererFormat()
    format.scale = UIScreen.main.scale
    format.opaque = true

    let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
    let image = renderer.image { _ in
      drawHierarchy(in: bounds, afterScreenUpdates: true)
    }

    guard let pngData = image.pngData() else {
      throw NSError(domain: "LiquidGlassCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode PNG"])
    }

    let fileManager = FileManager.default
    let captureDir = try fileManager
      .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("LiquidGlassCaptures", isDirectory: true)
    try fileManager.createDirectory(at: captureDir, withIntermediateDirectories: true)

    let stamp = Int(Date().timeIntervalSince1970 * 1000)
    let safeLabel = label
      .replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
      .prefix(48)
    let basename = "\(stamp)-\(safeLabel)"
    let pngURL = captureDir.appendingPathComponent("\(basename).png")
    let jsonURL = captureDir.appendingPathComponent("\(basename).json")

    try pngData.write(to: pngURL, options: .atomic)

    var payload: [String: Any] = [
      "label": label,
      "timestampMs": stamp,
      "pngPath": pngURL.path,
      "jsonPath": jsonURL.path,
      "view": [
        "width": Double(bounds.width),
        "height": Double(bounds.height),
        "scale": Double(format.scale)
      ],
      "props": [
        "rig": model.rig.rawValue,
        "mode": model.mode.rawValue,
        "substrate": model.substrate.rawValue,
        "shape": model.shape.rawValue,
        "phase": model.phase.rawValue,
        "tint": model.tint.rawValue,
        "interactive": model.interactive,
        "autoplay": model.autoplay
      ],
      "metadata": metadata,
      "metrics": Self.metrics(for: image)
    ]

    let jsonData = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    try jsonData.write(to: jsonURL, options: .atomic)
    payload["jsonPath"] = jsonURL.path
    return payload
  }

  public func captureLabArtifact(label: String, metadata: [String: Any]) throws -> [String: Any] {
    if bounds.width < 1 || bounds.height < 1 {
      throw NSError(domain: "LiquidGlassCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "View has no drawable bounds"])
    }

    layoutIfNeeded()

    let format = UIGraphicsImageRendererFormat()
    format.scale = UIScreen.main.scale
    format.opaque = true

    let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
    let image = renderer.image { _ in
      drawHierarchy(in: bounds, afterScreenUpdates: true)
    }

    guard let pngData = image.pngData() else {
      throw NSError(domain: "LiquidGlassCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode PNG"])
    }

    let fileManager = FileManager.default
    let captureDir = try fileManager
      .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("LiquidGlassCaptures", isDirectory: true)
    try fileManager.createDirectory(at: captureDir, withIntermediateDirectories: true)

    let stamp = Int(Date().timeIntervalSince1970 * 1000)
    let safeLabel = label
      .replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
      .prefix(48)
    let basename = "\(stamp)-\(safeLabel)-capture-artifact"
    let pngURL = captureDir.appendingPathComponent("\(basename).png")
    let maskURL = captureDir.appendingPathComponent("\(basename).mask-pack.json")
    let jsonURL = captureDir.appendingPathComponent("\(basename).capture.json")

    try pngData.write(to: pngURL, options: .atomic)

    let maskPack: [String: Any] = [
      "schema_version": "1.2.0",
      "mask_pack_id": "glass_core_mask_pack_v1",
      "description": "Logical mask pack for the full S00-S12 Apple Liquid Glass parity matrix. Pixel masks are generated by scene geometry in the capture daemon.",
      "source": "packages/material-glass/src/index.mjs",
      "scene_coverage": [
        "S00_NULL",
        "S01_SEARCH",
        "S02_LOUPE",
        "S03_PRESS",
        "S04_MORPH",
        "S05_FLOATING_BAR",
        "S06_TINY_GLASS",
        "S07_BUSY_PHOTO",
        "S08_P3_GRADIENT",
        "S09_NEAR_WHITE",
        "S10_NEAR_BLACK",
        "S11_VIDEO_FRAME",
        "S12_SYSTEM_MATERIAL_ADJACENCY"
      ],
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
    let maskData = try JSONSerialization.data(withJSONObject: maskPack, options: [.prettyPrinted, .sortedKeys])
    try maskData.write(to: maskURL, options: .atomic)

    let sceneId = metadata["sceneId"] as? String ?? (model.substrate.rawValue.hasPrefix("s00_") ? "S00_NULL" : "S01_SEARCH")
    let rigId = metadata["rigId"] as? String ?? model.rig.rawValue
    let stateId = metadata["stateId"] as? String ?? model.substrate.rawValue
    let artifactId = "\(rigId)-\(sceneId)-\(stateId)-\(stamp)"
    let invalidReason = sceneId == "S00_NULL" ? "MANUAL_S00_SMOKE" : "CAPTURE_PATH_INVALID"
    var framePack: [String: Any] = [
      "base_png_sha256": Self.sha256Hex(pngData),
      "base_png_path": pngURL.path,
      "mask_pack_sha256": Self.sha256Hex(maskData),
      "mask_pack_path": maskURL.path,
      "touch_phase": Self.touchPhase(for: model.phase),
      "animation_t": 0
    ]
    if let trajectorySourceSHA256 = metadata["trajectorySourceSha256"] as? String {
      framePack["trajectory_source_sha256"] = trajectorySourceSHA256
    }

    var environment: [String: Any] = [
      "appearance": traitCollection.userInterfaceStyle == .light ? "light" : "dark",
      "reduce_transparency": UIAccessibility.isReduceTransparencyEnabled,
      "reduce_motion": UIAccessibility.isReduceMotionEnabled,
      "content_seed": metadata["contentSeed"] as? String ?? Self.contentSeed(for: stateId),
      "viewport_px": [
        "width": Int(bounds.width * format.scale),
        "height": Int(bounds.height * format.scale)
      ],
      "capture_timestamp_ns": "\(UInt64(Date().timeIntervalSince1970 * 1_000_000_000))"
    ]
    if let backgroundAssetHash = metadata["backgroundAssetHash"] as? String {
      environment["background_asset_hash"] = backgroundAssetHash
    }

    var artifact: [String: Any] = [
      "schema_version": "1.2.0",
      "id": artifactId,
      "rig_id": rigId,
      "scene_id": sceneId,
      "state_id": stateId,
      "git_commit": metadata["gitCommit"] as? String ?? "device-local",
      "technical_class": "INVALID",
      "verdict_class": "INVALID",
      "invalid_reason": invalidReason,
      "null_qualification": sceneId == "S00_NULL" ? "pass" : "fail",
      "capture_kind": "layer_snapshot",
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
        "low_power_mode": ProcessInfo.processInfo.isLowPowerModeEnabled
      ],
      "environment": environment,
      "color": [
        "embedded_icc_profile": "Display P3",
        "icc_sha256": "unverified-layer-snapshot",
        "working_space": "display-p3-linear",
        "stored_transfer": "srgb-transfer",
        "white_point": "D65"
      ],
      "frame_pack": framePack,
      "shader": [
        "pipeline": Self.shaderPipeline(for: model.rig, mode: model.mode)
      ],
      "integrity": [
        "artifact_sha256": "pending",
        "producer_version": "LiquidGlassCaptureNative.captureArtifact.v1"
      ]
    ]

    var jsonData = try JSONSerialization.data(withJSONObject: artifact, options: [.prettyPrinted, .sortedKeys])
    var integrity = artifact["integrity"] as? [String: Any] ?? [:]
    integrity["artifact_sha256"] = Self.sha256Hex(jsonData)
    artifact["integrity"] = integrity
    jsonData = try JSONSerialization.data(withJSONObject: artifact, options: [.prettyPrinted, .sortedKeys])
    try jsonData.write(to: jsonURL, options: .atomic)
    artifact["jsonPath"] = jsonURL.path
    return artifact
  }

  public func startCompositorCapture(label: String, metadata: [String: Any], promise: Promise) {
    let scale = UIScreen.main.scale
    let viewportPx = [
      "width": Int(bounds.width * scale),
      "height": Int(bounds.height * scale)
    ]

    compositorCapture.start(
      label: label,
      metadata: metadata,
      props: labProps(),
      viewportPx: viewportPx
    ) { result in
      switch result {
      case .success(let payload):
        promise.resolve(payload)
      case .failure(let error):
        promise.reject(error)
      }
    }
  }

  public func stopCompositorCapture(promise: Promise) {
    compositorCapture.stop { result in
      switch result {
      case .success(let payload):
        promise.resolve(payload)
      case .failure(let error):
        promise.reject(error)
      }
    }
  }

  public func runNullQualification(referenceArtifactPath: String, candidateArtifactPath: String, rung: String?, promise: Promise) {
    do {
      let payload = try nullQualification.run(
        referenceArtifactPath: referenceArtifactPath,
        candidateArtifactPath: candidateArtifactPath,
        rung: rung
      )
      promise.resolve(payload)
    } catch {
      promise.reject(error)
    }
  }

  public func runCompositorRepeatCapture(
    label: String,
    metadata: [String: Any],
    repeatCount: Int,
    captureDurationMs: Int,
    cooldownMs: Int,
    promise: Promise
  ) {
    let boundedRepeatCount = max(1, min(repeatCount, 300))
    let boundedCaptureDurationMs = max(250, min(captureDurationMs, 60_000))
    let boundedCooldownMs = max(0, min(cooldownMs, 60_000))
    let requiresNominalThermal = metadata["requiresNominalThermal"] as? Bool ?? true
    let initialThermalState = ProcessInfo.processInfo.thermalState

    if requiresNominalThermal && initialThermalState != .nominal {
      promise.reject(Self.error("Baseline repeat capture requires nominal thermal state before first capture"))
      return
    }

    let scale = UIScreen.main.scale
    let viewportPx = [
      "width": Int(bounds.width * scale),
      "height": Int(bounds.height * scale)
    ]
    let stamp = UInt64(Date().timeIntervalSince1970 * 1000)
    let safeLabel = label
      .replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
      .prefix(44)
    let seriesId = "\(stamp)-\(safeLabel)-repeat"
    let startedAtNs = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
    var artifacts: [[String: Any]] = []
    var failures: [String] = []
    var runIteration: ((Int) -> Void)!

    func finish(status: String) {
      do {
        let payload = try Self.writeRepeatManifest(
          label: label,
          seriesId: seriesId,
          metadata: metadata,
          status: status,
          repeatCountRequested: boundedRepeatCount,
          captureDurationMs: boundedCaptureDurationMs,
          cooldownMs: boundedCooldownMs,
          startedAtNs: startedAtNs,
          initialThermalState: Self.thermalStateString(initialThermalState),
          artifacts: artifacts,
          failures: failures
        )
        promise.resolve(payload)
      } catch {
        promise.reject(error)
      }
    }

    runIteration = { [weak self] index in
      guard let self else {
        failures.append("VIEW_DEALLOCATED")
        finish(status: "aborted")
        return
      }

      guard index < boundedRepeatCount else {
        finish(status: failures.isEmpty ? "complete" : "partial")
        return
      }

      let thermalState = ProcessInfo.processInfo.thermalState
      if requiresNominalThermal && thermalState != .nominal {
        failures.append("THERMAL_STATE_NOT_NOMINAL_BEFORE_REPEAT_\(index)")
        finish(status: "aborted")
        return
      }

      var iterationMetadata = metadata
      iterationMetadata["captureSeriesId"] = seriesId
      iterationMetadata["repeatIndex"] = index
      iterationMetadata["repeatCount"] = boundedRepeatCount
      iterationMetadata["requiresNominalThermal"] = requiresNominalThermal
      iterationMetadata["captureDurationMs"] = boundedCaptureDurationMs
      iterationMetadata["cooldownMs"] = boundedCooldownMs
      if iterationMetadata["maxFrames"] == nil {
        iterationMetadata["maxFrames"] = max(8, Int(ceil(Double(boundedCaptureDurationMs) / 1000.0 * Double(UIScreen.main.maximumFramesPerSecond))))
      }

      let iterationLabel = "\(seriesId)-\(String(format: "%03d", index))"
      self.compositorCapture.start(
        label: iterationLabel,
        metadata: iterationMetadata,
        props: self.labProps(),
        viewportPx: viewportPx
      ) { startResult in
        switch startResult {
        case .success:
          DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(boundedCaptureDurationMs)) {
            self.compositorCapture.stop { stopResult in
              DispatchQueue.main.async {
                switch stopResult {
                case .success(let artifact):
                  artifacts.append(artifact)
                  DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(boundedCooldownMs)) {
                    runIteration(index + 1)
                  }
                case .failure(let error):
                  failures.append("STOP_FAILED_\(index): \(error.localizedDescription)")
                  finish(status: "aborted")
                }
              }
            }
          }
        case .failure(let error):
          failures.append("START_FAILED_\(index): \(error.localizedDescription)")
          finish(status: "aborted")
        }
      }
    }

    runIteration(0)
  }

  private static func metrics(for image: UIImage) -> [String: Any] {
    guard let cgImage = image.cgImage else {
      return ["sampled": false]
    }

    let width = 96
    let height = 96
    let bytesPerPixel = 4
    let bytesPerRow = width * bytesPerPixel
    var pixels = [UInt8](repeating: 0, count: width * height * bytesPerPixel)

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
      data: &pixels,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
      return ["sampled": false]
    }

    context.interpolationQuality = .high
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

    var lumas = [Double](repeating: 0, count: width * height)
    var lumaSum = 0.0
    var satSum = 0.0
    var minLuma = 1.0
    var maxLuma = 0.0

    for index in 0..<(width * height) {
      let offset = index * bytesPerPixel
      let red = Double(pixels[offset]) / 255.0
      let green = Double(pixels[offset + 1]) / 255.0
      let blue = Double(pixels[offset + 2]) / 255.0
      let luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue
      let high = max(red, green, blue)
      let low = min(red, green, blue)
      let saturation = high == 0 ? 0 : (high - low) / high

      lumas[index] = luma
      lumaSum += luma
      satSum += saturation
      minLuma = min(minLuma, luma)
      maxLuma = max(maxLuma, luma)
    }

    let count = Double(width * height)
    let meanLuma = lumaSum / count
    let meanSaturation = satSum / count
    var variance = 0.0
    var edgeEnergy = 0.0

    for y in 0..<height {
      for x in 0..<width {
        let index = y * width + x
        let delta = lumas[index] - meanLuma
        variance += delta * delta
        if x + 1 < width {
          edgeEnergy += abs(lumas[index] - lumas[index + 1])
        }
        if y + 1 < height {
          edgeEnergy += abs(lumas[index] - lumas[index + width])
        }
      }
    }

    let edgeSamples = Double((width - 1) * height + (height - 1) * width)
    return [
      "sampled": true,
      "sampleWidth": width,
      "sampleHeight": height,
      "meanLuma": meanLuma,
      "minLuma": minLuma,
      "maxLuma": maxLuma,
      "rmsContrast": sqrt(variance / count),
      "meanSaturation": meanSaturation,
      "edgeEnergy": edgeEnergy / edgeSamples
    ]
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func error(_ message: String) -> NSError {
    NSError(domain: "LiquidGlassCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private static func writeRepeatManifest(
    label: String,
    seriesId: String,
    metadata: [String: Any],
    status: String,
    repeatCountRequested: Int,
    captureDurationMs: Int,
    cooldownMs: Int,
    startedAtNs: UInt64,
    initialThermalState: String,
    artifacts: [[String: Any]],
    failures: [String]
  ) throws -> [String: Any] {
    let fileManager = FileManager.default
    let seriesDir = try fileManager
      .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("LiquidGlassCaptures", isDirectory: true)
      .appendingPathComponent("Series", isDirectory: true)
    try fileManager.createDirectory(at: seriesDir, withIntermediateDirectories: true)

    let jsonURL = seriesDir.appendingPathComponent("\(seriesId).repeat-manifest.json")
    let artifactJsonPaths = artifacts.compactMap { $0["jsonPath"] as? String }
    let artifactSummaries = artifacts.map { artifact in
      [
        "id": artifact["id"] as? String ?? "",
        "rig_id": artifact["rig_id"] as? String ?? "",
        "scene_id": artifact["scene_id"] as? String ?? "",
        "state_id": artifact["state_id"] as? String ?? "",
        "jsonPath": artifact["jsonPath"] as? String ?? "",
        "sessionDir": artifact["sessionDir"] as? String ?? "",
        "frameCount": artifact["frameCount"] as? Int ?? 0
      ] as [String: Any]
    }

    var manifest: [String: Any] = [
      "schema_version": "1.2.0",
      "kind": "repeat_capture_manifest",
      "id": seriesId,
      "label": label,
      "status": status,
      "rig_id": metadata["rigId"] as? String ?? "R0",
      "scene_id": metadata["sceneId"] as? String ?? "S01_SEARCH",
      "state_id": metadata["stateId"] as? String ?? "rest",
      "baseline_class": metadata["baselineClass"] as? String ?? "mvl",
      "capture_kind": "compositor",
      "repeat_count_requested": repeatCountRequested,
      "repeat_count_observed": artifactJsonPaths.count,
      "capture_duration_ms": captureDurationMs,
      "cooldown_ms": cooldownMs,
      "started_at_ns": "\(startedAtNs)",
      "finished_at_ns": "\(UInt64(Date().timeIntervalSince1970 * 1_000_000_000))",
      "thermal": [
        "requires_nominal_start": metadata["requiresNominalThermal"] as? Bool ?? true,
        "initial_state": initialThermalState,
        "final_state": Self.thermalStateString(ProcessInfo.processInfo.thermalState)
      ],
      "policy": [
        "partial_is_not_verdict": true,
        "mvl_repeat_n": 50,
        "prod_p99_repeat_n": 300,
        "sustained_repeat_n": 24
      ],
      "artifact_json_paths": artifactJsonPaths,
      "artifacts": artifactSummaries,
      "failures": failures
    ]

    var jsonData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
    manifest["manifest_sha256"] = Self.sha256Hex(jsonData)
    jsonData = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
    try jsonData.write(to: jsonURL, options: .atomic)
    manifest["jsonPath"] = jsonURL.path
    return manifest
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

  private static func touchPhase(for phase: ProbePhase) -> String {
    switch phase {
    case .press:
      return "press"
    case .dragLeft, .dragRight:
      return "drag"
    case .morphTall, .mergeNear, .mergeOverlap:
      return "morph"
    case .rest:
      return "rest"
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

  private func labProps() -> [String: Any] {
    [
      "rig": model.rig.rawValue,
      "mode": model.mode.rawValue,
      "substrate": model.substrate.rawValue,
      "shape": model.shape.rawValue,
      "phase": model.phase.rawValue,
      "tint": model.tint.rawValue,
      "interactive": model.interactive,
      "autoplay": model.autoplay
    ]
  }

  private static func shaderPipeline(for rig: RigKind, mode: CaptureMode) -> String {
    switch rig {
    case .r0, .r1:
      return "passthrough"
    case .c0:
      return mode == .substrateOnly ? "passthrough" : "uniform_calibration"
    case .c1:
      return "baked_verdict"
    case .domC:
      return "dom_css"
    case .dxReplay:
      return "dx_replay"
    }
  }
}

final class NativeHarnessModel: ObservableObject {
  @Published var rig: RigKind = .r0
  @Published var mode: CaptureMode = .glassOverSubstrate
  @Published var substrate: SubstrateKind = .checker4
  @Published var shape: ProbeShape = .capsule
  @Published var phase: ProbePhase = .rest
  @Published var tint: GlassTint = .none
  @Published var interactive = false
  @Published var autoplay = false
}

public enum RigKind: String {
  case r0 = "R0"
  case r1 = "R1"
  case c0 = "C0"
  case c1 = "C1"
  case domC = "DOM_C"
  case dxReplay = "DX_REPLAY"
}

public enum CaptureMode: String {
  case substrateOnly = "substrate_only"
  case glassOverSubstrate = "glass_over_substrate"
  case glassOverBlack = "glass_over_black"
}

public enum SubstrateKind: String {
  case s00FlatGrey = "s00_flat_grey"
  case s00HardEdge = "s00_hard_edge"
  case s00P3Ramp = "s00_p3_ramp"
  case s00SmoothGradient = "s00_smooth_gradient"
  case checker1 = "checker_1px"
  case checker2 = "checker_2px"
  case checker4 = "checker_4px"
  case checker8 = "checker_8px"
  case grid
  case rgbStripes = "rgb_stripes"
  case lumaRamp = "luma_ramp"
  case textWeights = "text_weights"
  case caretSelection = "caret_selection"
  case nativeTextSelection = "native_text_selection"
  case loupeText = "loupe_text"
  case floatingBarContent = "floating_bar_content"
  case tinyControlContent = "tiny_control_content"
  case busyPhoto = "busy_photo"
  case p3SaturatedGradient = "p3_saturated_gradient"
  case nearWhite = "near_white"
  case nearBlack = "near_black"
  case videoFrame = "video_frame"
  case systemMaterialAdjacency = "system_material_adjacency"
  case noise
}

public enum ProbeShape: String {
  case circle
  case capsule
  case roundedRect = "rounded_rect"
  case twinCapsules = "twin_capsules"
}

public enum ProbePhase: String {
  case rest
  case press
  case dragLeft = "drag_left"
  case dragRight = "drag_right"
  case mergeNear = "merge_near"
  case mergeOverlap = "merge_overlap"
  case morphTall = "morph_tall"
}

public enum GlassTint: String {
  case none
  case cyan
  case amber
  case red
}

struct NativeCaptureRootView: View {
  @ObservedObject var model: NativeHarnessModel

  var body: some View {
    TimelineView(.animation) { timeline in
      GeometryReader { proxy in
        let time = timeline.date.timeIntervalSinceReferenceDate
        ZStack {
          switch model.rig {
          case .r0:
            if model.mode == .glassOverBlack {
              Color.black
            } else {
              NativeSubstrateView(kind: model.substrate)
            }

            if model.mode != .substrateOnly {
              NativeGlassLayer(model: model, time: time, size: proxy.size)
            }
          case .r1, .c0, .c1, .domC:
            CandidateWebRigView(rig: model.rig, substrate: model.substrate, mode: model.mode)
          case .dxReplay:
            NativeSubstrateView(kind: model.substrate)
          }
        }
        .ignoresSafeArea()
      }
    }
    .background(Color.black)
  }
}

struct CandidateWebRigView: UIViewRepresentable {
  let rig: RigKind
  let substrate: SubstrateKind
  let mode: CaptureMode

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.suppressesIncrementalRendering = false

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.isOpaque = true
    webView.backgroundColor = .black
    webView.scrollView.backgroundColor = .black
    webView.scrollView.isScrollEnabled = false
    webView.scrollView.bounces = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.loadHTMLString(html, baseURL: nil)
    context.coordinator.lastHTML = html
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    if context.coordinator.lastHTML != html {
      webView.loadHTMLString(html, baseURL: nil)
      context.coordinator.lastHTML = html
    }
  }

  private var html: String {
    switch rig {
    case .c0, .c1:
      return Self.canvasPassthroughHTML(substrate: substrate, mode: mode)
    case .r1, .domC:
      return Self.domPassthroughHTML(substrate: substrate, mode: mode, includeDOMGlass: rig == .r1 && mode != .substrateOnly)
    case .r0, .dxReplay:
      return Self.domPassthroughHTML(substrate: substrate, mode: mode, includeDOMGlass: false)
    }
  }

  final class Coordinator {
    var lastHTML = ""
  }

  private static func canvasPassthroughHTML(substrate: SubstrateKind, mode: CaptureMode) -> String {
    """
    <!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>
          html, body, canvas { margin:0; width:100%; height:100%; overflow:hidden; background:#000; }
          canvas { display:block; }
        </style>
      </head>
      <body>
        <canvas id="stage"></canvas>
        <script>
          const substrate = "\(substrate.rawValue)";
          const mode = "\(mode.rawValue)";
          const canvas = document.getElementById("stage");
          const ctx = canvas.getContext("2d", { colorSpace: "display-p3", alpha: false });

          function resize() {
            const scale = window.devicePixelRatio || 1;
            canvas.width = Math.max(1, Math.round(innerWidth * scale));
            canvas.height = Math.max(1, Math.round(innerHeight * scale));
            draw();
          }

          function draw() {
            const w = canvas.width;
            const h = canvas.height;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            if (mode === "glass_over_black") {
              ctx.fillStyle = "#000";
              ctx.fillRect(0, 0, w, h);
            } else {
              drawSubstrate(ctx, w, h, substrate);
            }

            if (mode !== "substrate_only") {
              drawCalibrationPlaceholder(ctx, w, h);
            }
          }

          function drawSubstrate(ctx, w, h, substrate) {
            if (substrate === "s00_flat_grey") {
              ctx.fillStyle = "color(display-p3 0.5 0.5 0.5)";
              ctx.fillRect(0, 0, w, h);
              return;
            }
            if (substrate === "s00_hard_edge") {
              ctx.fillStyle = "#000";
              ctx.fillRect(0, 0, w * 0.5, h);
              ctx.fillStyle = "#fff";
              ctx.fillRect(w * 0.5, 0, w * 0.5, h);
              return;
            }
            if (substrate === "s00_p3_ramp") {
              const g = ctx.createLinearGradient(0, 0, w, 0);
              g.addColorStop(0.0, "color(display-p3 1 0 0)");
              g.addColorStop(0.34, "color(display-p3 0 1 0)");
              g.addColorStop(0.67, "color(display-p3 0 0 1)");
              g.addColorStop(1.0, "#fff");
              ctx.fillStyle = g;
              ctx.fillRect(0, 0, w, h);
              return;
            }
            if (substrate === "s00_smooth_gradient") {
              const g = ctx.createLinearGradient(0, 0, w, h);
              g.addColorStop(0.0, "rgb(20,20,20)");
              g.addColorStop(0.38, "rgb(107,107,107)");
              g.addColorStop(0.62, "rgb(163,163,163)");
              g.addColorStop(1.0, "rgb(235,235,235)");
              ctx.fillStyle = g;
              ctx.fillRect(0, 0, w, h);
              return;
            }
            if (substrate === "loupe_text") {
              drawLoupeText(ctx, w, h);
              return;
            }
            if (substrate === "floating_bar_content") {
              drawFloatingBarContent(ctx, w, h);
              return;
            }
            if (substrate === "tiny_control_content") {
              drawTinyControlContent(ctx, w, h);
              return;
            }
            if (substrate === "busy_photo") {
              drawBusyPhoto(ctx, w, h);
              return;
            }
            if (substrate === "p3_saturated_gradient") {
              const g = ctx.createLinearGradient(0, 0, w, h);
              g.addColorStop(0.0, "color(display-p3 1 0.05 0.18)");
              g.addColorStop(0.24, "color(display-p3 1 0.72 0)");
              g.addColorStop(0.50, "color(display-p3 0 0.95 0.58)");
              g.addColorStop(0.74, "color(display-p3 0 0.38 1)");
              g.addColorStop(1.0, "color(display-p3 0.92 0 1)");
              ctx.fillStyle = g;
              ctx.fillRect(0, 0, w, h);
              return;
            }
            if (substrate === "near_white") {
              ctx.fillStyle = "rgb(240,240,240)";
              ctx.fillRect(0, 0, w, h);
              for (let i = 0; i < 18; i++) {
                ctx.fillStyle = `rgba(${210 + (i % 5) * 7}, ${210 + (i % 5) * 7}, ${210 + (i % 5) * 7}, 0.82)`;
                roundRect(ctx, (i * 0.29 % 1) * w, (i * 0.47 % 1) * h, w * (0.16 + (i % 5) * 0.035), 18 + (i % 4) * 7, 16);
                ctx.fill();
              }
              return;
            }
            if (substrate === "near_black") {
              ctx.fillStyle = "rgb(4,4,4)";
              ctx.fillRect(0, 0, w, h);
              for (let i = 0; i < 42; i++) {
                const r = 2 + (i % 7);
                ctx.fillStyle = `rgba(${26 + (i % 6) * 6}, ${26 + (i % 6) * 6}, ${26 + (i % 6) * 6}, 0.86)`;
                ctx.beginPath();
                ctx.arc((i * 0.17 % 1) * w, (i * 0.43 % 1) * h, r, 0, Math.PI * 2);
                ctx.fill();
              }
              ctx.strokeStyle = "rgba(255,255,255,0.10)";
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(0, h * 0.63);
              ctx.lineTo(w, h * 0.57);
              ctx.stroke();
              return;
            }
            if (substrate === "video_frame") {
              drawVideoFrame(ctx, w, h);
              return;
            }
            if (substrate === "system_material_adjacency") {
              drawSystemMaterialAdjacency(ctx, w, h);
              return;
            }
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, w, h);
            const cell = Math.max(4, Math.round(4 * (window.devicePixelRatio || 1)));
            for (let y = 0; y < h; y += cell) {
              for (let x = 0; x < w; x += cell) {
                ctx.fillStyle = ((x / cell + y / cell) % 2) < 1 ? "#ebebeb" : "#0f0f0f";
                ctx.fillRect(x, y, cell, cell);
              }
            }
          }

          function drawLoupeText(ctx, w, h) {
            const g = ctx.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, "#0a0a0b");
            g.addColorStop(0.48, "#202124");
            g.addColorStop(1, "#050506");
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            const boxW = Math.min(w * 0.78, 980 * (window.devicePixelRatio || 1));
            const boxH = Math.min(h * 0.24, 220 * (window.devicePixelRatio || 1));
            roundRect(ctx, (w - boxW) * 0.5, h * 0.46, boxW, boxH, 30 * (window.devicePixelRatio || 1));
            ctx.fillStyle = "#151515";
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.font = `${38 * (window.devicePixelRatio || 1)}px -apple-system, system-ui`;
            ctx.fillText("liquid glass measures the air between letters", (w - boxW) * 0.5 + 42, h * 0.46 + 62);
            ctx.fillStyle = "#94d1ff";
            ctx.font = `600 ${24 * (window.devicePixelRatio || 1)}px -apple-system, system-ui`;
            ctx.fillText("drag vector / selection handle / magnified baseline", (w - boxW) * 0.5 + 42, h * 0.46 + 110);
          }

          function drawFloatingBarContent(ctx, w, h) {
            const g = ctx.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, "#06101a");
            g.addColorStop(0.5, "#152021");
            g.addColorStop(1, "#020406");
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            const margin = Math.min(w * 0.08, 80 * (window.devicePixelRatio || 1));
            for (let i = 0; i < 6; i++) {
              const y = h * 0.16 + i * 104 * (window.devicePixelRatio || 1);
              roundRect(ctx, margin, y, w - margin * 2, 86 * (window.devicePixelRatio || 1), 24 * (window.devicePixelRatio || 1));
              ctx.fillStyle = i % 2 === 0 ? "#292929" : "#191919";
              ctx.fill();
              ctx.fillStyle = `hsl(${i * 52}, 72%, 62%)`;
              ctx.beginPath();
              ctx.arc(margin + 46, y + 43, 23 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = "rgba(255,255,255,0.72)";
              roundRect(ctx, margin + 92, y + 26, 220, 9, 5);
              ctx.fill();
              ctx.fillStyle = "rgba(255,255,255,0.26)";
              roundRect(ctx, margin + 92, y + 48, 420, 7, 4);
              ctx.fill();
            }
          }

          function drawTinyControlContent(ctx, w, h) {
            ctx.fillStyle = "#0c0c0c";
            ctx.fillRect(0, 0, w, h);
            const bw = 70 * (window.devicePixelRatio || 1);
            const bh = 48 * (window.devicePixelRatio || 1);
            const gap = 18 * (window.devicePixelRatio || 1);
            const startX = (w - (bw * 5 + gap * 4)) * 0.5;
            const startY = (h - (bh * 4 + gap * 3)) * 0.5;
            for (let row = 0; row < 4; row++) {
              for (let col = 0; col < 5; col++) {
                const active = (row + col) % 3 === 0;
                roundRect(ctx, startX + col * (bw + gap), startY + row * (bh + gap), bw, bh, 18);
                ctx.fillStyle = active ? "#33b3f2" : "#2b2b2b";
                ctx.fill();
              }
            }
          }

          function drawBusyPhoto(ctx, w, h) {
            const g = ctx.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, "#081018");
            g.addColorStop(0.5, "#384733");
            g.addColorStop(1, "#0f0d14");
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            for (let i = 0; i < 72; i++) {
              const x = ((i * 37) % 100) / 100 * w;
              const y = ((i * 61) % 100) / 100 * h;
              const rw = w * (0.05 + (i % 7) * 0.012);
              const rh = h * (0.035 + (i % 5) * 0.011);
              roundRect(ctx, x - rw * 0.5, y - rh * 0.5, rw, rh, Math.min(rw, rh) * 0.34);
              ctx.fillStyle = `hsla(${i * 19}, ${48 + (i % 4) * 9}%, ${44 + (i % 5) * 8}%, 0.72)`;
              ctx.fill();
              if (i % 4 === 0) {
                ctx.strokeStyle = "rgba(255,255,255,0.18)";
                ctx.beginPath();
                ctx.arc(x + (i % 11) - 18, y - 18, 18, 0, Math.PI * 2);
                ctx.stroke();
              }
            }
          }

          function drawVideoFrame(ctx, w, h) {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, w, h);
            const stripeW = Math.max(2, w / 120);
            let x = 0;
            let i = 0;
            while (x < w) {
              ctx.fillStyle = `hsl(${i * 47}, 72%, ${18 + (i % 9) * 7.5}%)`;
              ctx.fillRect(x, 0, stripeW + 1, h);
              x += stripeW;
              i += 1;
            }
            for (let row = 0; row < 18; row++) {
              ctx.fillStyle = row % 3 === 0 ? "rgba(255,255,255,0.30)" : "rgba(255,255,255,0.09)";
              ctx.fillRect(0, h * row / 18, w, 1);
            }
          }

          function drawSystemMaterialAdjacency(ctx, w, h) {
            const g = ctx.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, "#05080d");
            g.addColorStop(0.5, "#1a1a1f");
            g.addColorStop(1, "#08050a");
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            const cardW = 230 * (window.devicePixelRatio || 1);
            const gap = 22 * (window.devicePixelRatio || 1);
            const start = (w - cardW * 3 - gap * 2) * 0.5;
            for (let i = 0; i < 3; i++) {
              const x = start + i * (cardW + gap);
              const y = h * 0.34;
              roundRect(ctx, x - 26, y - 58, cardW + 52, 240, 34);
              ctx.fillStyle = "rgba(255,255,255,0.06)";
              ctx.fill();
              roundRect(ctx, x, y, cardW, 130 + i * 26, 26);
              ctx.fillStyle = "rgba(255,255,255,0.18)";
              ctx.fill();
              ctx.strokeStyle = "rgba(255,255,255,0.18)";
              ctx.stroke();
            }
          }

          function drawCalibrationPlaceholder(ctx, w, h) {
            const cw = Math.min(w * 0.7, 820 * (window.devicePixelRatio || 1));
            const ch = Math.min(Math.max(h * 0.12, 74), 120) * (window.devicePixelRatio || 1);
            const x = (w - cw) * 0.5;
            const y = h * 0.56 - ch * 0.5;
            ctx.save();
            ctx.globalAlpha = 0.18;
            ctx.fillStyle = "#fff";
            roundRect(ctx, x, y, cw, ch, ch * 0.5);
            ctx.fill();
            ctx.restore();
          }

          function roundRect(ctx, x, y, w, h, r) {
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
            ctx.closePath();
          }

          addEventListener("resize", resize, { passive: true });
          resize();
        </script>
      </body>
    </html>
    """
  }

  private static func domPassthroughHTML(substrate: SubstrateKind, mode: CaptureMode, includeDOMGlass: Bool) -> String {
    """
    <!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>
          html, body, #stage { margin:0; width:100%; height:100%; overflow:hidden; background:#000; }
          #stage { position:relative; }
          .s00_flat_grey { background: color(display-p3 0.5 0.5 0.5); }
          .s00_hard_edge { background: linear-gradient(90deg, #000 0 50%, #fff 50% 100%); }
          .s00_p3_ramp { background: linear-gradient(90deg, color(display-p3 1 0 0), color(display-p3 0 1 0) 34%, color(display-p3 0 0 1) 67%, #fff); }
          .s00_smooth_gradient { background: linear-gradient(135deg, rgb(20,20,20), rgb(107,107,107) 38%, rgb(163,163,163) 62%, rgb(235,235,235)); }
          .loupe_text { background: linear-gradient(135deg, #0a0a0b, #202124 48%, #050506); }
          .floating_bar_content { background: repeating-linear-gradient(180deg, #06101a 0 92px, #152021 92px 184px, #020406 184px 276px); }
          .tiny_control_content { background-color:#0c0c0c; background-image: radial-gradient(circle at 36% 46%, #33b3f2 0 18px, transparent 19px), radial-gradient(circle at 58% 52%, #333 0 24px, transparent 25px); }
          .busy_photo { background: radial-gradient(circle at 20% 30%, #795d2a, transparent 19%), radial-gradient(circle at 70% 35%, #295f77, transparent 16%), radial-gradient(circle at 46% 70%, #7a294d, transparent 21%), linear-gradient(135deg, #081018, #384733 50%, #0f0d14); }
          .p3_saturated_gradient { background: linear-gradient(135deg, color(display-p3 1 0.05 0.18), color(display-p3 1 0.72 0) 24%, color(display-p3 0 0.95 0.58) 50%, color(display-p3 0 0.38 1) 74%, color(display-p3 0.92 0 1)); }
          .near_white { background: linear-gradient(135deg, #f2f2f2, #dedede 48%, #fafafa); }
          .near_black { background: radial-gradient(circle at 70% 30%, #222, transparent 16%), linear-gradient(165deg, #030303, #111 52%, #050505); }
          .video_frame { background-size: 7px 100%, 100% 32px; background-image: repeating-linear-gradient(90deg, #1d1d1d 0 2px, #724b98 2px 4px, #246674 4px 6px, #989225 6px 7px), repeating-linear-gradient(180deg, rgba(255,255,255,0.24) 0 1px, transparent 1px 32px); }
          .system_material_adjacency { background: linear-gradient(135deg, #05080d, #1a1a1f 50%, #08050a); }
          .fallback { background-size: 8px 8px; background-image: linear-gradient(45deg, #ebebeb 25%, #0f0f0f 25%, #0f0f0f 50%, #ebebeb 50%, #ebebeb 75%, #0f0f0f 75%); }
          .black { background:#000; }
          .glass {
            position:absolute;
            left:50%;
            top:56%;
            width:min(70vw, 820px);
            height:clamp(74px, 12vh, 120px);
            transform:translate(-50%, -50%);
            border-radius:999px;
            background:rgba(255,255,255,0.14);
            -webkit-backdrop-filter: blur(18px) saturate(1.25);
            backdrop-filter: blur(18px) saturate(1.25);
            box-shadow: inset 0 1px rgba(255,255,255,0.35), inset 0 -1px rgba(0,0,0,0.24);
          }
        </style>
      </head>
      <body>
        <div id="stage" class="\(mode == .glassOverBlack ? "black" : cssClass(for: substrate))">
          \(includeDOMGlass ? "<div class=\"glass\"></div>" : "")
        </div>
      </body>
    </html>
    """
  }

  private static func cssClass(for substrate: SubstrateKind) -> String {
    switch substrate {
    case .s00FlatGrey:
      return "s00_flat_grey"
    case .s00HardEdge:
      return "s00_hard_edge"
    case .s00P3Ramp:
      return "s00_p3_ramp"
    case .s00SmoothGradient:
      return "s00_smooth_gradient"
    case .loupeText:
      return "loupe_text"
    case .floatingBarContent:
      return "floating_bar_content"
    case .tinyControlContent:
      return "tiny_control_content"
    case .busyPhoto:
      return "busy_photo"
    case .p3SaturatedGradient:
      return "p3_saturated_gradient"
    case .nearWhite:
      return "near_white"
    case .nearBlack:
      return "near_black"
    case .videoFrame:
      return "video_frame"
    case .systemMaterialAdjacency:
      return "system_material_adjacency"
    default:
      return "fallback"
    }
  }
}

struct NativeSubstrateView: View {
  let kind: SubstrateKind

  var body: some View {
    ZStack {
      Color.black
      switch kind {
      case .s00FlatGrey:
        S00FlatGrey()
      case .s00HardEdge:
        S00HardEdge()
      case .s00P3Ramp:
        S00P3Ramp()
      case .s00SmoothGradient:
        S00SmoothGradient()
      case .checker1, .checker2, .checker4, .checker8:
        Checkerboard(cell: checkerCell)
      case .grid:
        GridSubstrate()
      case .rgbStripes:
        RGBStripes()
      case .lumaRamp:
        LumaRamp()
      case .textWeights:
        TextWeights()
      case .caretSelection:
        CaretSelection()
      case .nativeTextSelection:
        NativeTextSelection()
      case .loupeText:
        LoupeText()
      case .floatingBarContent:
        FloatingBarContent()
      case .tinyControlContent:
        TinyControlContent()
      case .busyPhoto:
        BusyPhotoSubstrate()
      case .p3SaturatedGradient:
        P3SaturatedGradient()
      case .nearWhite:
        NearWhiteSubstrate()
      case .nearBlack:
        NearBlackSubstrate()
      case .videoFrame:
        VideoFrameSubstrate()
      case .systemMaterialAdjacency:
        SystemMaterialAdjacencySubstrate()
      case .noise:
        NoiseSubstrate()
      }
    }
  }

  private var checkerCell: CGFloat {
    switch kind {
    case .s00FlatGrey, .s00HardEdge, .s00P3Ramp, .s00SmoothGradient:
      return 4
    case .checker1: return 1
    case .checker2: return 2
    case .checker4: return 4
    case .checker8: return 8
    default: return 4
    }
  }
}

struct S00FlatGrey: View {
  var body: some View {
    Color(red: 0.5, green: 0.5, blue: 0.5)
  }
}

struct S00HardEdge: View {
  var body: some View {
    GeometryReader { proxy in
      HStack(spacing: 0) {
        Color.black
          .frame(width: proxy.size.width * 0.5)
        Color.white
      }
    }
  }
}

struct S00P3Ramp: View {
  var body: some View {
    Rectangle()
      .fill(
        LinearGradient(
          stops: [
            .init(color: Color(red: 1.0, green: 0.0, blue: 0.0), location: 0.0),
            .init(color: Color(red: 0.0, green: 1.0, blue: 0.0), location: 0.34),
            .init(color: Color(red: 0.0, green: 0.0, blue: 1.0), location: 0.67),
            .init(color: Color.white, location: 1.0)
          ],
          startPoint: .leading,
          endPoint: .trailing
        )
      )
  }
}

struct S00SmoothGradient: View {
  var body: some View {
    Rectangle()
      .fill(
        LinearGradient(
          stops: [
            .init(color: Color(white: 0.08), location: 0.0),
            .init(color: Color(white: 0.42), location: 0.38),
            .init(color: Color(white: 0.64), location: 0.62),
            .init(color: Color(white: 0.92), location: 1.0)
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
      )
  }
}

struct Checkerboard: View {
  let cell: CGFloat

  var body: some View {
    Canvas { context, size in
      let cols = Int(ceil(size.width / cell))
      let rows = Int(ceil(size.height / cell))
      for y in 0...rows {
        for x in 0...cols {
          let value: Double = (x + y).isMultiple(of: 2) ? 0.92 : 0.06
          context.fill(
            Path(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)),
            with: .color(Color(white: value))
          )
        }
      }
    }
  }
}

struct GridSubstrate: View {
  var body: some View {
    Canvas { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
      for step in [8.0, 32.0, 96.0] {
        let alpha = step == 8 ? 0.22 : (step == 32 ? 0.42 : 0.68)
        var path = Path()
        var x = 0.0
        while x <= size.width {
          path.move(to: CGPoint(x: x, y: 0))
          path.addLine(to: CGPoint(x: x, y: size.height))
          x += step
        }
        var y = 0.0
        while y <= size.height {
          path.move(to: CGPoint(x: 0, y: y))
          path.addLine(to: CGPoint(x: size.width, y: y))
          y += step
        }
        context.stroke(path, with: .color(.white.opacity(alpha)), lineWidth: step == 96 ? 2 : 1)
      }
    }
  }
}

struct RGBStripes: View {
  var body: some View {
    Canvas { context, size in
      let colors: [Color] = [.red, .green, .blue, .cyan, .yellow, Color(red: 1, green: 0, blue: 1), .white, .black]
      let width = max(1, size.width / CGFloat(colors.count * 7))
      var x: CGFloat = 0
      var index = 0
      while x < size.width {
        context.fill(
          Path(CGRect(x: x, y: 0, width: width, height: size.height)),
          with: .color(colors[index % colors.count])
        )
        x += width
        index += 1
      }
    }
  }
}

struct LumaRamp: View {
  var body: some View {
    Rectangle()
      .fill(
        LinearGradient(
          stops: [
            .init(color: .black, location: 0),
            .init(color: .white, location: 0.36),
            .init(color: Color(white: 0.18), location: 0.5),
            .init(color: Color(white: 0.85), location: 0.72),
            .init(color: .black, location: 1)
          ],
          startPoint: .leading,
          endPoint: .trailing
        )
      )
  }
}

struct TextWeights: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      ForEach([12, 16, 22, 32, 44, 64], id: \.self) { size in
        HStack(spacing: 22) {
          Text("glass probe \(size)")
            .font(.system(size: CGFloat(size), weight: .regular))
          Text("GLASS PROBE \(size)")
            .font(.system(size: CGFloat(size), weight: .bold))
        }
      }
    }
    .foregroundStyle(.white)
    .padding(54)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
  }
}

struct CaretSelection: View {
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 54, style: .continuous)
        .fill(Color(white: 0.12))
        .frame(width: 1040, height: 122)
      HStack(spacing: 0) {
        Text("glass ")
          .foregroundStyle(.white)
        Text("bubble")
          .foregroundStyle(.white)
          .background(Color(red: 0.14, green: 0.43, blue: 0.88).opacity(0.86))
        Rectangle()
          .fill(Color(red: 0.25, green: 0.86, blue: 1.0))
          .frame(width: 4, height: 72)
          .padding(.leading, 3)
      }
      .font(.system(size: 54, weight: .regular))
      .frame(width: 960, alignment: .leading)
    }
  }
}

struct NativeTextSelection: View {
  var body: some View {
    GeometryReader { proxy in
      NativeTextSelectionTextView()
        .frame(
          width: min(proxy.size.width * 0.82, 1040),
          height: min(max(proxy.size.height * 0.14, 96), 132)
        )
        .position(x: proxy.size.width * 0.5, y: proxy.size.height * 0.56)
    }
  }
}

struct NativeTextSelectionTextView: UIViewRepresentable {
  func makeUIView(context: Context) -> UITextView {
    let textView = UITextView()
    textView.text = "glass bubble"
    textView.font = .systemFont(ofSize: 54, weight: .regular)
    textView.textColor = .white
    textView.backgroundColor = UIColor(white: 0.12, alpha: 1)
    textView.tintColor = UIColor(red: 0.25, green: 0.86, blue: 1.0, alpha: 1)
    textView.isEditable = true
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.autocorrectionType = .no
    textView.spellCheckingType = .no
    textView.smartQuotesType = .no
    textView.inputView = UIView(frame: .zero)
    textView.textContainerInset = UIEdgeInsets(top: 30, left: 38, bottom: 20, right: 38)
    textView.textContainer.lineFragmentPadding = 0
    textView.layer.cornerRadius = 54
    textView.layer.cornerCurve = .continuous
    textView.clipsToBounds = true

    DispatchQueue.main.async {
      focusAndSelect(textView)
    }

    return textView
  }

  func updateUIView(_ textView: UITextView, context: Context) {
    DispatchQueue.main.async {
      focusAndSelect(textView)
    }
  }

  private func focusAndSelect(_ textView: UITextView) {
    guard textView.window != nil else {
      return
    }

    if !textView.isFirstResponder {
      textView.becomeFirstResponder()
    }

    if let range = textView.text.range(of: "bubble") {
      let location = textView.text.distance(from: textView.text.startIndex, to: range.lowerBound)
      let length = textView.text.distance(from: range.lowerBound, to: range.upperBound)
      textView.selectedRange = NSRange(location: location, length: length)
    }
  }
}

private func roundedPath(_ rect: CGRect, radius: CGFloat) -> Path {
  var path = Path()
  path.addRoundedRect(in: rect, cornerSize: CGSize(width: radius, height: radius))
  return path
}

struct LoupeText: View {
  var body: some View {
    ZStack {
      LinearGradient(
        stops: [
          .init(color: Color(white: 0.04), location: 0),
          .init(color: Color(white: 0.12), location: 0.48),
          .init(color: Color(white: 0.02), location: 1)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      VStack(alignment: .leading, spacing: 10) {
        Text("liquid glass measures the air between letters")
          .font(.system(size: 38, weight: .regular))
        Text("drag vector / selection handle / magnified baseline")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(Color(red: 0.58, green: 0.82, blue: 1.0))
        Text("No single frame is enough. The lens has to stay truthful while the text moves.")
          .font(.system(size: 20, weight: .regular))
          .foregroundStyle(.white.opacity(0.72))
      }
      .foregroundStyle(.white)
      .padding(42)
      .frame(maxWidth: 980, alignment: .leading)
      .background(Color(white: 0.08), in: RoundedRectangle(cornerRadius: 30, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 30, style: .continuous)
          .stroke(Color.white.opacity(0.12), lineWidth: 1)
      )
    }
  }
}

struct FloatingBarContent: View {
  var body: some View {
    GeometryReader { proxy in
      ZStack {
        LinearGradient(
          colors: [
            Color(red: 0.02, green: 0.05, blue: 0.08),
            Color(red: 0.08, green: 0.12, blue: 0.12),
            Color(red: 0.01, green: 0.02, blue: 0.03)
          ],
          startPoint: .top,
          endPoint: .bottom
        )
        VStack(spacing: 18) {
          ForEach(0..<6, id: \.self) { index in
            RoundedRectangle(cornerRadius: 24, style: .continuous)
              .fill(index.isMultiple(of: 2) ? Color(white: 0.16) : Color(white: 0.10))
              .overlay(alignment: .leading) {
                HStack(spacing: 18) {
                  Circle()
                    .fill(Color(hue: Double(index) / 7.0, saturation: 0.68, brightness: 0.92))
                    .frame(width: 46, height: 46)
                  VStack(alignment: .leading, spacing: 8) {
                    Capsule().fill(.white.opacity(0.72)).frame(width: 220, height: 9)
                    Capsule().fill(.white.opacity(0.26)).frame(width: 420, height: 7)
                  }
                }
                .padding(.horizontal, 22)
              }
              .frame(height: 86)
          }
        }
        .padding(.horizontal, min(proxy.size.width * 0.08, 80))
      }
    }
  }
}

struct TinyControlContent: View {
  var body: some View {
    ZStack {
      Color(white: 0.045)
      VStack(spacing: 24) {
        ForEach(0..<4, id: \.self) { row in
          HStack(spacing: 18) {
            ForEach(0..<5, id: \.self) { col in
              let active = (row + col).isMultiple(of: 3)
              RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(active ? Color(red: 0.20, green: 0.70, blue: 0.95) : Color(white: 0.17))
                .frame(width: 70, height: 48)
                .overlay(
                  RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(.white.opacity(active ? 0.42 : 0.12), lineWidth: 1)
                )
            }
          }
        }
      }
    }
  }
}

struct BusyPhotoSubstrate: View {
  var body: some View {
    Canvas { context, size in
      let background = GraphicsContext.Shading.linearGradient(
        Gradient(colors: [
          Color(red: 0.03, green: 0.06, blue: 0.08),
          Color(red: 0.22, green: 0.28, blue: 0.20),
          Color(red: 0.06, green: 0.05, blue: 0.08)
        ]),
        startPoint: .zero,
        endPoint: CGPoint(x: size.width, y: size.height)
      )
      context.fill(Path(CGRect(origin: .zero, size: size)), with: background)

      for index in 0..<72 {
        let f = CGFloat(index)
        let x = size.width * CGFloat((index * 37 % 100)) / 100.0
        let y = size.height * CGFloat((index * 61 % 100)) / 100.0
        let w = size.width * (0.05 + CGFloat(index % 7) * 0.012)
        let h = size.height * (0.035 + CGFloat(index % 5) * 0.011)
        let hue = Double((index * 19) % 100) / 100.0
        let rect = CGRect(x: x - w * 0.5, y: y - h * 0.5, width: w, height: h)
        context.fill(
          roundedPath(rect, radius: min(w, h) * 0.34),
          with: .color(Color(hue: hue, saturation: 0.48 + Double(index % 4) * 0.09, brightness: 0.44 + Double(index % 5) * 0.08).opacity(0.72))
        )
        if index.isMultiple(of: 4) {
          context.stroke(
            Path(ellipseIn: CGRect(x: x + f.truncatingRemainder(dividingBy: 11) - 18, y: y - 18, width: 36, height: 36)),
            with: .color(.white.opacity(0.18)),
            lineWidth: 1.2
          )
        }
      }
    }
  }
}

struct P3SaturatedGradient: View {
  var body: some View {
    Rectangle()
      .fill(
        LinearGradient(
          stops: [
            .init(color: Color(red: 1.0, green: 0.05, blue: 0.18), location: 0.0),
            .init(color: Color(red: 1.0, green: 0.72, blue: 0.0), location: 0.24),
            .init(color: Color(red: 0.0, green: 0.95, blue: 0.58), location: 0.50),
            .init(color: Color(red: 0.0, green: 0.38, blue: 1.0), location: 0.74),
            .init(color: Color(red: 0.92, green: 0.0, blue: 1.0), location: 1.0)
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
      )
  }
}

struct NearWhiteSubstrate: View {
  var body: some View {
    Canvas { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(white: 0.94)))
      for index in 0..<18 {
        let width = size.width * (0.16 + CGFloat(index % 5) * 0.035)
        let height = CGFloat(18 + (index % 4) * 7)
        let x = size.width * CGFloat((index * 29 % 100)) / 100.0
        let y = size.height * CGFloat((index * 47 % 100)) / 100.0
        let value = 0.82 + Double(index % 5) * 0.028
        context.fill(
          roundedPath(CGRect(x: x, y: y, width: width, height: height), radius: height * 0.5),
          with: .color(Color(white: value).opacity(0.82))
        )
      }
    }
  }
}

struct NearBlackSubstrate: View {
  var body: some View {
    Canvas { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(white: 0.015)))
      for index in 0..<42 {
        let x = size.width * CGFloat((index * 17 % 100)) / 100.0
        let y = size.height * CGFloat((index * 43 % 100)) / 100.0
        let radius = CGFloat(2 + (index % 7))
        context.fill(
          Path(ellipseIn: CGRect(x: x, y: y, width: radius * 2, height: radius * 2)),
          with: .color(Color(white: 0.10 + Double(index % 6) * 0.025).opacity(0.86))
        )
      }
      var horizon = Path()
      horizon.move(to: CGPoint(x: 0, y: size.height * 0.63))
      horizon.addLine(to: CGPoint(x: size.width, y: size.height * 0.57))
      context.stroke(horizon, with: .color(.white.opacity(0.10)), lineWidth: 2)
    }
  }
}

struct VideoFrameSubstrate: View {
  var body: some View {
    Canvas { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
      let stripeW = max(2, size.width / 120)
      var x: CGFloat = 0
      var index = 0
      while x < size.width {
        let hue = Double((index * 13) % 100) / 100.0
        let brightness = 0.18 + Double(index % 9) * 0.075
        context.fill(
          Path(CGRect(x: x, y: 0, width: stripeW + 1, height: size.height)),
          with: .color(Color(hue: hue, saturation: 0.72, brightness: brightness))
        )
        x += stripeW
        index += 1
      }
      for row in 0..<18 {
        let y = size.height * CGFloat(row) / 18.0
        context.fill(
          Path(CGRect(x: 0, y: y, width: size.width, height: 1)),
          with: .color(.white.opacity(row.isMultiple(of: 3) ? 0.30 : 0.09))
        )
      }
    }
  }
}

struct SystemMaterialAdjacencySubstrate: View {
  var body: some View {
    ZStack {
      LinearGradient(
        colors: [
          Color(red: 0.02, green: 0.03, blue: 0.05),
          Color(red: 0.10, green: 0.10, blue: 0.12),
          Color(red: 0.03, green: 0.02, blue: 0.04)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      HStack(spacing: 22) {
        ForEach(0..<3, id: \.self) { index in
          VStack(alignment: .leading, spacing: 18) {
            Capsule().fill(.white.opacity(0.68)).frame(width: CGFloat(130 + index * 32), height: 10)
            RoundedRectangle(cornerRadius: 26, style: .continuous)
              .fill(.ultraThinMaterial)
              .frame(width: 230, height: CGFloat(130 + index * 26))
              .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                  .stroke(.white.opacity(0.18), lineWidth: 1)
              )
            Capsule().fill(.white.opacity(0.18)).frame(width: 180, height: 8)
          }
          .padding(26)
          .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 34, style: .continuous))
        }
      }
    }
  }
}

struct NoiseSubstrate: View {
  var body: some View {
    Canvas { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
      let cols = 96
      let rows = 54
      let cellW = size.width / CGFloat(cols)
      let cellH = size.height / CGFloat(rows)
      for y in 0..<rows {
        for x in 0..<cols {
          let seed = Double((x * 73856093) ^ (y * 19349663) & 255) / 255.0
          let color = Color(
            red: 0.06 + seed * 0.74,
            green: 0.08 + abs(sin(seed * 7.1)) * 0.62,
            blue: 0.08 + abs(cos(seed * 4.7)) * 0.82
          )
          context.fill(
            Path(CGRect(x: CGFloat(x) * cellW, y: CGFloat(y) * cellH, width: cellW + 1, height: cellH + 1)),
            with: .color(color)
          )
        }
      }
    }
  }
}

struct NativeGlassLayer: View {
  @ObservedObject var model: NativeHarnessModel
  let time: TimeInterval
  let size: CGSize

  var body: some View {
    let metrics = ProbeMetrics(model: model, time: time, stage: size)
    ZStack {
      switch model.shape {
      case .circle:
        singleGlass(frame: metrics.circleFrame, shape: .circle, cornerRadius: metrics.circleFrame.width * 0.5)
      case .capsule:
        singleGlass(frame: metrics.capsuleFrame, shape: .capsule, cornerRadius: metrics.capsuleFrame.height * 0.5)
      case .roundedRect:
        singleGlass(frame: metrics.rectFrame, shape: .roundedRect, cornerRadius: metrics.cornerRadius)
      case .twinCapsules:
        twinGlass(metrics: metrics)
      }
    }
    .animation(.smooth(duration: 0.42), value: model.phase)
    .animation(.smooth(duration: 0.42), value: model.shape)
  }

  @ViewBuilder
  private func singleGlass(frame: CGRect, shape: ProbeShape, cornerRadius: CGFloat) -> some View {
    let payload = Color.white.opacity(0.001)
      .frame(width: frame.width, height: frame.height)

    if #available(iOS 26.0, *) {
      switch shape {
      case .circle:
        payload.glassEffect(glassStyle, in: Circle())
          .position(x: frame.midX, y: frame.midY)
      case .capsule:
        payload.glassEffect(glassStyle, in: Capsule())
          .position(x: frame.midX, y: frame.midY)
      default:
        payload.glassEffect(glassStyle, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
          .position(x: frame.midX, y: frame.midY)
      }
    } else {
      payload
        .background(.white.opacity(0.10), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).stroke(.white.opacity(0.22), lineWidth: 1))
        .position(x: frame.midX, y: frame.midY)
    }
  }

  @ViewBuilder
  private func twinGlass(metrics: ProbeMetrics) -> some View {
    if #available(iOS 26.0, *) {
      GlassEffectContainer(spacing: metrics.containerSpacing) {
        HStack(spacing: metrics.twinSpacing) {
          Color.white.opacity(0.001)
            .frame(width: metrics.twinSize.width, height: metrics.twinSize.height)
            .glassEffect(glassStyle, in: Capsule())
          Color.white.opacity(0.001)
            .frame(width: metrics.twinSize.width, height: metrics.twinSize.height)
            .glassEffect(glassStyle, in: Capsule())
        }
      }
      .position(x: metrics.center.x, y: metrics.center.y)
    } else {
      HStack(spacing: metrics.twinSpacing) {
        Capsule().fill(.white.opacity(0.12)).frame(width: metrics.twinSize.width, height: metrics.twinSize.height)
        Capsule().fill(.white.opacity(0.12)).frame(width: metrics.twinSize.width, height: metrics.twinSize.height)
      }
      .position(x: metrics.center.x, y: metrics.center.y)
    }
  }

  @available(iOS 26.0, *)
  private var glassStyle: Glass {
    var glass: Glass = .regular
    switch model.tint {
    case .none:
      break
    case .cyan:
      glass = glass.tint(.cyan.opacity(0.32))
    case .amber:
      glass = glass.tint(.orange.opacity(0.34))
    case .red:
      glass = glass.tint(.red.opacity(0.30))
    }
    return model.interactive ? glass.interactive() : glass
  }
}

struct ProbeMetrics {
  let center: CGPoint
  let circleFrame: CGRect
  let capsuleFrame: CGRect
  let rectFrame: CGRect
  let cornerRadius: CGFloat
  let twinSize: CGSize
  let twinSpacing: CGFloat
  let containerSpacing: CGFloat

  init(model: NativeHarnessModel, time: TimeInterval, stage: CGSize) {
    let animated = model.autoplay ? CGFloat((sin(time * 1.7) + 1) * 0.5) : 0
    let width = max(1, stage.width)
    let height = max(1, stage.height)
    var cx = width * 0.5
    var cy = height * 0.56
    var squashX: CGFloat = 1
    var squashY: CGFloat = 1
    var scale: CGFloat = 1

    switch model.phase {
    case .rest:
      break
    case .press:
      squashX = 1.12 + animated * 0.06
      squashY = 0.88 - animated * 0.04
    case .dragLeft:
      cx -= width * (0.16 + animated * 0.04)
    case .dragRight:
      cx += width * (0.16 + animated * 0.04)
    case .mergeNear:
      scale = 0.98
    case .mergeOverlap:
      scale = 1.04
      squashX = 1.08
    case .morphTall:
      squashX = 0.76
      squashY = 1.24
      cy -= height * 0.05
    }

    center = CGPoint(x: cx, y: cy)
    let capsuleW = min(width * 0.70, 820) * scale * squashX
    let capsuleH = min(max(height * 0.12, 74), 120) * scale * squashY
    capsuleFrame = CGRect(x: cx - capsuleW * 0.5, y: cy - capsuleH * 0.5, width: capsuleW, height: capsuleH)

    let circleD = min(width, height) * 0.26 * scale * max(squashX, squashY)
    circleFrame = CGRect(x: cx - circleD * 0.5, y: cy - circleD * 0.5, width: circleD, height: circleD)

    let rectW = min(width * 0.48, 560) * scale * squashX
    let rectH = min(max(height * 0.24, 140), 230) * scale * squashY
    rectFrame = CGRect(x: cx - rectW * 0.5, y: cy - rectH * 0.5, width: rectW, height: rectH)
    cornerRadius = rectH * 0.22

    twinSize = CGSize(width: min(width * 0.20, 220) * scale, height: min(max(height * 0.11, 64), 96) * scale)
    switch model.phase {
    case .mergeNear:
      twinSpacing = 26 + animated * 12
      containerSpacing = 40
    case .mergeOverlap:
      twinSpacing = -18 - animated * 18
      containerSpacing = 84
    default:
      twinSpacing = 72 + animated * 18
      containerSpacing = 18
    }
  }
}
