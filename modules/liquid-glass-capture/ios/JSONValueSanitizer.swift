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
    if let value = value as? Bool {
      return value
    }
    if let value = value as? NSNumber {
      if CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() {
        return value.boolValue
      }
      return value.doubleValue.isFinite ? value : NSNull()
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
      if let value = value as? Bool {
        return value ? "true" : "false"
      }
      if let value = value as? NSNumber {
        if CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() {
          return value.boolValue ? "true" : "false"
        }
        return value.doubleValue.isFinite ? String(describing: value) : "null"
      }
      if let dictionary = JSONValueSanitizer.dictionaryEntries(value) {
        return renderObject(dictionary, depth: depth)
      }
      if let array = JSONValueSanitizer.arrayEntries(value) {
        return renderArray(array, depth: depth)
      }
      return quote(String(describing: value))
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
