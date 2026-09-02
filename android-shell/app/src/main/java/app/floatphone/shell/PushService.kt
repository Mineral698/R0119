package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 推送前台服务：不依赖 Google 服务的自建长连接。
 *
 * 原理：网页通过 AndroidShell.configurePush 下发个人云地址后，用 OkHttp
 * WebSocket 直连该项目的 Realtime，订阅个人频道 shellpush:<userId>
 * （自部署为 shellpush:owner）。未下发时回退站点 /api/online/config。
 * 服务端（push-generate / 测试按钮）发离线消息时会向该频道广播一份，
 * 本服务收到即弹系统通知——App 被杀也能收（前台服务存活期间）。
 */
class PushService : Service() {

    companion object {
        private const val CH_KEEPALIVE = "shell_keepalive"
        private const val CH_MESSAGES = "shell_messages"
        private const val CH_CALLS = "shell_calls"
        private const val NOTIF_FG_ID = 1
        private const val PREFS = "shell_push"
        private const val KEY_PERSONAL_CONFIG = "personal_config"
        private var running = false
        @Volatile private var instance: PushService? = null

        fun start(context: Context) {
            if (running) return
            val intent = Intent(context, PushService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

        /**
         * 网页把个人云 Realtime 参数交过来。自部署没有站点级 Supabase，
         * 壳必须连用户自己的项目、订阅 shellpush:owner。
         */
        fun applyPersonalConfig(context: Context, json: String) {
            val parsed = runCatching { JSONObject(json) }.getOrNull() ?: return
            val url = parsed.optString("supabaseUrl").trim().trimEnd('/')
            val key = parsed.optString("realtimeKey").trim()
            val userId = parsed.optString("userId").trim().ifEmpty { "owner" }
            if (url.isEmpty() || key.isEmpty()) return
            val next = JSONObject()
                .put("supabaseUrl", url)
                .put("realtimeKey", key)
                .put("userId", userId)
                .toString()
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            // 网页每 15 秒会再下发一次；配置没变就不要拆掉已连上的长连接，
            // 否则正好赶在广播到达时掉线，表现为「已连接却收不到推送」。
            if (prefs.getString(KEY_PERSONAL_CONFIG, null) == next && instance != null) return
            prefs.edit().putString(KEY_PERSONAL_CONFIG, next).commit()
            Handler(Looper.getMainLooper()).post {
                instance?.requestReconnect() ?: start(context)
            }
        }
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var socket: WebSocket? = null
    private var stopped = false
    private var msgSeq = 2
    private var notifId = 100
    private var shellSubRegistered = false
    @Volatile private var reconnectRequested = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        instance = this
        createChannels()
        startForeground(NOTIF_FG_ID, buildKeepAliveNotification("等待连接…"))
        thread(name = "shell-push-loop") { connectionLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        stopped = true
        running = false
        if (instance === this) instance = null
        socket?.cancel()
        super.onDestroy()
    }

    private fun requestReconnect() {
        reconnectRequested = true
        shellSubRegistered = false
        socket?.cancel()
    }

    // ── 连接循环：拿配置 → 连 WS → 断线退避重连 ──
    private fun connectionLoop() {
        var backoffSec = 5L
        while (!stopped) {
            reconnectRequested = false
            val config = fetchConfig()
            if (config == null) {
                updateKeepAlive("请在本 App 打开设置→云服务部署，接上个人云")
                sleepSec(8); continue
            }
            updateKeepAlive("正在连接个人云…")
            val closedNormally = runSocket(config)
            if (stopped) break
            updateKeepAlive("连接断开，重连中…")
            sleepSec(if (closedNormally || reconnectRequested) 3 else backoffSec)
            backoffSec = if (closedNormally || reconnectRequested) 5 else (backoffSec * 2).coerceAtMost(120)
        }
    }

    private data class PushConfig(
        val supabaseUrl: String,
        val anonKey: String,
        val userId: String,
        val personal: Boolean = false,
    )

    private fun loadPersonalConfig(): PushConfig? {
        val raw = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_PERSONAL_CONFIG, null) ?: return null
        val obj = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val url = obj.optString("supabaseUrl").trim().trimEnd('/')
        val key = obj.optString("realtimeKey").trim()
        val userId = obj.optString("userId").trim()
        if (url.isEmpty() || key.isEmpty() || userId.isEmpty()) return null
        return PushConfig(url, key, userId, personal = true)
    }

    /** 优先用网页下发的个人云参数；没有则回退站点联机库（官方托管）。 */
    private fun fetchConfig(): PushConfig? {
        val personal = loadPersonalConfig()
        if (personal != null) {
            registerShellSubscription(personal)
            return personal
        }
        return fetchSiteConfig()
    }

    /** 借 WebView 的登录 Cookie 调站点接口获取连接参数。 */
    private fun fetchSiteConfig(): PushConfig? = runCatching {
        val cookie = CookieManager.getInstance().getCookie(MainActivity.SITE_URL) ?: return null

        fun getJson(path: String): JSONObject? {
            val request = Request.Builder()
                .url("${MainActivity.SITE_URL}$path")
                .header("Cookie", cookie)
                .header("Accept", "application/json")
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                return JSONObject(response.body?.string() ?: return null)
            }
        }

        val me = getJson("/api/auth/me") ?: return null
        val userId = me.optJSONObject("account")?.optString("id").orEmpty()
        if (userId.isEmpty()) return null
        val online = getJson("/api/online/config") ?: return null
        if (!online.optBoolean("configured")) return null
        val url = online.optString("supabaseUrl")
        val key = online.optString("anonKey")
        if (url.isEmpty() || key.isEmpty()) return null
        val config = PushConfig(url.trimEnd('/'), key, userId, personal = false)
        registerShellSubscription(config, cookie)
        config
    }.getOrNull()

    /**
     * 登记合成推送订阅（endpoint = shell:<userId>）。
     * 作用是让离线消息排期的"账号已订阅"门控放行，并让服务端知道
     * 要往 shellpush 频道广播；服务端不会对它做 Web Push 投递。
     */
    private fun registerShellSubscription(config: PushConfig, cookie: String? = null): Boolean {
        if (shellSubRegistered) return true
        return runCatching {
            val body = JSONObject()
                .put("endpoint", "shell:${config.userId}")
                .put(
                    "keys",
                    JSONObject().put("p256dh", "shell").put("auth", "shell"),
                )
                .toString()
                .toRequestBody("application/json".toMediaType())
            val request = if (config.personal) {
                Request.Builder()
                    .url("${config.supabaseUrl}/functions/v1/ai-phone-push?action=subscribe")
                    .header("x-ai-phone-service-key", config.anonKey)
                    .header("apikey", config.anonKey)
                    .header("Authorization", "Bearer ${config.anonKey}")
                    .header("Content-Type", "application/json")
                    .post(body)
                    .build()
            } else {
                Request.Builder()
                    .url("${MainActivity.SITE_URL}/api/push/subscribe")
                    .header("Cookie", cookie ?: "")
                    .post(body)
                    .build()
            }
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    shellSubRegistered = true
                    true
                } else {
                    false
                }
            }
        }.getOrDefault(false)
    }

    /** 跑一条 WebSocket 直到断开；返回是否属于正常关闭。 */
    private fun runSocket(config: PushConfig): Boolean {
        val encodedKey = URLEncoder.encode(config.anonKey, "UTF-8")
        val wsUrl = config.supabaseUrl.replaceFirst("http", "ws") +
            "/realtime/v1/websocket?apikey=$encodedKey&vsn=1.0.0"
        val topic = "realtime:shellpush:${config.userId}"
        val lock = Object()
        var normal = false
        var done = false

        val listener = object : WebSocketListener() {
            fun sendJoin(webSocket: WebSocket, privateChannel: Boolean, ref: String) {
                val join = JSONObject()
                    .put("topic", topic)
                    .put("event", "phx_join")
                    .put("ref", ref)
                    .put("join_ref", ref)
                    .put(
                        "payload",
                        JSONObject()
                            .put(
                                "config",
                                JSONObject()
                                    .put(
                                        "broadcast",
                                        JSONObject().put("self", false).put("ack", false),
                                    )
                                    .put(
                                        "presence",
                                        JSONObject().put("key", "").put("enabled", false),
                                    )
                                    .put("postgres_changes", JSONArray())
                                    .put("private", privateChannel),
                            )
                            .put("access_token", config.anonKey),
                    )
                webSocket.send(join.toString())
            }

            override fun onOpen(webSocket: WebSocket, response: Response) {
                // 新项目 Realtime 默认偏 private；旧项目和 REST 广播常走 public。
                // 先加公开频道，失败再加私有，两边 REST 也会各发一条。
                sendJoin(webSocket, privateChannel = false, ref = "1")
                if (!registerShellSubscription(config)) {
                    updateKeepAlive("已连频道，正在登记推送订阅…")
                }
                thread(name = "shell-push-heartbeat") {
                    while (!done && !stopped) {
                        sleepSec(25)
                        if (done || stopped) break
                        if (!shellSubRegistered) registerShellSubscription(config)
                        runCatching {
                            webSocket.send(
                                JSONObject()
                                    .put("topic", "phoenix")
                                    .put("event", "heartbeat")
                                    .put("payload", JSONObject())
                                    .put("ref", (msgSeq++).toString())
                                    .toString(),
                            )
                        }
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    val msg = JSONObject(text)
                    val event = msg.optString("event")
                    val ref = msg.optString("ref")
                    if (event == "phx_reply" && (ref == "1" || ref == "1b")) {
                        val status = msg.optJSONObject("payload")?.optString("status").orEmpty()
                        if (status == "ok") {
                            updateKeepAlive(
                                if (shellSubRegistered) "已连接，等待角色消息"
                                else "已连接频道，推送订阅还在登记…",
                            )
                        } else if (ref == "1") {
                            sendJoin(webSocket, privateChannel = true, ref = "1b")
                        } else {
                            val reason = msg.optJSONObject("payload")
                                ?.optJSONObject("response")
                                ?.optString("reason")
                                ?.ifEmpty { status }
                                ?: status
                            updateKeepAlive("频道订阅失败（$reason），重试中…")
                            webSocket.cancel()
                        }
                        return@runCatching
                    }
                    val body = notifyPayload(msg) ?: return@runCatching
                    val title = body.optString("title").ifEmpty { getString(R.string.app_name) }
                    val text2 = body.optString("body").ifEmpty { "有新消息" }
                    if (body.optString("kind") == "call") {
                        val shown = runCatching {
                            showIncomingCallNotification(
                                body.optString("characterName").ifEmpty { title },
                                body.optString("sessionId"),
                                body.optLong("callTs", System.currentTimeMillis()),
                            )
                        }.isSuccess
                        if (shown) return@runCatching
                    }
                    showMessageNotification(title, text2)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                normal = true
                synchronized(lock) { done = true; lock.notifyAll() }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                synchronized(lock) { done = true; lock.notifyAll() }
            }
        }

        socket = client.newWebSocket(
            Request.Builder()
                .url(wsUrl)
                .header("Authorization", "Bearer ${config.anonKey}")
                .header("apikey", config.anonKey)
                .build(),
            listener,
        )
        synchronized(lock) {
            while (!done && !stopped) runCatching { lock.wait(30_000) }
        }
        socket?.cancel()
        socket = null
        return normal
    }

    /** 兼容 Realtime 广播的几种包一层 / 两层 payload。 */
    private fun notifyPayload(msg: JSONObject): JSONObject? {
        val event = msg.optString("event")
        if (event == "phx_reply" || event == "phx_close" || event == "phx_error"
            || event == "phx_join" || event == "heartbeat"
            || event == "presence_state" || event == "presence_diff" || event == "system"
        ) return null

        fun looksLikeNotify(obj: JSONObject?): JSONObject? {
            if (obj == null) return null
            return if (obj.has("title") || obj.has("body") || obj.has("kind")) obj else null
        }

        val payload = msg.optJSONObject("payload")
        if (event == "notify") {
            return looksLikeNotify(payload) ?: looksLikeNotify(payload?.optJSONObject("payload"))
        }
        val innerEvent = payload?.optString("event").orEmpty()
        if (event == "broadcast" || payload?.optString("type") == "broadcast" || innerEvent == "notify") {
            looksLikeNotify(payload?.optJSONObject("payload"))?.let { return it }
            looksLikeNotify(payload)?.let { return it }
        }
        looksLikeNotify(payload)?.let { return it }

        val wrapped = msg.optJSONArray("m") ?: payload?.optJSONArray("m")
        if (wrapped != null && wrapped.length() > 0) {
            val first = wrapped.optJSONObject(0) ?: return null
            return looksLikeNotify(first) ?: looksLikeNotify(first.optJSONObject("payload"))
                ?: notifyPayload(first)
        }
        return null
    }

    // ── 通知 ──
    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CH_KEEPALIVE, "后台连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "维持角色消息接收通道（可在此关闭常驻通知的显示）"
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CH_MESSAGES, "角色消息", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "角色发来的离线消息"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CH_CALLS, "角色来电", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "角色打来的语音电话（只振动，不响铃）"
                setSound(null, null)
                enableVibration(false) // 振动由 CallAlert 循环控制，渠道自带的一次性振动关掉
            },
        )
    }

    private fun contentIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE,
    )

    private fun buildKeepAliveNotification(text: String): Notification =
        NotificationCompat.Builder(this, CH_KEEPALIVE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()

    private fun updateKeepAlive(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIF_FG_ID, buildKeepAliveNotification(text))
    }

    /**
     * 全屏来电通知：锁屏/熄屏直接弹 IncomingCallActivity，亮屏时是带
     * 接听/拒接按钮的 heads-up。振动循环 + 55s 超时未接由 CallAlert 管。
     */
    private fun showIncomingCallNotification(characterName: String, sessionId: String, callTs: Long) {
        val fullScreen = Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(IncomingCallActivity.EXTRA_SESSION_ID, sessionId)
            putExtra(IncomingCallActivity.EXTRA_CHARACTER_NAME, characterName)
            putExtra(IncomingCallActivity.EXTRA_CALL_TS, callTs)
        }
        val fullScreenPending = PendingIntent.getActivity(
            this, 60, fullScreen,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        fun buildAction(actionName: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
            this, code,
            Intent(this, CallActionReceiver::class.java).apply {
                action = actionName
                putExtra(CallActionReceiver.EXTRA_SESSION_ID, sessionId)
                putExtra(CallActionReceiver.EXTRA_CALL_TS, callTs)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CH_CALLS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(characterName)
            .setContentText("语音来电…")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreenPending, true)
            .setContentIntent(fullScreenPending)
            .addAction(0, "拒接", buildAction(CallActionReceiver.ACTION_DECLINE, 61))
            .addAction(0, "接听", buildAction(CallActionReceiver.ACTION_ANSWER, 62))
            .build()
        getSystemService(NotificationManager::class.java).notify(CallAlert.NOTIF_CALL_ID, notification)
        CallAlert.start(this, sessionId, characterName) {
            // 超时未接：收场 + 换一条"未接来电"普通通知（正文消息本来就会进聊天）
            CallAlert.stop(this)
            runCatching { showMissedCallNotification(characterName) }
        }
    }

    private fun showMissedCallNotification(characterName: String) {
        val notification = NotificationCompat.Builder(this, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(characterName)
            .setContentText("未接来电")
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        getSystemService(NotificationManager::class.java).notify(CallAlert.NOTIF_MISSED_ID, notification)
    }

    private fun showMessageNotification(title: String, body: String) {
        val notification = NotificationCompat.Builder(this, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        getSystemService(NotificationManager::class.java).notify(notifId++, notification)
        if (notifId > 400) notifId = 100
    }

    private fun sleepSec(sec: Long) {
        var left = sec
        while (left > 0 && !stopped && !reconnectRequested) {
            val slice = left.coerceAtMost(2)
            runCatching { Thread.sleep(slice * 1000) }
            left -= slice
        }
    }
}
