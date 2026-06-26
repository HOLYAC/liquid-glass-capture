package expo.modules.liquidglasscapture

import android.annotation.SuppressLint
import android.app.Dialog
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

@Suppress("unused")
class LiquidGlassCaptureModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val networkExecutor = Executors.newSingleThreadExecutor()

  private var dialog: Dialog? = null
  private var webView: WebView? = null
  private var minting = false
  private var sitekey = ""
  private var sdkHost = ""
  private var oracleUrl = ""
  private var intervalMs = 8000
  private var minted = 0
  private var posted = 0
  private var runId = 0

  override fun definition() = ModuleDefinition {
    Name("LiquidGlassCapture")

    Events("onToken", "onError", "onPosted", "onDiagnostic")

    AsyncFunction("startMinting") { sitekey: String, oracleUrl: String, intervalMs: Int ->
      startMinting(sitekey, oracleUrl, intervalMs)
    }

    Function("stopMinting") {
      stopMinting()
    }

    Function("getStatus") {
      mapOf(
        "minting" to minting,
        "minted" to minted,
        "posted" to posted,
        "sitekey" to sitekey,
        "oracleUrl" to oracleUrl,
        "host" to sdkHost,
        "run_id" to runId
      )
    }

    OnDestroy {
      stopMinting()
      networkExecutor.shutdownNow()
    }
  }

  private fun startMinting(rawSitekey: String, rawOracleUrl: String, rawIntervalMs: Int) {
    val cleanSitekey = rawSitekey.trim()
    val cleanOracleUrl = rawOracleUrl.trim()
    if (cleanSitekey.isEmpty()) {
      emitError("start", "empty sitekey")
      return
    }
    if (!isValidUrl(cleanOracleUrl)) {
      emitError("start", "bad oracleUrl")
      return
    }

    mainHandler.post {
      if (minting) {
        emitDiagnostic("start", "already minting", mapOf("run_id" to runId))
        return@post
      }

      runId += 1
      sitekey = cleanSitekey
      sdkHost = hcaptchaSDKHost(cleanSitekey)
      oracleUrl = cleanOracleUrl
      intervalMs = maxOf(2000, rawIntervalMs)
      minted = 0
      posted = 0
      minting = true
      emitDiagnostic(
        "start",
        "android webview minting loop started",
        mapOf("run_id" to runId, "host" to sdkHost, "oracleUrl" to oracleUrl, "intervalMs" to intervalMs)
      )
      mintOnce(runId)
    }
  }

  private fun stopMinting() {
    mainHandler.post {
      minting = false
      runId += 1
      destroyWebView()
      emitDiagnostic("stop", "android webview minting loop stopped", mapOf("run_id" to runId))
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun mintOnce(targetRunId: Int) {
    if (!minting || targetRunId != runId) {
      return
    }

    val activity = appContext.currentActivity
    if (activity == null) {
      emitError("presenter", "no current Android activity", mapOf("run_id" to targetRunId))
      scheduleNext(targetRunId)
      return
    }

    val view = webView ?: WebView(activity).also { newView ->
      WebView.setWebContentsDebuggingEnabled(true)
      newView.settings.javaScriptEnabled = true
      newView.settings.domStorageEnabled = true
      newView.settings.cacheMode = WebSettings.LOAD_NO_CACHE
      newView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
      newView.webChromeClient = WebChromeClient()
      newView.webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
          emitDiagnostic("webview", "page finished", mapOf("run_id" to runId, "url" to (url ?: "")))
        }
      }
      newView.addJavascriptInterface(AndroidBridge(), "LiquidGlassCaptureAndroid")
      webView = newView
      showDialog(activity, newView)
    }

    emitDiagnostic("validate", "loading hCaptcha api.js", mapOf("run_id" to targetRunId, "host" to sdkHost))
    view.loadDataWithBaseURL(
      "https://$sdkHost/",
      buildHtml(sitekey, sdkHost),
      "text/html",
      "UTF-8",
      null
    )
  }

  private fun showDialog(activity: android.app.Activity, view: WebView) {
    val currentDialog = Dialog(activity)
    currentDialog.setTitle("hCaptcha")
    currentDialog.setContentView(
      view,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    )
    currentDialog.setOnCancelListener {
      val targetRunId = runId
      dialog = null
      webView?.removeAllViews()
      webView?.destroy()
      webView = null
      emitError("validate", "challenge dialog cancelled", mapOf("run_id" to runId))
      scheduleNext(targetRunId)
    }
    dialog = currentDialog
    currentDialog.show()
    currentDialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }

  private fun handleBridgeMessage(raw: String) {
    val payload = runCatching { JSONObject(raw) }.getOrElse {
      emitError("bridge", "bad json: ${it.message}", mapOf("run_id" to runId))
      return
    }

    when {
      payload.has("token") -> handleToken(payload.optString("token"))
      payload.has("error") -> emitError(
        "validate",
        "hCaptcha error ${payload.optString("error")}",
        mapOf("run_id" to runId)
      )
      payload.optString("action").isNotEmpty() -> emitDiagnostic(
        "sdk",
        payload.optString("action"),
        mapOf("run_id" to runId)
      )
      payload.optString("log").isNotEmpty() -> emitDiagnostic(
        "sdk",
        payload.optString("log").take(180),
        mapOf("run_id" to runId)
      )
    }
  }

  private fun handleToken(token: String) {
    mainHandler.post {
      val targetRunId = runId
      if (!minting || token.isEmpty()) {
        return@post
      }
      minted += 1
      emitEvent(
        "onToken",
        mapOf("len" to token.length, "minted" to minted, "head" to token.take(16), "run_id" to targetRunId)
      )
      webView?.loadUrl("about:blank")
      postToOracle(token, targetRunId)
      scheduleNext(targetRunId)
    }
  }

  private fun scheduleNext(targetRunId: Int) {
    if (!minting || targetRunId != runId) {
      return
    }
    mainHandler.postDelayed({
      if (minting && targetRunId == runId) {
        mintOnce(targetRunId)
      }
    }, intervalMs.toLong())
  }

  private fun postToOracle(token: String, targetRunId: Int) {
    val targetUrl = oracleUrl
    val targetSitekey = sitekey
    val targetHost = sdkHost
    networkExecutor.execute {
      var status = -1
      var body = ""
      var error = ""
      try {
        val connection = (URL(targetUrl).openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          connectTimeout = 15000
          readTimeout = 15000
          doOutput = true
          setRequestProperty("Content-Type", "application/json")
        }
        val json = JSONObject()
          .put("token", token)
          .put("mint_id", "android-webview")
          .put("platform", "android-webview")
          .put("sitekey", targetSitekey)
          .put("host", targetHost)
          .put("run_id", targetRunId)
          .put("created_at_ms", System.currentTimeMillis())
          .toString()
        connection.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
        status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        body = stream?.bufferedReader()?.use { it.readText() } ?: ""
        connection.disconnect()
      } catch (exception: Exception) {
        error = exception.message ?: exception.javaClass.simpleName
      }

      mainHandler.post {
        if (targetRunId != runId) {
          return@post
        }
        if (error.isEmpty() && status in 200..299) {
          posted += 1
        }
        emitEvent(
          "onPosted",
          mapOf(
            "status" to status,
            "posted" to posted,
            "error" to error,
            "body" to body.take(160),
            "run_id" to targetRunId
          )
        )
      }
    }
  }

  private fun destroyWebView() {
    dialog?.dismiss()
    dialog = null
    webView?.removeAllViews()
    webView?.destroy()
    webView = null
  }

  private fun buildHtml(sitekey: String, host: String): String {
    val endpoint = "https://js.hcaptcha.com/1/api.js?onload=onloadCallback&render=explicit" +
      "&recaptchacompat=off&host=$host&sentry=false"
    return """
      <!doctype html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no"/>
        <style>
          html, body, #hcaptcha-container { width: 100%; height: 100%; margin: 0; background: #0b0b0c; }
          #hcaptcha-container { display: flex; align-items: center; justify-content: center; }
        </style>
        <script>
          function post(value) {
            window.LiquidGlassCaptureAndroid.postMessage(JSON.stringify(value));
          }
          function onPass(token) {
            post({ token: token });
          }
          function errorCallback(error) {
            post({ error: error || "unknown" });
          }
          function closeCallback() {
            post({ error: "closed" });
          }
          function expiredCallback(action) {
            return function() {
              post({ error: action });
            };
          }
          function openCallback() {
            post({ action: "open" });
          }
          function onloadCallback() {
            try {
              window.hCaptchaID = hcaptcha.render("hcaptcha-container", {
                sitekey: ${JSONObject.quote(sitekey)},
                size: "invisible",
                callback: onPass,
                "error-callback": errorCallback,
                "close-callback": closeCallback,
                "expired-callback": expiredCallback("expired"),
                "chalexpired-callback": expiredCallback("challengeExpired"),
                "open-callback": openCallback
              });
              post({ action: "didLoad" });
              hcaptcha.execute(window.hCaptchaID);
            } catch (e) {
              post({ error: "render:" + e.message });
            }
          }
          var script = document.createElement("script");
          script.src = ${JSONObject.quote(endpoint)};
          script.onerror = function() { post({ error: "api.js network" }); };
          document.head.appendChild(script);
        </script>
      </head>
      <body><div id="hcaptcha-container"></div></body>
      </html>
    """.trimIndent()
  }

  private fun hcaptchaSDKHost(sitekey: String): String = "$sitekey.ios-sdk.hcaptcha.com"

  private fun isValidUrl(value: String): Boolean =
    runCatching { URL(value) }.isSuccess

  private fun emitError(stage: String, error: String, extra: Map<String, Any?> = emptyMap()) {
    emitEvent("onError", extra + mapOf("stage" to stage, "error" to error))
  }

  private fun emitDiagnostic(stage: String, message: String, extra: Map<String, Any?> = emptyMap()) {
    emitEvent("onDiagnostic", extra + mapOf("stage" to stage, "message" to message))
  }

  private fun emitEvent(name: String, payload: Map<String, Any?>) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      sendEvent(name, payload)
    } else {
      mainHandler.post { sendEvent(name, payload) }
    }
  }

  private inner class AndroidBridge {
    @JavascriptInterface
    fun postMessage(raw: String) {
      handleBridgeMessage(raw)
    }
  }
}
