import Foundation

enum JSONValueSanitizer {
  static func data(withJSONObject value: Any, options: JSONSerialization.WritingOptions) throws -> Data {
    try JSONSerialization.data(withJSONObject: sanitize(value), options: options)
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
}
