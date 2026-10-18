package com.psc.exam

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 普通话水平测试（PSC）模拟考试 · 安卓壳
 *
 * 打包 ../psc-exam 构建产物到 assets/web，经 WebViewAssetLoader 以
 * https://appassets.androidplatform.net/ 安全源加载，从而：
 *  - getUserMedia（麦克风）、AudioContext、localStorage、WebSocket(wss) 均可用
 *  - 前端绝对路径 /assets/ 下资源原样工作，无需改造 web 源码
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "PscExam"
        private const val HOME_PREFIX = "https://appassets.androidplatform.net/"
        private const val HOME_URL = HOME_PREFIX + "index.html"
        private const val REQ_MIC = 1001
        private const val SHIM_ASSET = "tts-shim.js"
    }

    private lateinit var webView: WebView
    private lateinit var ttsBridge: TtsBridge
    private var shimJs: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 考试中屏幕保持常亮
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this)
        setContentView(webView)
        setupWebView()

        ttsBridge = TtsBridge(this) { js -> runOnUiThread { evalJs(js) } }
        ttsBridge.start()
        webView.addJavascriptInterface(ttsBridge, "PscAndroid")

        // 录音权限（web 端 getUserMedia 依赖系统授权）
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
        }

        val restored = savedInstanceState?.let { webView.restoreState(it) } != null
        if (!restored) webView.loadUrl(HOME_URL)
    }

    private fun setupWebView() {
        // 调试构建才允许 chrome://inspect 远程调试
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // 提示音/倒计时由代码触发播放，不能要求手势
            mediaPlaybackRequiresUserGesture = false
            // 页面是 https(appassets)，但允许访问用户配置的 http 本机 TTS / 局域网服务
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            loadsImagesAutomatically = true
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            // 不支持多窗口：target="_blank" 由 shouldOverrideUrlLoading 交给外部浏览器
            setSupportMultipleWindows(false)
        }

        // web 构建产物直接放在 assets 根（index.html + assets/*），因此把 "/" 映射到 assets 根。
        // 注意：androidx.webkit 只提供 addPathHandler(String, PathHandler) 与单参数
        // AssetsPathHandler(Context)（没有 addMapping / 带子目录的构造），故 web 资源不放在 assets/web 子目录。
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                injectShim()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injectShim()
            }

            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                val uri = request?.url ?: return super.shouldInterceptRequest(view, request)
                return try {
                    // 仅拦截 appassets 前缀（本地资源），其余（接口/WS）走正常网络
                    assetLoader.shouldInterceptRequest(uri)
                } catch (e: Exception) {
                    Log.w(TAG, "intercept failed: $uri", e)
                    null
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
                openExternally(request?.url)

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean =
                openExternally(url?.let(Uri::parse))
        }

        webView.webChromeClient = object : WebChromeClient() {
            /** 网页请求麦克风（设备调试/开始录音）时，转发系统授权结果 */
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val wantMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                    val granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                    if (wantMic && granted) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else {
                        request.deny()
                    }
                }
            }

            override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage?): Boolean {
                Log.d(TAG, "console: ${consoleMessage?.message()} @${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()}")
                return true
            }
        }

        // 设置页「导出配置」是 blob: 下载，WebView 原生不处理，这里取回数据落盘
        webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            when {
                url.startsWith("blob:") -> exportBlob(url, contentDisposition, mimeType)
                url.startsWith("http://") || url.startsWith("https://") -> openExternally(Uri.parse(url))
                else -> Log.w(TAG, "unsupported download: $url")
            }
        }
    }

    /** 应用内部资源留在 WebView，其余链接交给系统浏览器 */
    private fun openExternally(uri: Uri?): Boolean {
        if (uri == null) return false
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        when {
            uri.toString().startsWith(HOME_PREFIX) -> return false
            scheme == "about" || scheme == "data" || scheme == "javascript" -> return false
        }
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (e: Exception) {
            Log.w(TAG, "no handler for $uri")
            true
        }
    }

    /** 把 blob: 对象 URL 的内容读成 base64 交给原生保存到下载目录 */
    private fun exportBlob(blobUrl: String, contentDisposition: String?, mimeType: String?) {
        val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
        val name = if (!contentDisposition.isNullOrBlank()) {
            URLUtil.guessFileName(blobUrl, contentDisposition, mimeType ?: "*/*")
        } else {
            "psc-exam-config-$today.json"
        }
        val js =
            "(function(){var u=${JSONObject.quote(blobUrl)},n=${JSONObject.quote(name)};" +
                "fetch(u).then(function(r){return r.blob();}).then(function(b){" +
                "var fr=new FileReader();" +
                "fr.onloadend=function(){try{window.PscAndroid.saveBase64(n,String(fr.result).split(',')[1]);}catch(e){}};" +
                "fr.readAsDataURL(b);}).catch(function(){try{window.PscAndroid.reportExportFailed(n);}catch(e){}});" +
                "})();"
        evalJs(js)
    }

    /** 把 Android TextToSpeech 桥接到 window.speechSynthesis（每次页面加载注入，幂等） */
    private fun injectShim() {
        val js = shimJs ?: run {
            val text = assets.open(SHIM_ASSET).bufferedReader(Charsets.UTF_8).readText()
            shimJs = text
            text
        }
        evalJs(js)
    }

    private fun evalJs(js: String) {
        if (isDestroyed) return
        try {
            webView.evaluateJavascript(js, null)
        } catch (e: Exception) {
            Log.w(TAG, "evaluateJavascript failed", e)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_MIC && (grantResults.isEmpty() || grantResults[0] != PackageManager.PERMISSION_GRANTED)) {
            Toast.makeText(this, R.string.mic_permission_hint, Toast.LENGTH_LONG).show()
        }
    }

    override fun onResume() {
        super.onResume()
        if (this::webView.isInitialized) webView.onResume()
    }

    override fun onPause() {
        if (this::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (this::webView.isInitialized) webView.saveState(outState)
    }

    override fun onDestroy() {
        if (this::ttsBridge.isInitialized) ttsBridge.shutdown()
        if (this::webView.isInitialized) {
            try {
                webView.stopLoading()
                webView.destroy()
            } catch (e: Exception) {
                Log.w(TAG, "webView destroy", e)
            }
        }
        super.onDestroy()
    }
}

