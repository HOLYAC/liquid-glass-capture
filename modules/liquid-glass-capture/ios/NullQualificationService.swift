import CoreGraphics
import CryptoKit
import UIKit

final class NullQualificationService {
  func run(referenceArtifactPath: String, candidateArtifactPath: String, rung: String?) throws -> [String: Any] {
    let referenceURL = URL(fileURLWithPath: referenceArtifactPath)
    let candidateURL = URL(fileURLWithPath: candidateArtifactPath)
    let referenceArtifact = try Self.readJSON(referenceURL)
    let candidateArtifact = try Self.readJSON(candidateURL)

    guard let referenceFrame = Self.basePNGPath(referenceArtifact),
          let candidateFrame = Self.basePNGPath(candidateArtifact) else {
      throw Self.error("Both artifacts must contain frame_pack.base_png_path")
    }

    let rungId = rung ?? Self.rungId(from: candidateArtifact)
    let threshold = Self.threshold(for: rungId)
    let metrics = try Self.compare(referencePath: referenceFrame, candidatePath: candidateFrame)
    let failures = Self.failures(metrics: metrics, threshold: threshold)
    let pass = failures.isEmpty

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
      "failures": failures,
      "color_pipeline": [
        "status": "SMOKE_ONLY",
        "decoder": "UIImage+CGContext RGBA8",
        "note": "This qualifies the in-app S00 smoke path. Full G1 Display-P3 linear normalization remains a later gate."
      ],
      "integrity": [
        "reference_artifact_sha256": try Self.sha256File(referenceURL),
        "candidate_artifact_sha256": try Self.sha256File(candidateURL),
        "producer_version": "NullQualificationService.v1"
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

  private static func basePNGPath(_ artifact: [String: Any]) -> String? {
    guard let framePack = artifact["frame_pack"] as? [String: Any] else {
      return nil
    }
    return framePack["base_png_path"] as? String
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
      return NullThreshold(maxAbsChannelDelta: 0, meanAbsChannelDelta: 0, gradientMeanAbsDelta: nil)
    case "p3_ramp":
      return NullThreshold(maxAbsChannelDelta: 1, meanAbsChannelDelta: 0.25, gradientMeanAbsDelta: nil)
    case "smooth_gradient":
      return NullThreshold(maxAbsChannelDelta: 2, meanAbsChannelDelta: 0.5, gradientMeanAbsDelta: 0.25)
    default:
      return NullThreshold(maxAbsChannelDelta: 0, meanAbsChannelDelta: 0, gradientMeanAbsDelta: nil)
    }
  }

  private static func failures(metrics: NullMetrics, threshold: NullThreshold) -> [String] {
    var failures: [String] = []
    if metrics.dimensionMismatch {
      failures.append("DIMENSION_MISMATCH")
    }
    if metrics.maxAbsChannelDelta > threshold.maxAbsChannelDelta {
      failures.append("MAX_ABS_CHANNEL_DELTA>\(threshold.maxAbsChannelDelta)")
    }
    if metrics.meanAbsChannelDelta > threshold.meanAbsChannelDelta {
      failures.append("MEAN_ABS_CHANNEL_DELTA>\(threshold.meanAbsChannelDelta)")
    }
    if let gradientThreshold = threshold.gradientMeanAbsDelta,
       metrics.gradientMeanAbsDelta > gradientThreshold {
      failures.append("GRADIENT_MEAN_ABS_DELTA>\(gradientThreshold)")
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
        gradientMeanAbsDelta: Double.greatestFiniteMagnitude
      )
    }

    var maxAbs = 0.0
    var sumAbs = 0.0
    var sampleCount = 0.0
    var diffLuma = [Double](repeating: 0, count: reference.width * reference.height)

    for index in 0..<(reference.width * reference.height) {
      let offset = index * 4
      let redDelta = abs(Int(reference.pixels[offset]) - Int(candidate.pixels[offset]))
      let greenDelta = abs(Int(reference.pixels[offset + 1]) - Int(candidate.pixels[offset + 1]))
      let blueDelta = abs(Int(reference.pixels[offset + 2]) - Int(candidate.pixels[offset + 2]))

      maxAbs = max(maxAbs, Double(redDelta), Double(greenDelta), Double(blueDelta))
      sumAbs += Double(redDelta + greenDelta + blueDelta)
      sampleCount += 3

      let referenceLuma =
        0.2126 * Double(reference.pixels[offset])
        + 0.7152 * Double(reference.pixels[offset + 1])
        + 0.0722 * Double(reference.pixels[offset + 2])
      let candidateLuma =
        0.2126 * Double(candidate.pixels[offset])
        + 0.7152 * Double(candidate.pixels[offset + 1])
        + 0.0722 * Double(candidate.pixels[offset + 2])
      diffLuma[index] = abs(referenceLuma - candidateLuma)
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

    return NullMetrics(
      width: reference.width,
      height: reference.height,
      candidateWidth: candidate.width,
      candidateHeight: candidate.height,
      dimensionMismatch: false,
      maxAbsChannelDelta: maxAbs,
      meanAbsChannelDelta: sampleCount == 0 ? 0 : sumAbs / sampleCount,
      gradientMeanAbsDelta: gradientCount == 0 ? 0 : gradientSum / gradientCount
    )
  }

  private static func readPixels(path: String) throws -> RGBAImage {
    guard let image = UIImage(contentsOfFile: path)?.cgImage else {
      throw error("Could not decode PNG at \(path)")
    }

    let width = image.width
    let height = image.height
    let bytesPerPixel = 4
    let bytesPerRow = width * bytesPerPixel
    var pixels = [UInt8](repeating: 0, count: width * height * bytesPerPixel)

    guard let context = CGContext(
      data: &pixels,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
      throw error("Could not allocate RGBA context for \(path)")
    }

    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return RGBAImage(width: width, height: height, pixels: pixels)
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

private struct RGBAImage {
  let width: Int
  let height: Int
  let pixels: [UInt8]
}

private struct NullThreshold {
  let maxAbsChannelDelta: Double
  let meanAbsChannelDelta: Double
  let gradientMeanAbsDelta: Double?

  var asDictionary: [String: Any] {
    var payload: [String: Any] = [
      "maxAbsChannelDelta": maxAbsChannelDelta,
      "meanAbsChannelDelta": meanAbsChannelDelta
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

  var asDictionary: [String: Any] {
    [
      "width": width,
      "height": height,
      "candidateWidth": candidateWidth,
      "candidateHeight": candidateHeight,
      "dimensionMismatch": dimensionMismatch,
      "maxAbsChannelDelta": maxAbsChannelDelta,
      "meanAbsChannelDelta": meanAbsChannelDelta,
      "gradientMeanAbsDelta": gradientMeanAbsDelta
    ]
  }
}

