package com.psc.exam

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URLConnection
import java.util.Locale

/**
 * 注入到网页的原生桥（window.PscAndroid）：
 *  1. tts*  —— 用系统 TextToSpeech 实现 web 端 window.speechSynthesis（见 assets/tts-shim.js）
 *              Android WebView 不提供可靠的语音合成，考试提示音靠它开箱即用
 *  2. saveBase64 —— 设置页「导出配置」blob 下载落地到下载目录
 */
class TtsBridge(
    private val activity: Activity,
    private val eval: (String) -> Unit
) : TextToSpeech.OnInitListener {

    companion object {
        private const val TAG = "PscTts"
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null

    @Volatile private var ready = false
    @Volatile private var failed = false
    @Volatile private var voicesJson: String = "[]"

    private val queueLock = Any()
    private val queue = ArrayDeque<QueuedSpeech>()
    private var refreshTries = 0

    private data class QueuedSpeech(
        val id: String, val text: String, val lang: String,
        val voiceName: String, val rate: Float, val pitch: Float, val volume: Float
    )

    fun start() {
        tts = TextToSpeech(activity.applicationContext, this)
    }

    fun shutdown() {
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (e: Exception) {
            Log.w(TAG, "shutdown", e)
        }
        tts = null
        ready = false
        mainHandler.removeCallbacksAndMessages(null)
    }

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS || tts == null) {
            failed = true
            Log.w(TAG, "system TTS init failed ($status) —— 提示音不可用")
            flushQueue(true)
            return
        }
        val t = tts ?: return
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) = settle(utteranceId, null)
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) = settle(utteranceId, "synthesis-failed")
            override fun onError(utteranceId: String?, errorCode: Int) = settle(utteranceId, "synthesis-failed")
        })
        try {
            t.language = Locale.SIMPLIFIED_CHINESE
        } catch (e: Exception) {
            Log.w(TAG, "default locale", e)
        }
        ready = true
        refreshVoices()
        flushQueue(false)
        // 部分 TTS 引擎的语音列表是异步就绪的，稍后多刷几次
        for (delay in longArrayOf(300, 900, 2000, 4000)) {
            mainHandler.postDelayed({ refreshVoices() }, delay)
        }
    }

    /** 收集系统语音列表为 JSON（供 shim 的 getVoices()） */
    private fun refreshVoices() {
        val t = tts ?: return
        val arr = JSONArray()
        try {
            val voices = t.voices
            if (voices != null) {
                for (v in voices) {
                    if (v.name.isNullOrBlank()) continue
                    val langTag = try { v.locale?.toLanguageTag() ?: "" } catch (e: Exception) { "" }
                    arr.put(
                        JSONObject()
                            .put("name", v.name)
                            .put("voiceURI", v.name)
                            .put("lang", langTag)
                            .put("localService", !v.isNetworkConnectionRequired)
                            .put("local", !v.isNetworkConnectionRequired)
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "enumerate voices failed", e)
        }
        if (arr.length() == 0) {
            // 引擎未暴露列表时给一个占位项，避免前端语音下拉为空
            arr.put(
                JSONObject()
                    .put("name", "系统默认语音")
                    .put("voiceURI", "")
                    .put("lang", "zh-CN")
                    .put("localService", true)
                    .put("local", true)
            )
        }
        val next = arr.toString()
        if (next != voicesJson) {
            voicesJson = next
            if (refreshTries < 20) refreshTries++
            eval("window.__pscTtsVoicesChanged && window.__pscTtsVoicesChanged();")
        }
    }

    @JavascriptInterface
    fun isTtsAvailable(): Boolean = ready || !failed

    @JavascriptInterface
    fun getTtsVoices(): String = voicesJson

    /** shim 调用：播报一条（引擎未就绪时先排队，init 成功后补发） */
    @JavascriptInterface
    fun ttsSpeak(
        id: String,
        text: String,
        lang: String,
        voiceName: String,
        rate: Float,
        pitch: Float,
        volume: Float
    ): Int {
        if (text.isEmpty()) {
            settle(id, null)
            return 0
        }
        val t = tts
        if (failed) {
            settle(id, "synthesis-failed")
            return -1
        }
        if (!ready || t == null) {
            synchronized(queueLock) {
                queue.addLast(QueuedSpeech(id, text, lang, voiceName, rate, pitch, volume))
            }
            return 0
        }
        mainHandler.post { send(t, id, text, lang, voiceName, rate, pitch, volume) }
        return 0
    }

    /** shim 调用：停播并丢弃队列（前端 cancel() 会先把 pending 结算成 canceled） */
    @JavascriptInterface
    fun ttsCancel() {
        mainHandler.post {
            try {
                tts?.stop()
            } catch (e: Exception) {
                Log.w(TAG, "stop", e)
            }
        }
    }

    private fun flushQueue(asError: Boolean) {
        val items = synchronized(queueLock) {
            val copy = queue.toList()
            queue.clear()
            copy
        }
        val t = tts
        for (q in items) {
            if (asError || t == null) settle(q.id, "synthesis-failed")
            else send(t, q.id, q.text, q.lang, q.voiceName, q.rate, q.pitch, q.volume)
        }
    }

    private fun send(
        t: TextToSpeech, id: String, text: String, lang: String,
        voiceName: String, rate: Float, pitch: Float, volume: Float
    ) {
        try {
            if (voiceName.isNotBlank()) {
                val chosen = t.voices?.firstOrNull { it.name == voiceName }
                if (chosen != null) t.voice = chosen else t.setLanguage(localeFor(lang))
            } else {
                t.setLanguage(localeFor(lang))
            }
            t.setSpeechRate(rate)
            // TextToSpeech 的音高接口是 setPitch（没有 setSpeechPitch）
            t.setPitch(pitch)
            val params = android.os.Bundle()
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.coerceIn(0f, 1f))
            val res = t.speak(text, TextToSpeech.QUEUE_ADD, params, id)
            if (res != TextToSpeech.SUCCESS) settle(id, "synthesis-failed")
        } catch (e: Exception) {
            Log.w(TAG, "speak failed", e)
            settle(id, "synthesis-failed")
        }
    }

    private fun localeFor(lang: String): Locale {
        return try {
            if (lang.isBlank()) Locale.SIMPLIFIED_CHINESE else Locale.forLanguageTag(lang)
        } catch (e: Exception) {
            Locale.SIMPLIFIED_CHINESE
        }
    }

    /** TTS 完成/失败回调 → 通知 shim 结算对应 utterance */
    private fun settle(id: String?, error: String?) {
        if (id.isNullOrBlank()) return
        val qid = JSONObject.quote(id)
        val js = if (error == null) {
            "window.__pscTtsDone && window.__pscTtsDone($qid);"
        } else {
            "window.__pscTtsError && window.__pscTtsError($qid);"
        }
        eval(js)
    }

    /* ---------------------------- 导出配置落盘 ---------------------------- */

    @JavascriptInterface
    fun saveBase64(filename: String, base64: String) {
        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val name = filename.ifBlank { "psc-exam-config.json" }
            val path = writeDownloads(name, bytes)
            mainHandler.post {
                Toast.makeText(activity, activity.getString(R.string.saved_toast, path), Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            Log.w(TAG, "save failed", e)
            mainHandler.post {
                Toast.makeText(
                    activity,
                    activity.getString(R.string.save_failed_toast, e.message ?: "unknown"),
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    @JavascriptInterface
    fun reportExportFailed(filename: String) {
        mainHandler.post {
            Toast.makeText(
                activity,
                activity.getString(R.string.save_failed_toast, filename),
                Toast.LENGTH_LONG
            ).show()
        }
    }

    private fun writeDownloads(name: String, bytes: ByteArray): String {
        val mime = URLConnection.guessContentTypeFromName(name) ?: "application/octet-stream"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException("无法创建下载记录")
            activity.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IOException("无法写入文件")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            activity.contentResolver.update(uri, values, null, null)
            return "${Environment.DIRECTORY_DOWNLOADS}/$name"
        }
        // Android 10 以下：应用专属目录免存储权限
        val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: activity.filesDir
        val file = File(dir, name)
        file.writeBytes(bytes)
        return file.absolutePath
    }
}
