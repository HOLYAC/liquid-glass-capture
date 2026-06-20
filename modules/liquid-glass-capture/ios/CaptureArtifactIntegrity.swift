import CryptoKit
import CoreGraphics
import Foundation

enum CaptureArtifactIntegrity {
  private static let hashMethod = "canonical_json_zeroed_integrity_v1"
  private static let zeroHash = String(repeating: "0", count: 64)

  static func finalizeArtifact(_ artifact: inout [String: Any]) throws {
    var integrity = artifact["integrity"] as? [String: Any] ?? [:]
    integrity["artifact_hash_method"] = hashMethod
    integrity["artifact_sha256"] = zeroHash
    artifact["integrity"] = integrity

    integrity["artifact_sha256"] = sha256Hex(try stableStringify(canonicalPayload(artifact)))
    artifact["integrity"] = integrity
  }

  private static func canonicalPayload(_ artifact: [String: Any]) -> [String: Any] {
    var payload = artifact
    var integrity = payload["integrity"] as? [String: Any] ?? [:]
    integrity["artifact_hash_method"] = hashMethod
    integrity["artifact_sha256"] = zeroHash
    payload["integrity"] = integrity
    return payload
  }

  private static func stableStringify(_ value: Any) throws -> String {
    if value is NSNull {
      return "null"
    }
    if let number = try primitiveNumberString(value) {
      return number
    }
    if let value = value as? String {
      return try jsonScalarString(value)
    }
    if let value = value as? NSString {
      return try jsonScalarString(value as String)
    }
    if let value = value as? NSNumber {
      if CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() {
        return value.boolValue ? "true" : "false"
      }
      if !value.doubleValue.isFinite {
        return "null"
      }
      return try jsonScalarString(value)
    }
    if let value = value as? Bool {
      return value ? "true" : "false"
    }
    if let dictionary = dictionaryEntries(value) {
      let parts = try dictionary
        .sorted { left, right in left.key < right.key }
        .map { key, entryValue in
          "\(try jsonScalarString(key)):\(try stableStringify(entryValue))"
        }
      return "{\(parts.joined(separator: ","))}"
    }
    if let array = arrayEntries(value) {
      return "[\(try array.map { try stableStringify($0) }.joined(separator: ","))]"
    }
    return try jsonScalarString(String(describing: value))
  }

  private static func primitiveNumberString(_ value: Any) throws -> String? {
    switch value {
    case let value as Int:
      return try jsonScalarString(value)
    case let value as Int8:
      return try jsonScalarString(value)
    case let value as Int16:
      return try jsonScalarString(value)
    case let value as Int32:
      return try jsonScalarString(value)
    case let value as Int64:
      return try jsonScalarString(value)
    case let value as UInt:
      return try jsonScalarString(value)
    case let value as UInt8:
      return try jsonScalarString(value)
    case let value as UInt16:
      return try jsonScalarString(value)
    case let value as UInt32:
      return try jsonScalarString(value)
    case let value as UInt64:
      return try jsonScalarString(value)
    case let value as Double:
      return value.isFinite ? try jsonScalarString(value) : "null"
    case let value as Float:
      return value.isFinite ? try jsonScalarString(value) : "null"
    case let value as CGFloat:
      return value.isFinite ? try jsonScalarString(Double(value)) : "null"
    default:
      return nil
    }
  }

  private static func dictionaryEntries(_ value: Any) -> [(key: String, value: Any)]? {
    if let dictionary = value as? [String: Any] {
      return dictionary.map { (key: $0.key, value: $0.value) }
    }
    if let dictionary = value as? NSDictionary {
      var entries: [(key: String, value: Any)] = []
      for rawKey in dictionary.allKeys {
        guard let key = rawKey as? String else {
          continue
        }
        entries.append((key: key, value: dictionary.object(forKey: rawKey) ?? NSNull()))
      }
      return entries
    }
    return nil
  }

  private static func arrayEntries(_ value: Any) -> [Any]? {
    if let array = value as? [Any] {
      return array
    }
    if let array = value as? NSArray {
      return array.map { $0 }
    }
    return nil
  }

  private static func jsonScalarString(_ value: Any) throws -> String {
    if let value = value as? String {
      return jsonString(value)
    }
    if let value = value as? NSString {
      return jsonString(value as String)
    }
    let data = try JSONSerialization.data(withJSONObject: [value], options: [])
    guard let json = String(data: data, encoding: .utf8), json.count >= 2 else {
      throw NSError(
        domain: "CaptureArtifactIntegrity",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Could not encode canonical JSON scalar"]
      )
    }
    return String(json.dropFirst().dropLast())
  }

  private static func jsonString(_ value: String) -> String {
    var result = "\""
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 0x08:
        result += "\\b"
      case 0x09:
        result += "\\t"
      case 0x0A:
        result += "\\n"
      case 0x0C:
        result += "\\f"
      case 0x0D:
        result += "\\r"
      case 0x22:
        result += "\\\""
      case 0x5C:
        result += "\\\\"
      case 0x00...0x1F:
        result += String(format: "\\u%04x", scalar.value)
      default:
        result.unicodeScalars.append(scalar)
      }
    }
    result += "\""
    return result
  }

  private static func sha256Hex(_ text: String) -> String {
    let data = Data(text.utf8)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
