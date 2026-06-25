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
  private var oracleUrl = ""
  private var intervalMs = 8000
  private var minted = 0
  private var posted = 0

  public func definition() -> ModuleDefinition {
    Name("LiquidGlassCapture")

    Events("onToken", "onError", "onPosted")

    AsyncFunction("startMinting") { (sitekey: String, oracleUrl: String, intervalMs: Int) in
      self.sitekey = sitekey
      self.oracleUrl = oracleUrl
      self.intervalMs = max(2000, intervalMs)
      guard !self.minting else { return }
      self.minting = true
      self.mintOnce()
    }
    .runOnQueue(.main)

    Function("stopMinting") {
      self.minting = false
      self.hcaptcha?.stop()
    }

    Function("getStatus") { () -> [String: Any] in
      ["minting": self.minting, "minted": self.minted, "posted": self.posted,
       "sitekey": self.sitekey, "oracleUrl": self.oracleUrl]
    }
  }

  // One validate cycle on the key-window view; on completion post the token and schedule the next.
  private func mintOnce() {
    guard minting else { return }
    let captcha: HCaptcha
    do {
      captcha = try HCaptcha(apiKey: sitekey,
                             baseURL: URL(string: "https://\(sitekey).ios-sdk.hcaptcha.com")!)
    } catch {
      sendEvent("onError", ["stage": "init", "error": String(describing: error)])
      return scheduleNext()
    }
    hcaptcha = captcha
    captcha.validate(on: keyWindowView()) { [weak self] result in
      guard let self else { return }
      do {
        let token = try result.dematerialize()
        self.minted += 1
        self.sendEvent("onToken", ["len": token.count, "minted": self.minted,
                                   "head": String(token.prefix(16))])
        self.postToOracle(token)
      } catch {
        self.sendEvent("onError", ["stage": "validate", "error": String(describing: error)])
      }
      captcha.stop()
      self.scheduleNext()
    }
  }

  private func scheduleNext() {
    guard minting else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(intervalMs)) { [weak self] in
      self?.mintOnce()
    }
  }

  private func keyWindowView() -> UIView {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    let window = windows.first { $0.isKeyWindow } ?? windows.first
    return window?.rootViewController?.view ?? UIView()
  }

  private func postToOracle(_ token: String) {
    guard let url = URL(string: oracleUrl) else {
      return sendEvent("onError", ["stage": "post", "error": "bad oracleUrl"])
    }
    var request = URLRequest(url: url, timeoutInterval: 15)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token, "mint_id": "ios-sdk"])
    URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
      guard let self else { return }
      let code = (response as? HTTPURLResponse)?.statusCode ?? -1
      if error == nil, (200...299).contains(code) { self.posted += 1 }
      self.sendEvent("onPosted", ["status": code, "posted": self.posted,
                                  "error": error?.localizedDescription ?? ""])
    }
    .resume()
  }
}
