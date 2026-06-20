import Foundation

enum CaptureDiagnostics {
  static func log(_ event: String, details: [String: Any] = [:]) {
    do {
      let fileManager = FileManager.default
      let diagnosticsDir = try fileManager
        .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("LiquidGlassCaptures", isDirectory: true)
        .appendingPathComponent("Diagnostics", isDirectory: true)
      try fileManager.createDirectory(at: diagnosticsDir, withIntermediateDirectories: true)

      let logURL = diagnosticsDir.appendingPathComponent("capture-events.log")
      let data = Data(line(event: event, details: details).utf8)
      if fileManager.fileExists(atPath: logURL.path) {
        let handle = try FileHandle(forWritingTo: logURL)
        defer { handle.closeFile() }
        handle.seekToEndOfFile()
        handle.write(data)
      } else {
        try data.write(to: logURL, options: .atomic)
      }
    } catch {
      // Diagnostics must never become a second crash surface.
    }
  }

  private static func line(event: String, details: [String: Any]) -> String {
    let timestampNs = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
    let body = details
      .sorted { $0.key < $1.key }
      .map { "\($0.key)=\(clean($0.value))" }
      .joined(separator: "\t")
    if body.isEmpty {
      return "\(timestampNs)\t\(clean(event))\n"
    }
    return "\(timestampNs)\t\(clean(event))\t\(body)\n"
  }

  private static func clean(_ value: Any) -> String {
    let text = String(describing: value)
      .replacingOccurrences(of: "\r", with: " ")
      .replacingOccurrences(of: "\n", with: " ")
      .replacingOccurrences(of: "\t", with: " ")
    return String(text.prefix(768))
  }
}
