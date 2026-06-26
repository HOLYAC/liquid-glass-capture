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
  private var intervalMs = 8000
  private var minted = 0
  private var posted = 0
  private var runId = 0

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
      self.intervalMs = max(2000, intervalMs)
      self.minted = 0
      self.posted = 0
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
      self.hcaptcha?.stop()
      self.hcaptcha = nil
      self.emitDiagnostic(stage: "stop", message: "minting loop stopped", extra: ["run_id": self.runId])
    }

    Function("getStatus") { () -> [String: Any] in
      ["minting": self.minting, "minted": self.minted, "posted": self.posted,
       "sitekey": self.sitekey, "oracleUrl": self.oracleUrl, "host": self.sdkHost,
       "run_id": self.runId]
    }
  }

  // One validate cycle on the key-window view; on completion post the token and schedule the next.
  private func mintOnce(runId: Int) {
    guard minting, runId == self.runId else { return }
    guard let presenterView = keyWindowView() else {
      emitError(stage: "presenter", error: "no active UIWindow/root view", extra: ["run_id": runId])
      return scheduleNext(runId: runId)
    }

    let captcha: HCaptcha
    do {
      captcha = try makeCaptcha()
    } catch {
      emitError(stage: "init", error: String(describing: error), extra: ["run_id": runId, "host": sdkHost])
      return scheduleNext(runId: runId)
    }
    hcaptcha = captcha

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
      } catch {
        self.emitError(stage: "validate", error: String(describing: error), extra: ["run_id": runId])
      }
      captcha.stop()
      if self.hcaptcha === captcha {
        self.hcaptcha = nil
      }
      self.scheduleNext(runId: runId)
    }
  }

  private func scheduleNext(runId: Int? = nil) {
    let targetRunId = runId ?? self.runId
    guard minting, targetRunId == self.runId else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(intervalMs)) { [weak self] in
      guard let self, self.minting, targetRunId == self.runId else { return }
      self.mintOnce(runId: targetRunId)
    }
  }

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
        "mint_id": "ios-sdk",
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
    if Thread.isMainThread {
      sendEvent(event, payload)
    } else {
      DispatchQueue.main.async { [weak self] in
        self?.sendEvent(event, payload)
      }
    }
  }
}
