// hCaptcha-SDK token minter, packaged inside the (unchanged) "LiquidGlassCapture" Expo module so the
// existing no-Mac build vehicle (GitHub Actions unsigned IPA -> sideload) keeps working untouched —
// only the module's behaviour is swapped. Runs the OFFICIAL hCaptcha iOS SDK in a loop for EL's
// sitekey and posts each genuine SDK-context token to the desktop oracle's /collect. That SDK
// context is the gate: every token minted from Safari / Chrome-WKWebView / standalone was silently
// rejected by EL's siteverify; only the in-app SDK solve is accepted.
import ExpoModulesCore
import HCaptcha
import UIKit

public final class LiquidGlassCaptureModule: Module {
  private var hcaptcha: HCaptcha?       // retained for the lifetime of a validate cycle (else it deallocs)
  private var minting = false
  private var sitekey = ""
  private var sdkHost = ""
  private var oracleUrl = ""
  private var telemetryUrl = ""          // oracleBase + "/telemetry": every event streams here so ONE /board shows all phones
  private var intervalMs = 8000
  private var minted = 0
  private var posted = 0
  private var runId = 0
  private var jitterPct: Double = 0      // 0..1 — randomises scheduling cadence (set live via updateConfig)

  // Resilience state — the serial solve loop must SURVIVE a WKWebView death, not just hope it doesn't happen.
  private var watchdog: DispatchWorkItem?   // reaps a solve that hangs with no callback (else the loop deadlocks)
  private var consecutiveFailures = 0        // streak of validate errors/timeouts -> triggers a webview rebuild
  private var healCount = 0                  // consecutive heals with no good mint between -> escalates backoff
  private let watchdogMs = 10000             // solves are bimodal (~2s success OR dead-hang); reap a hang FAST — 30s wasted nothing on a corpse
  private let healAfterFailures = 3          // this many failures in a row = the webview stack is wedged
  private let healBaseBackoffMs = 2000       // short — webviews die often here; a long pause after rebuild just wastes mint time
  private let healMaxBackoffMs = 8000        // cap short; frequent deaths need FAST recovery, not escalating 60s sit-outs

  public func definition() -> ModuleDefinition {
    Name("LiquidGlassCapture")

    Events("onToken", "onError", "onPosted", "onDiagnostic")

    AsyncFunction("startMinting") { (sitekey: String, oracleUrl: String, intervalMs: Int) in
      let cleanSitekey = sitekey.trimmingCharacters(in: .whitespacesAndNewlines)
      let cleanOracleUrl = oracleUrl.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !cleanSitekey.isEmpty else {
        self.emitError(stage: "start", error: "empty sitekey")
        return
      }
      guard URL(string: cleanOracleUrl) != nil else {
        self.emitError(stage: "start", error: "bad oracleUrl")
        return
      }
      guard !self.minting else {
        self.emitDiagnostic(stage: "start", message: "already minting", extra: ["run_id": self.runId])
        return
      }

      self.runId += 1
      self.sitekey = cleanSitekey
      self.sdkHost = Self.hcaptchaSDKHost(for: cleanSitekey)
      self.oracleUrl = cleanOracleUrl
      self.telemetryUrl = Self.telemetryEndpoint(from: cleanOracleUrl)
      self.intervalMs = max(2000, intervalMs)
      self.minted = 0
      self.posted = 0
      self.consecutiveFailures = 0
      self.healCount = 0
      self.watchdog?.cancel()
      self.watchdog = nil
      self.minting = true
      self.emitDiagnostic(stage: "start",
                          message: "minting loop started",
                          extra: ["run_id": self.runId,
                                  "host": self.sdkHost,
                                  "oracleUrl": self.oracleUrl,
                                  "intervalMs": self.intervalMs])
      self.mintOnce(runId: self.runId)
    }
    .runOnQueue(.main)

    Function("stopMinting") {
      self.minting = false
      self.runId += 1
      self.watchdog?.cancel()
      self.watchdog = nil
      self.hcaptcha?.stop()
      self.hcaptcha = nil
      self.emitDiagnostic(stage: "stop", message: "minting loop stopped", extra: ["run_id": self.runId])
    }

    Function("getStatus") { () -> [String: Any] in
      ["minting": self.minting, "minted": self.minted, "posted": self.posted,
       "sitekey": self.sitekey, "oracleUrl": self.oracleUrl, "host": self.sdkHost,
       "run_id": self.runId, "jitterPct": self.jitterPct, "device": Self.deviceId,
       "fails": self.consecutiveFailures, "heals": self.healCount]
    }

    // Live-tune the running loop (interval + cadence jitter) without a stop/start.
    AsyncFunction("updateConfig") { (intervalMs: Int, jitterPct: Double) in
      self.intervalMs = max(2000, intervalMs)
      self.jitterPct = max(0, min(1, jitterPct))
      self.emitDiagnostic(stage: "config",
                          message: "updated",
                          extra: ["intervalMs": self.intervalMs,
                                  "jitterPct": self.jitterPct,
                                  "run_id": self.runId])
    }
    .runOnQueue(.main)
  }

  // The solve loop is SERIAL — one HCaptcha/WKWebView at a time, the next scheduled only after the
  // current concludes. The proven 413-token primitive (makeCaptcha -> validate -> postToOracle) is
  // untouched; what's new is that the loop now SURVIVES a flaky WebView instead of stalling on one.
  // Three failure modes, three additive guards (they act only on the failing path, never the healthy
  // "ровно" cadence):
  //   - a solve that hangs with NO callback -> the watchdog stops it after watchdogMs and reschedules
  //     (else the serial loop deadlocks forever, since scheduleNext lives inside the callback);
  //   - a solve that errors fast -> counts toward consecutiveFailures;
  //   - the content process dies and every reload fails ("Could not load embedded HTML") -> after
  //     healAfterFailures in a row, healOrNext tears the SDK fully down and backs off (escalating up
  //     to healMaxBackoffMs) so WebKit can respawn a content process, instead of spin-failing dead.
  private func mintOnce(runId: Int) {
    guard minting, runId == self.runId else { return }
    guard let presenterView = keyWindowView() else {
      // No key window = app backgrounded, not a webview wedge — don't count it, just retry.
      emitError(stage: "presenter", error: "no active UIWindow/root view", extra: ["run_id": runId])
      return scheduleNext(runId: runId)
    }

    let captcha: HCaptcha
    do {
      captcha = try makeCaptcha()
    } catch {
      emitError(stage: "init", error: String(describing: error), extra: ["run_id": runId, "host": sdkHost])
      consecutiveFailures += 1
      return healOrNext(runId: runId)
    }
    hcaptcha = captcha

    // Exactly one conclusion per attempt — whichever of {callback, watchdog} fires first wins; the
    // other no-ops (main-queue serial, so the concluded flag needs no lock). conclude() is also the
    // sole place captcha.stop() runs, so a hung solve's webview is guaranteed freed within watchdogMs.
    var concluded = false
    let conclude: (Bool) -> Void = { [weak self] failed in
      guard let self else { return }
      if concluded { return }
      concluded = true
      self.watchdog?.cancel()
      self.watchdog = nil
      captcha.stop()
      if self.hcaptcha === captcha { self.hcaptcha = nil }
      if failed {
        self.consecutiveFailures += 1
      } else {
        self.consecutiveFailures = 0
        self.healCount = 0
      }
      self.healOrNext(runId: runId)
    }

    let wd = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.emitError(stage: "watchdog", error: "validate hung > \(self.watchdogMs)ms — reaping", extra: ["run_id": runId])
      conclude(true)
    }
    watchdog = wd
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(watchdogMs), execute: wd)

    captcha.onEvent { [weak self] event, payload in
      self?.emitDiagnostic(stage: "sdk",
                           message: String(describing: event),
                           extra: ["run_id": runId,
                                   "payload": String(describing: payload ?? "")])
    }

    emitDiagnostic(stage: "validate", message: "starting hCaptcha validate", extra: ["run_id": runId])
    captcha.validate(on: presenterView) { [weak self] result in
      guard let self else { return }
      guard self.minting, runId == self.runId else {
        captcha.stop()
        return
      }
      do {
        let token = try result.dematerialize()
        self.minted += 1
        self.emitEvent("onToken", ["len": token.count,
                                   "minted": self.minted,
                                   "head": String(token.prefix(16)),
                                   "run_id": runId])
        self.postToOracle(token, runId: runId)
        conclude(false)
      } catch {
        self.emitError(stage: "validate", error: String(describing: error), extra: ["run_id": runId])
        conclude(true)
      }
    }
  }

  private func scheduleNext(runId: Int? = nil) {
    let targetRunId = runId ?? self.runId
    guard minting, targetRunId == self.runId else { return }
    let delay = Self.jittered(intervalMs, pct: jitterPct)
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delay)) { [weak self] in
      guard let self, self.minting, targetRunId == self.runId else { return }
      self.mintOnce(runId: targetRunId)
    }
  }

  // After an attempt concludes: if the webview stack looks wedged (failure streak), tear the SDK fully
  // down and back off (escalating, capped) so WebKit can respawn a content process; else normal cadence.
  // This is what turns "stalls until a manual force-quit" into "recovers itself".
  private func healOrNext(runId: Int) {
    guard minting, runId == self.runId else { return }
    guard consecutiveFailures >= healAfterFailures else {
      return scheduleNext(runId: runId)
    }
    let failed = consecutiveFailures
    consecutiveFailures = 0
    healCount += 1
    watchdog?.cancel()
    watchdog = nil
    hcaptcha?.stop()
    hcaptcha = nil
    let backoff = min(healBaseBackoffMs << min(healCount - 1, 3), healMaxBackoffMs)
    emitDiagnostic(stage: "heal",
                   message: "webview wedged (\(failed) fails in a row) — full teardown, backoff \(backoff)ms",
                   extra: ["run_id": runId, "healCount": healCount, "backoffMs": backoff])
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(backoff)) { [weak self] in
      guard let self, self.minting, runId == self.runId else { return }
      self.mintOnce(runId: runId)
    }
  }

  // Cadence-only jitter (not security-sensitive): base +/- base*pct.
  private static func jittered(_ baseMs: Int, pct: Double) -> Int {
    guard pct > 0 else { return baseMs }
    let p = min(1.0, pct)
    let span = Double(baseMs) * p
    let r = Double.random(in: 0..<1)
    return max(0, Int((Double(baseMs) - span + r * 2 * span).rounded()))
  }

  // Stable per-device id (IDFV) so the oracle attributes tokens + health to THIS phone (H1/H2).
  // Was hardcoded "ios-sdk" — which made every device look like one, breaking per-device acceptance.
  private static let deviceId: String = UIDevice.current.identifierForVendor?.uuidString ?? "ios-unknown"

  private static func hcaptchaSDKHost(for sitekey: String) -> String {
    "\(sitekey).ios-sdk.hcaptcha.com"
  }

  private func makeCaptcha() throws -> HCaptcha {
    return try configuredCaptcha()
  }

  private func configuredCaptcha() throws -> HCaptcha {
    // sdkHost is always "<sitekey>.ios-sdk.hcaptcha.com", so the URL is well-formed.
    let baseURL = URL(string: "https://\(sdkHost)")!
    return try HCaptcha(apiKey: sitekey,
                        baseURL: baseURL,
                        size: .invisible,
                        sentry: false,
                        diagnosticLog: true)
  }

  private func keyWindowView() -> UIView? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    let window = windows.first { $0.isKeyWindow } ?? windows.first
    var controller = window?.rootViewController
    while let presented = controller?.presentedViewController {
      controller = presented
    }
    return controller?.view ?? window
  }

  private func postToOracle(_ token: String, runId: Int) {
    guard let url = URL(string: oracleUrl) else {
      return emitError(stage: "post", error: "bad oracleUrl", extra: ["run_id": runId])
    }
    var request = URLRequest(url: url, timeoutInterval: 15)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: [
        "token": token,
        "mint_id": Self.deviceId,
        "sitekey": sitekey,
        "host": sdkHost,
        "run_id": runId,
        "created_at_ms": Int(Date().timeIntervalSince1970 * 1000)
      ])
    } catch {
      return emitError(stage: "post", error: String(describing: error), extra: ["run_id": runId])
    }

    URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      guard let self else { return }
      let code = (response as? HTTPURLResponse)?.statusCode ?? -1
      let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      DispatchQueue.main.async { [weak self] in
        guard let self, runId == self.runId else { return }
        if error == nil, (200...299).contains(code) {
          self.posted += 1
        }
        self.emitEvent("onPosted", ["status": code,
                                    "posted": self.posted,
                                    "error": error?.localizedDescription ?? "",
                                    "body": String(body.prefix(160)),
                                    "run_id": runId])
      }
    }
    .resume()
  }

  private func emitError(stage: String, error: String, extra: [String: Any] = [:]) {
    var payload = extra
    payload["stage"] = stage
    payload["error"] = error
    emitEvent("onError", payload)
  }

  private func emitDiagnostic(stage: String, message: String, extra: [String: Any] = [:]) {
    var payload = extra
    payload["stage"] = stage
    payload["message"] = message
    emitEvent("onDiagnostic", payload)
  }

  private func emitEvent(_ event: String, _ payload: [String: Any]) {
    postTelemetry(line: Self.telemetryLine(event, payload))   // off-device stream -> one /board for every phone
    if Thread.isMainThread {
      sendEvent(event, payload)
    } else {
      DispatchQueue.main.async { [weak self] in
        self?.sendEvent(event, payload)
      }
    }
  }

  // ── off-device telemetry ──────────────────────────────────────────────────────────
  // Fire-and-forget: every cockpit event also streams to the oracle so a single desktop /board shows
  // what EVERY phone is doing live — no more screenshotting one device. Never blocks the mint loop.
  private static func telemetryEndpoint(from collectUrl: String) -> String {
    guard let u = URL(string: collectUrl), let scheme = u.scheme, let host = u.host else { return "" }
    let port = u.port.map { ":\($0)" } ?? ""
    return "\(scheme)://\(host)\(port)/telemetry"
  }

  private static func telemetryLine(_ event: String, _ p: [String: Any]) -> String {
    switch event {
    case "onToken":      return "token #\(p["minted"] ?? "?")  len=\(p["len"] ?? "?")"
    case "onPosted":     return "oracle \(p["status"] ?? "?")  (posted \(p["posted"] ?? "?"))"
    case "onError":      return "ERROR \(p["stage"] ?? "?"): \(p["error"] ?? "?")"
    case "onDiagnostic": return "diag \(p["stage"] ?? "?"): \(p["message"] ?? "?")"
    default:             return event
    }
  }

  private func postTelemetry(line: String) {
    guard !telemetryUrl.isEmpty, let url = URL(string: telemetryUrl) else { return }
    var request = URLRequest(url: url, timeoutInterval: 8)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: [
      "device": Self.deviceId,
      "line": line,
      "ts_ms": Int(Date().timeIntervalSince1970 * 1000)
    ])
    URLSession.shared.dataTask(with: request).resume()
  }
}
