import CoreGraphics
import Foundation

enum JSONValueSanitizer {
  static func data(withJSONObject value: Any, options: JSONSerialization.WritingOptions) throws -> Data {
    let json = JSONStringWriter(options: options).string(for: sanitize(value))
    return Data(json.utf8)
  }

  static func sanitize(_ value: Any) -> Any {
    let mirror = Mirror(reflecting: value)
    if mirror.displayStyle == .optional {
      guard let child = mirror.children.first else {
        return NSNull()
      }
      return sanitize(child.value)
    }

    if value is NSNull {
      return NSNull()
    }
    if let value = value as? String {
      return value
    }
    if let number = primitiveNumber(value) {
      return number
    }
    if let value = value as? NSNumber {
      if CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() {
        return value.boolValue
      }
      return value.doubleValue.isFinite ? value : NSNull()
    }
    if let value = value as? Bool {
      return value
    }
    if let value = value as? Date {
      return ISO8601DateFormatter().string(from: value)
    }
    if let value = value as? URL {
      return value.path
    }
    if let dictionary = dictionaryEntries(value) {
      var output: [String: Any] = [:]
      for (key, entryValue) in dictionary {
        output[key] = sanitize(entryValue)
      }
      return output
    }
    if let array = arrayEntries(value) {
      return array.map { sanitize($0) }
    }
    return String(describing: value)
  }

  private static func primitiveNumber(_ value: Any) -> Any? {
    switch value {
    case let value as Int:
      return value
    case let value as Int8:
      return value
    case let value as Int16:
      return value
    case let value as Int32:
      return value
    case let value as Int64:
      return value
    case let value as UInt:
      return value
    case let value as UInt8:
      return value
    case let value as UInt16:
      return value
    case let value as UInt32:
      return value
    case let value as UInt64:
      return value
    case let value as Double:
      return value.isFinite ? value : NSNull()
    case let value as Float:
      return value.isFinite ? value : NSNull()
    case let value as CGFloat:
      return value.isFinite ? Double(value) : NSNull()
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

  private struct JSONStringWriter {
    let prettyPrinted: Bool
    let sortedKeys: Bool

    init(options: JSONSerialization.WritingOptions) {
      prettyPrinted = options.contains(.prettyPrinted)
      sortedKeys = options.contains(.sortedKeys)
    }

    func string(for value: Any) -> String {
      render(value, depth: 0)
    }

    private func render(_ value: Any, depth: Int) -> String {
      let value = JSONValueSanitizer.sanitize(value)

      if value is NSNull {
        return "null"
      }
      if let value = value as? String {
        return quote(value)
      }
      if let number = numberString(value) {
        return number
      }
      if let value = value as? NSNumber {
        if CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() {
          return value.boolValue ? "true" : "false"
        }
        return value.doubleValue.isFinite ? String(describing: value) : "null"
      }
      if let value = value as? Bool {
        return value ? "true" : "false"
      }
      if let dictionary = JSONValueSanitizer.dictionaryEntries(value) {
        return renderObject(dictionary, depth: depth)
      }
      if let array = JSONValueSanitizer.arrayEntries(value) {
        return renderArray(array, depth: depth)
      }
      return quote(String(describing: value))
    }

    private func numberString(_ value: Any) -> String? {
      switch value {
      case let value as Int:
        return String(value)
      case let value as Int8:
        return String(value)
      case let value as Int16:
        return String(value)
      case let value as Int32:
        return String(value)
      case let value as Int64:
        return String(value)
      case let value as UInt:
        return String(value)
      case let value as UInt8:
        return String(value)
      case let value as UInt16:
        return String(value)
      case let value as UInt32:
        return String(value)
      case let value as UInt64:
        return String(value)
      case let value as Double:
        return value.isFinite ? String(value) : "null"
      case let value as Float:
        return value.isFinite ? String(value) : "null"
      case let value as CGFloat:
        return value.isFinite ? String(Double(value)) : "null"
      case let value as NSNumber:
        if CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() {
          return nil
        }
        return value.doubleValue.isFinite ? String(describing: value) : "null"
      default:
        return nil
      }
    }

    private func renderObject(_ entries: [(key: String, value: Any)], depth: Int) -> String {
      if entries.isEmpty {
        return "{}"
      }
      let ordered = sortedKeys ? entries.sorted { $0.key < $1.key } : entries
      if !prettyPrinted {
        let body = ordered
          .map { "\(quote($0.key)):\(render($0.value, depth: depth + 1))" }
          .joined(separator: ",")
        return "{\(body)}"
      }

      let childIndent = indent(depth + 1)
      let body = ordered
        .map { "\(childIndent)\(quote($0.key)): \(render($0.value, depth: depth + 1))" }
        .joined(separator: ",\n")
      return "{\n\(body)\n\(indent(depth))}"
    }

    private func renderArray(_ values: [Any], depth: Int) -> String {
      if values.isEmpty {
        return "[]"
      }
      if !prettyPrinted {
        return "[\(values.map { render($0, depth: depth + 1) }.joined(separator: ","))]"
      }

      let childIndent = indent(depth + 1)
      let body = values
        .map { "\(childIndent)\(render($0, depth: depth + 1))" }
        .joined(separator: ",\n")
      return "[\n\(body)\n\(indent(depth))]"
    }

    private func indent(_ depth: Int) -> String {
      String(repeating: "  ", count: depth)
    }

    private func quote(_ value: String) -> String {
      var output = "\""
      for scalar in value.unicodeScalars {
        switch scalar.value {
        case 0x22:
          output += "\\\""
        case 0x5C:
          output += "\\\\"
        case 0x08:
          output += "\\b"
        case 0x0C:
          output += "\\f"
        case 0x0A:
          output += "\\n"
        case 0x0D:
          output += "\\r"
        case 0x09:
          output += "\\t"
        case 0x00...0x1F:
          output += String(format: "\\u%04X", scalar.value)
        default:
          output.unicodeScalars.append(scalar)
        }
      }
      output += "\""
      return output
    }
  }
}
