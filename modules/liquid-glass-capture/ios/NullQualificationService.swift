import CoreGraphics
import CryptoKit
import ImageIO
import UIKit

final class NullQualificationService {
  func run(referenceArtifactPath: String, candidateArtifactPath: String, rung: String?) throws -> [String: Any] {
    let referenceURL = URL(fileURLWithPath: referenceArtifactPath)
    let candidateURL = URL(fileURLWithPath: candidateArtifactPath)
    let referenceArtifact = try Self.readJSON(referenceURL)
    let candidateArtifact = try Self.readJSON(candidateURL)

    let referenceGate = try Self.validateArtifact(role: "reference", artifact: referenceArtifact, artifactURL: referenceURL)
    let candidateGate = try Self.validateArtifact(role: "candidate", artifact: candidateArtifact, artifactURL: candidateURL)

    guard let referenceFrame = referenceGate.basePNGPath,
          let candidateFrame = candidateGate.basePNGPath else {
      throw Self.error("Both artifacts must contain frame_pack.base_png_path")
    }

    let rungId = rung ?? Self.rungId(from: candidateArtifact)
    let threshold = Self.threshold(for: rungId)
    let metrics = try Self.compare(referencePath: referenceFrame, candidatePath: candidateFrame)
    let nullFailures = Self.thresholdFailures(metrics: metrics, threshold: threshold)
    let colorFailures = Self.colorFailures(metrics: metrics)
    let allFailures = referenceGate.failures + candidateGate.failures + colorFailures + nullFailures
    let pass = allFailures.isEmpty

    let reportDir = try FileManager.default
      .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("LiquidGlassCaptures", isDirectory: true)
      .appendingPathComponent("NullReports", isDirectory: true)
    try FileManager.default.createDirectory(at: reportDir, withIntermediateDirectories: true)

    let stamp = Int(Date().timeIntervalSince1970 * 1000)
    let reportURL = reportDir.appendingPathComponent("\(stamp)-\(rungId)-null-report.json")

    var report: [String: Any] = [
      "schema_version": "1.2.0",
      "kind": "null_ladder_report",
      "report_id": "\(stamp)-\(rungId)",
      "scene_id": "S00_NULL",
      "rung_id": rungId,
      "reference_artifact": referenceArtifactPath,
      "candidate_artifact": candidateArtifactPath,
      "reference_rig": referenceArtifact["rig_id"] as? String ?? "unknown",
      "candidate_rig": candidateArtifact["rig_id"] as? String ?? "unknown",
      "reference_png": referenceFrame,
      "candidate_png": candidateFrame,
      "threshold": threshold.asDictionary,
      "metrics": metrics.asDictionary,
      "null_qualification": pass ? "pass" : "fail",
      "failures": allFailures,
      "gates": [
        "G0": [
          "status": referenceGate.failures.isEmpty && candidateGate.failures.isEmpty ? "pass" : "fail",
          "reference": referenceGate.asDictionary,
          "candidate": candidateGate.asDictionary
        ],
        "G1": [
          "status": colorFailures.isEmpty ? "pass" : "fail",
          "failures": colorFailures
        ]
      ],
      "color_pipeline": [
        "status": colorFailures.isEmpty ? "PASS" : "FAIL",
        "decoder": "CGImageSource + CGContext Display-P3 RGBA8",
        "working_space": "display-p3-linear",
        "stored_transfer": "srgb-transfer",
        "comparison_space": "OKLab",
        "note": "PNG is decoded through ImageIO and drawn into Display-P3; encoded P3 components are linearized with the sRGB transfer curve before OKLab conversion."
      ],
      "integrity": [
        "reference_artifact_sha256": try Self.sha256File(referenceURL),
        "candidate_artifact_sha256": try Self.sha256File(candidateURL),
        "producer_version": "NullQualificationService.v2"
      ]
    ]

    var jsonData = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    var integrity = report["integrity"] as? [String: Any] ?? [:]
    integrity["report_sha256"] = Self.sha256Hex(jsonData)
    report["integrity"] = integrity
    jsonData = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try jsonData.write(to: reportURL, options: .atomic)

    report["jsonPath"] = reportURL.path
    return report
  }

  private static func readJSON(_ url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw error("Could not parse JSON object at \(url.path)")
    }
    return object
  }

  private static func validateArtifact(role: String, artifact: [String: Any], artifactURL: URL) throws -> ArtifactGate {
    var failures: [String] = []

    if artifact["schema_version"] as? String != "1.2.0" {
      failures.append("\(role).G0_SCHEMA_VERSION")
    }
    if artifact["capture_kind"] as? String == "layer_snapshot" {
      failures.append("\(role).G0_LAYER_SNAPSHOT_INVALID")
    }

    if let device = artifact["device_info"] as? [String: Any] {
      if (device["model_identifier"] as? String ?? "").isEmpty {
        failures.append("\(role).G0_MISSING_DEVICE_ID")
      }
      if let model = device["model_identifier"] as? String,
         model.lowercased().contains("simulator") {
        failures.append("\(role).G0_SIMULATOR_INVALID")
      }
    } else {
      failures.append("\(role).G0_MISSING_DEVICE_INFO")
    }

    if let color = artifact["color"] as? [String: Any] {
      if color["embedded_icc_profile"] as? String != "Display P3" {
        failures.append("\(role).G0_MISSING_DISPLAY_P3_ICC")
      }
      let icc = color["icc_sha256"] as? String ?? ""
      if icc.isEmpty || icc.contains("unverified") || icc.contains("missing") {
        failures.append("\(role).G0_INVALID_ICC_SHA256")
      }
      if color["working_space"] as? String != "display-p3-linear" {
        failures.append("\(role).G1_WORKING_SPACE_NOT_DISPLAY_P3_LINEAR")
      }
      if color["stored_transfer"] as? String != "srgb-transfer" {
        failures.append("\(role).G1_STORED_TRANSFER_NOT_SRGB")
      }
      if color["white_point"] as? String != "D65" {
        failures.append("\(role).G1_WHITE_POINT_NOT_D65")
      }
    } else {
      failures.append("\(role).G0_MISSING_COLOR_BLOCK")
    }

    let artifactDir = artifactURL.deletingLastPathComponent()
    let framePack = artifact["frame_pack"] as? [String: Any]
    let basePath = framePack?["base_png_path"] as? String
    let maskPath = framePack?["mask_pack_path"] as? String
    let resolvedBasePath = basePath.map { resolve(path: $0, relativeTo: artifactDir).path }
    let resolvedMaskPath = maskPath.map { resolve(path: $0, relativeTo: artifactDir).path }

    if let resolvedBasePath,
       let expected = framePack?["base_png_sha256"] as? String {
      let actual = try sha256File(URL(fileURLWithPath: resolvedBasePath))
      if actual.lowercased() != expected.lowercased() {
        failures.append("\(role).G0_BASE_PNG_HASH_MISMATCH")
      }
    } else {
      failures.append("\(role).G0_MISSING_BASE_PNG")
    }

    if let resolvedMaskPath,
       let expected = framePack?["mask_pack_sha256"] as? String {
      let actual = try sha256File(URL(fileURLWithPath: resolvedMaskPath))
      if actual.lowercased() != expected.lowercased() {
        failures.append("\(role).G0_MASK_PACK_HASH_MISMATCH")
      }
    } else {
      failures.append("\(role).G0_MISSING_MASK_PACK")
    }

    if let sequencePaths = framePack?["sequence_paths"] as? [String] {
      for path in sequencePaths.prefix(8) {
        if !FileManager.default.fileExists(atPath: resolve(path: path, relativeTo: artifactDir).path) {
          failures.append("\(role).G0_SEQUENCE_FRAME_MISSING")
          break
        }
      }
    }

    return ArtifactGate(
      role: role,
      basePNGPath: resolvedBasePath,
      maskPackPath: resolvedMaskPath,
      failures: failures
    )
  }

  private static func resolve(path: String, relativeTo directory: URL) -> URL {
    let url = URL(fileURLWithPath: path)
    if path.hasPrefix("/") {
      return url
    }
    return directory.appendingPathComponent(path)
  }

  private static func rungId(from artifact: [String: Any]) -> String {
    switch artifact["state_id"] as? String {
    case "s00_flat_grey":
      return "flat_p3_grey"
    case "s00_hard_edge":
      return "hard_edge"
    case "s00_p3_ramp":
      return "p3_ramp"
    case "s00_smooth_gradient":
      return "smooth_gradient"
    default:
      return "flat_p3_grey"
    }
  }

  private static func threshold(for rungId: String) -> NullThreshold {
    switch rungId {
    case "flat_p3_grey", "hard_edge":
      return NullThreshold(maxAbsChannelDelta: 0, meanAbsChannelDelta: 0, gradientMeanAbsDelta: nil, oklabMeanDelta: 0)
    case "p3_ramp":
      return NullThreshold(maxAbsChannelDelta: 1, meanAbsChannelDelta: 0.25, gradientMeanAbsDelta: nil, oklabMeanDelta: 0.002)
    case "smooth_gradient":
      return NullThreshold(maxAbsChannelDelta: 2, meanAbsChannelDelta: 0.5, gradientMeanAbsDelta: 0.25, oklabMeanDelta: 0.003)
    default:
      return NullThreshold(maxAbsChannelDelta: 0, meanAbsChannelDelta: 0, gradientMeanAbsDelta: nil, oklabMeanDelta: 0)
    }
  }

  private static func thresholdFailures(metrics: NullMetrics, threshold: NullThreshold) -> [String] {
    var failures: [String] = []
    if metrics.dimensionMismatch {
      failures.append("NULL_DIMENSION_MISMATCH")
    }
    if metrics.maxAbsChannelDelta > threshold.maxAbsChannelDelta {
      failures.append("NULL_MAX_ABS_CHANNEL_DELTA>\(threshold.maxAbsChannelDelta)")
    }
    if metrics.meanAbsChannelDelta > threshold.meanAbsChannelDelta {
      failures.append("NULL_MEAN_ABS_CHANNEL_DELTA>\(threshold.meanAbsChannelDelta)")
    }
    if let gradientThreshold = threshold.gradientMeanAbsDelta,
       metrics.gradientMeanAbsDelta > gradientThreshold {
      failures.append("NULL_GRADIENT_MEAN_ABS_DELTA>\(gradientThreshold)")
    }
    if metrics.oklabMeanDelta > threshold.oklabMeanDelta {
      failures.append("NULL_OKLAB_MEAN_DELTA>\(threshold.oklabMeanDelta)")
    }
    return failures
  }

  private static func colorFailures(metrics: NullMetrics) -> [String] {
    var failures: [String] = []
    if !metrics.referenceProfile.isDisplayP3Tagged {
      failures.append("reference.G1_PNG_NOT_DISPLAY_P3_TAGGED")
    }
    if !metrics.candidateProfile.isDisplayP3Tagged {
      failures.append("candidate.G1_PNG_NOT_DISPLAY_P3_TAGGED")
    }
    return failures
  }

  private static func compare(referencePath: String, candidatePath: String) throws -> NullMetrics {
    let reference = try readPixels(path: referencePath)
    let candidate = try readPixels(path: candidatePath)

    if reference.width != candidate.width || reference.height != candidate.height {
      return NullMetrics(
        width: reference.width,
        height: reference.height,
        candidateWidth: candidate.width,
        candidateHeight: candidate.height,
        dimensionMismatch: true,
        maxAbsChannelDelta: Double.greatestFiniteMagnitude,
        meanAbsChannelDelta: Double.greatestFiniteMagnitude,
        gradientMeanAbsDelta: Double.greatestFiniteMagnitude,
        oklabMeanDelta: Double.greatestFiniteMagnitude,
        oklabMaxDelta: Double.greatestFiniteMagnitude,
        referenceProfile: reference.profile,
        candidateProfile: candidate.profile
      )
    }

    var maxAbs = 0.0
    var sumAbs = 0.0
    var sampleCount = 0.0
    var diffLuma = [Double](repeating: 0, count: reference.width * reference.height)
    var oklabSum = 0.0
    var oklabMax = 0.0

    for index in 0..<(reference.width * reference.height) {
      let offset = index * 4
      let redDelta = abs(Int(reference.pixels[offset]) - Int(candidate.pixels[offset]))
      let greenDelta = abs(Int(reference.pixels[offset + 1]) - Int(candidate.pixels[offset + 1]))
      let blueDelta = abs(Int(reference.pixels[offset + 2]) - Int(candidate.pixels[offset + 2]))

      maxAbs = max(maxAbs, Double(redDelta), Double(greenDelta), Double(blueDelta))
      sumAbs += Double(redDelta + greenDelta + blueDelta)
      sampleCount += 3

      let referenceLinear = linearP3(
        red: reference.pixels[offset],
        green: reference.pixels[offset + 1],
        blue: reference.pixels[offset + 2]
      )
      let candidateLinear = linearP3(
        red: candidate.pixels[offset],
        green: candidate.pixels[offset + 1],
        blue: candidate.pixels[offset + 2]
      )
      let referenceLab = oklabFromLinearP3(referenceLinear)
      let candidateLab = oklabFromLinearP3(candidateLinear)
      let oklabDelta = referenceLab.distance(to: candidateLab)
      oklabSum += oklabDelta
      oklabMax = max(oklabMax, oklabDelta)

      let referenceLuma = 0.2289745641 * referenceLinear.red + 0.6917385218 * referenceLinear.green + 0.0792869141 * referenceLinear.blue
      let candidateLuma = 0.2289745641 * candidateLinear.red + 0.6917385218 * candidateLinear.green + 0.0792869141 * candidateLinear.blue
      diffLuma[index] = abs(referenceLuma - candidateLuma) * 255
    }

    var gradientSum = 0.0
    var gradientCount = 0.0
    for y in 0..<reference.height {
      for x in 0..<reference.width {
        let index = y * reference.width + x
        if x + 1 < reference.width {
          gradientSum += abs(diffLuma[index] - diffLuma[index + 1])
          gradientCount += 1
        }
        if y + 1 < reference.height {
          gradientSum += abs(diffLuma[index] - diffLuma[index + reference.width])
          gradientCount += 1
        }
      }
    }

    let pixelCount = Double(reference.width * reference.height)
    return NullMetrics(
      width: reference.width,
      height: reference.height,
      candidateWidth: candidate.width,
      candidateHeight: candidate.height,
      dimensionMismatch: false,
      maxAbsChannelDelta: maxAbs,
      meanAbsChannelDelta: sampleCount == 0 ? 0 : sumAbs / sampleCount,
      gradientMeanAbsDelta: gradientCount == 0 ? 0 : gradientSum / gradientCount,
      oklabMeanDelta: pixelCount == 0 ? 0 : oklabSum / pixelCount,
      oklabMaxDelta: oklabMax,
      referenceProfile: reference.profile,
      candidateProfile: candidate.profile
    )
  }

  private static func readPixels(path: String) throws -> RGBAImage {
    let url = URL(fileURLWithPath: path)
    let data = try Data(contentsOf: url)
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
      throw error("Could not decode PNG at \(path)")
    }

    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
    let profileName = properties?[kCGImagePropertyProfileName as String] as? String
    let colorSpaceName = image.colorSpace?.name as String?

    let width = image.width
    let height = image.height
    let bytesPerPixel = 4
    let bytesPerRow = width * bytesPerPixel
    var pixels = [UInt8](repeating: 0, count: width * height * bytesPerPixel)

    guard let displayP3 = CGColorSpace(name: CGColorSpace.displayP3),
          let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: displayP3,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
          ) else {
      throw error("Could not allocate Display-P3 RGBA context for \(path)")
    }

    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return RGBAImage(
      width: width,
      height: height,
      pixels: pixels,
      profile: PNGProfile(
        profileName: profileName,
        colorSpaceName: colorSpaceName,
        sourceSha256: sha256Hex(data)
      )
    )
  }

  private static func linearP3(red: UInt8, green: UInt8, blue: UInt8) -> LinearP3 {
    LinearP3(
      red: srgbTransferToLinear(Double(red) / 255.0),
      green: srgbTransferToLinear(Double(green) / 255.0),
      blue: srgbTransferToLinear(Double(blue) / 255.0)
    )
  }

  private static func srgbTransferToLinear(_ value: Double) -> Double {
    if value <= 0.04045 {
      return value / 12.92
    }
    return pow((value + 0.055) / 1.055, 2.4)
  }

  private static func oklabFromLinearP3(_ color: LinearP3) -> OKLab {
    let x = 0.4865709486 * color.red + 0.2656676932 * color.green + 0.1982172852 * color.blue
    let y = 0.2289745641 * color.red + 0.6917385218 * color.green + 0.0792869141 * color.blue
    let z = 0.0451133819 * color.green + 1.0439443689 * color.blue

    let l = 0.8189330101 * x + 0.3618667424 * y - 0.1288597137 * z
    let m = 0.0329845436 * x + 0.9293118715 * y + 0.0361456387 * z
    let s = 0.0482003018 * x + 0.2643662691 * y + 0.6338517070 * z

    let lRoot = cbrt(max(0, l))
    let mRoot = cbrt(max(0, m))
    let sRoot = cbrt(max(0, s))

    return OKLab(
      lightness: 0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
      a: 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot,
      b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot
    )
  }

  private static func sha256File(_ url: URL) throws -> String {
    try sha256Hex(Data(contentsOf: url))
  }

  private static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func error(_ message: String) -> NSError {
    NSError(domain: "NullQualificationService", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

private struct ArtifactGate {
  let role: String
  let basePNGPath: String?
  let maskPackPath: String?
  let failures: [String]

  var asDictionary: [String: Any] {
    [
      "role": role,
      "status": failures.isEmpty ? "pass" : "fail",
      "base_png_path": basePNGPath ?? NSNull(),
      "mask_pack_path": maskPackPath ?? NSNull(),
      "failures": failures
    ]
  }
}

private struct RGBAImage {
  let width: Int
  let height: Int
  let pixels: [UInt8]
  let profile: PNGProfile
}

private struct PNGProfile {
  let profileName: String?
  let colorSpaceName: String?
  let sourceSha256: String

  var isDisplayP3Tagged: Bool {
    let combined = "\(profileName ?? "") \(colorSpaceName ?? "")".lowercased()
    return combined.contains("display p3") || combined.contains("display-p3") || combined.contains("displayp3")
  }

  var asDictionary: [String: Any] {
    [
      "profileName": profileName ?? NSNull(),
      "colorSpaceName": colorSpaceName ?? NSNull(),
      "sourceSha256": sourceSha256,
      "isDisplayP3Tagged": isDisplayP3Tagged
    ]
  }
}

private struct LinearP3 {
  let red: Double
  let green: Double
  let blue: Double
}

private struct OKLab {
  let lightness: Double
  let a: Double
  let b: Double

  func distance(to other: OKLab) -> Double {
    let dl = lightness - other.lightness
    let da = a - other.a
    let db = b - other.b
    return sqrt(dl * dl + da * da + db * db)
  }
}

private struct NullThreshold {
  let maxAbsChannelDelta: Double
  let meanAbsChannelDelta: Double
  let gradientMeanAbsDelta: Double?
  let oklabMeanDelta: Double

  var asDictionary: [String: Any] {
    var payload: [String: Any] = [
      "maxAbsChannelDelta": maxAbsChannelDelta,
      "meanAbsChannelDelta": meanAbsChannelDelta,
      "oklabMeanDelta": oklabMeanDelta
    ]
    if let gradientMeanAbsDelta {
      payload["gradientMeanAbsDelta"] = gradientMeanAbsDelta
    }
    return payload
  }
}

private struct NullMetrics {
  let width: Int
  let height: Int
  let candidateWidth: Int
  let candidateHeight: Int
  let dimensionMismatch: Bool
  let maxAbsChannelDelta: Double
  let meanAbsChannelDelta: Double
  let gradientMeanAbsDelta: Double
  let oklabMeanDelta: Double
  let oklabMaxDelta: Double
  let referenceProfile: PNGProfile
  let candidateProfile: PNGProfile

  var asDictionary: [String: Any] {
    [
      "width": width,
      "height": height,
      "candidateWidth": candidateWidth,
      "candidateHeight": candidateHeight,
      "dimensionMismatch": dimensionMismatch,
      "maxAbsChannelDelta": maxAbsChannelDelta,
      "meanAbsChannelDelta": meanAbsChannelDelta,
      "gradientMeanAbsDelta": gradientMeanAbsDelta,
      "oklabMeanDelta": oklabMeanDelta,
      "oklabMaxDelta": oklabMaxDelta,
      "referenceProfile": referenceProfile.asDictionary,
      "candidateProfile": candidateProfile.asDictionary
    ]
  }
}
