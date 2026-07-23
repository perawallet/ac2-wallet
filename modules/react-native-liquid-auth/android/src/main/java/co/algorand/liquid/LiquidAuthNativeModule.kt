package co.algorand.liquid

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import foundation.algorand.auth.connect.AuthMessage
import foundation.algorand.auth.connect.NotificationContent
import foundation.algorand.auth.connect.NotificationPresenter
import foundation.algorand.auth.connect.SignalClient
import foundation.algorand.auth.connect.SignalService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.PeerConnection

/**
 * React Native (Expo) bindings for the Liquid Auth signaling service.
 *
 * Wraps the native [SignalService] foreground service (migrated from
 * `liquid-auth-android`) so wallets can drive the WebRTC signaling handshake
 * from JavaScript instead of talking to the signaling client directly.
 */
class LiquidAuthNativeModule : Module() {
  companion object {
    const val CHANNEL_ID = "liquid_auth_signaling"
    const val CHANNEL_NAME = "Liquid Auth"
    const val NOTIFICATION_ID = 1337
    const val ON_MESSAGE = "onMessage"
    const val ON_STATE_CHANGE = "onStateChange"
    const val ON_TRACK = "onTrack"
    const val ON_PRESENCE = "onPresence"
    const val ON_LINK_ERROR = "onLinkError"
    const val ON_CONNECTION_STATE_CHANGE = "onConnectionStateChange"
  }

  private var signalService: SignalService? = null
  private var serviceConnection: ServiceConnection? = null
  // A single cookie-jar-backed HTTP client is shared between the authenticated
  // FIDO/session requests issued from JS via `request(...)` and the background
  // [SignalService] socket, so the `connect.sid` session cookie set during the
  // auth ceremony automatically rides the signaling connection (see D9 /
  // docs/NATIVE_AUTH_SESSION.md).
  private val cookieJar = LiquidCookieJar()
  private val httpClient = OkHttpClient.Builder().cookieJar(cookieJar).build()
  private val scope = CoroutineScope(Dispatchers.Main)

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val currentActivity: Activity
    get() = appContext.currentActivity ?: throw Exceptions.MissingActivity()

  override fun definition() = ModuleDefinition {
    Name("LiquidAuthNative")

    Events(ON_MESSAGE, ON_STATE_CHANGE, ON_TRACK, ON_PRESENCE, ON_LINK_ERROR, ON_CONNECTION_STATE_CHANGE)

    /**
     * Generate a random (time-based) request id.
     */
    Function("generateRequestId") {
      SignalClient.generateRequestId()
    }

    /**
     * Parse a `liquid://<origin>/?requestId=<id>` URI (or JSON payload) into
     * its `origin` and `requestId` parts.
     */
    Function("parseMessage") { value: String ->
      val message = AuthMessage.fromString(value)
      mapOf(
        "origin" to message.origin,
        "requestId" to message.requestId
      )
    }

    /**
     * Start (and bind to) the foreground signaling service and connect the
     * signaling client to the given origin.
     */
    AsyncFunction("start") { url: String, promise: Promise ->
      bindService {
        val service = signalService
        if (service == null) {
          promise.reject("E_SERVICE", "Failed to bind the signaling service", null)
          return@bindService
        }
        try {
          service.start(
            url,
            httpClient,
            createNotificationBuilder(),
            NOTIFICATION_ID,
            currentActivity::class.java
          )
          promise.resolve(null)
        } catch (e: Exception) {
          promise.reject("E_START", e.message, e)
        }
      }
    }

    /**
     * Connect to a remote peer by `requestId`. `type` is the remote peer type
     * (`"offer"` or `"answer"`). Data-channel messages and state changes are
     * forwarded through the `onMessage` / `onStateChange` events.
     */
    AsyncFunction("connect") { requestId: String, type: String, iceServers: List<Map<String, Any?>>?, options: Map<String, Any?>?, promise: Promise ->
      val service = signalService
      if (service == null) {
        promise.reject("E_NOT_STARTED", "Signaling service not started, call start() first", null)
        return@AsyncFunction
      }
      val activity = currentActivity
      scope.launch {
        try {
          service.peer(
            requestId,
            type,
            parseIceServers(iceServers),
            parseDataChannels(options),
            null,
            onTrack = { track ->
              sendEvent(
                ON_TRACK,
                mapOf(
                  "id" to track.id(),
                  "kind" to track.kind(),
                  "enabled" to track.enabled()
                )
              )
            },
            onPresence = { presence -> sendEvent(ON_PRESENCE, jsonToMap(presence)) },
            onLinkError = { error -> sendEvent(ON_LINK_ERROR, jsonToMap(error)) },
            onConnectionStateChange = { state ->
              sendEvent(ON_CONNECTION_STATE_CHANGE, mapOf("state" to state))
            }
          )
          service.handleMessages(
            activity,
            { label, msg -> sendEvent(ON_MESSAGE, mapOf("channel" to label, "message" to msg)) },
            { label, state -> sendEvent(ON_STATE_CHANGE, mapOf("channel" to label, "state" to state)) },
            createNotificationBuilder(),
            NOTIFICATION_ID,
            activity::class.java,
            buildNotificationPresenter(options),
            parseQueueChannels(options)
          )
          promise.resolve(null)
        } catch (e: CancellationException) {
          promise.reject("E_ABORTED", "Connection aborted", e)
        } catch (e: Exception) {
          promise.reject("E_CONNECT", e.message, e)
        }
      }
    }

    /**
     * Abort an in-flight [connect] negotiation. The pending `connect` promise
     * rejects with `E_ABORTED`.
     */
    AsyncFunction("cancel") { promise: Promise ->
      signalService?.cancel()
      promise.resolve(null)
    }

    /**
     * Set whether the app is currently online (foregrounded, with its JS
     * listeners attached). When set active, any messages the background
     * service buffered while offline are replayed through the `onMessage`
     * event in arrival order. The app owns this signal so it — not the
     * library — controls the signaling delivery state.
     */
    Function("setActive") { active: Boolean ->
      signalService?.setActive(active)
    }

    /**
     * Send a message over the primary (`liquid`) data channel.
     */
    Function("send") { message: String ->
      val service = signalService ?: throw Exception("Signaling service not started")
      service.send(message)
    }

    /**
     * Send a message over a specific named data channel.
     */
    Function("sendToChannel") { channel: String, message: String ->
      val service = signalService ?: throw Exception("Signaling service not started")
      service.send(channel, message)
    }

    /**
     * Stop the signaling client and unbind/stop the foreground service.
     */
    AsyncFunction("disconnect") { promise: Promise ->
      signalService?.stop()
      unbindService()
      promise.resolve(null)
    }

    /**
     * Perform an authenticated HTTP request through the module's shared
     * cookie-jar client. Because the same client backs the [SignalService]
     * socket, any session cookie (`connect.sid`) set by the response is
     * automatically used by the signaling connection. This lets the wallet run
     * the whole Liquid Auth HTTP exchange (attestation/assertion options +
     * response, `/auth/session`) through the native client so the background
     * service is authenticated (D9).
     *
     * Resolves with `{ ok, status, statusText, body }`; `body` is the raw
     * response text (callers parse JSON themselves).
     */
    AsyncFunction("request") { url: String, method: String, headers: Map<String, String>?, body: String?, promise: Promise ->
      scope.launch {
        try {
          val result = withContext(Dispatchers.IO) {
            val builder = Request.Builder().url(url)
            headers?.forEach { (name, value) -> builder.addHeader(name, value) }
            // The Liquid Auth server derives the expected WebAuthn origin from
            // the User-Agent (an Android APK client resolves to an
            // `android:apk-key-hash:` origin, a browser to the web origin). If
            // the caller didn't set one, OkHttp would send `okhttp/<ver>`,
            // which the server can't classify (it throws parsing the OS) and
            // the attestation/assertion fails. Default to an Android UA in the
            // same shape the `liquid-auth-android` demo uses.
            val hasUserAgent = headers?.keys?.any { it.equals("User-Agent", ignoreCase = true) } == true
            if (!hasUserAgent) {
              builder.header("User-Agent", defaultUserAgent())
            }
            val contentType = headers
              ?.entries
              ?.firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }
              ?.value
              ?: "application/json"
            when (method.uppercase()) {
              "GET" -> builder.get()
              "HEAD" -> builder.head()
              else -> builder.method(
                method.uppercase(),
                (body ?: "").toRequestBody(contentType.toMediaTypeOrNull())
              )
            }
            httpClient.newCall(builder.build()).execute().use { response ->
              mapOf(
                "ok" to response.isSuccessful,
                "status" to response.code,
                "statusText" to response.message,
                "body" to (response.body?.string() ?: "")
              )
            }
          }
          promise.resolve(result)
        } catch (e: Exception) {
          promise.reject("E_REQUEST", e.message, e)
        }
      }
    }

    OnDestroy {
      // The JS runtime is going away (the app is closing/reloading), but the
      // foreground signaling service must keep running so the connection
      // survives closing the app. Only detach the JS binding here; the service
      // is stopped solely by an explicit disconnect().
      unbindOnly()
    }
  }

  /**
   * Build a User-Agent identifying this Android app to the Liquid Auth server
   * (e.g. `app.perawallet.ac2.debug/1.0 (Android 14; Pixel 6; Google)`), mirroring
   * the `liquid-auth-android` demo so the server resolves the expected
   * `android:apk-key-hash:` WebAuthn origin.
   */
  private fun defaultUserAgent(): String {
    val pkg = context.packageName
    val versionName = try {
      context.packageManager.getPackageInfo(pkg, 0).versionName ?: "0"
    } catch (e: Exception) {
      "0"
    }
    return "$pkg/$versionName (Android ${Build.VERSION.RELEASE}; ${Build.MODEL}; ${Build.BRAND})"
  }

  private fun bindService(onConnected: () -> Unit) {
    if (signalService != null) {
      onConnected()
      return
    }
    createNotificationChannel()
    val connection = object : ServiceConnection {
      override fun onServiceDisconnected(name: ComponentName?) {
        signalService = null
      }

      override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
        val localBinder = binder as SignalService.LocalBinder
        signalService = localBinder.getServerInstance()
        onConnected()
      }
    }
    serviceConnection = connection
    val intent = Intent(context, SignalService::class.java)
    context.startService(intent)
    context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
  }

  /**
   * Fully tear down the service: detach the JS binding AND stop the started
   * foreground service. Used only by an explicit `disconnect()`.
   */
  private fun unbindService() {
    serviceConnection?.let {
      try {
        context.unbindService(it)
      } catch (e: Exception) {
        // Service was not bound
      }
    }
    serviceConnection = null
    try {
      context.stopService(Intent(context, SignalService::class.java))
    } catch (e: Exception) {
      // ignore
    }
    signalService = null
  }

  /**
   * Detach only the JS binding WITHOUT stopping the started foreground
   * service, so the signaling connection keeps running after the app is
   * closed. On the next `start()`/bind the module reconnects to the same
   * already-running service instance (preserving its queued messages and
   * peer connection).
   */
  private fun unbindOnly() {
    serviceConnection?.let {
      try {
        context.unbindService(it)
      } catch (e: Exception) {
        // Service was not bound
      }
    }
    serviceConnection = null
    signalService = null
  }

  /**
   * Flatten a (single-level) [JSONObject] into a map so it can be forwarded as
   * an event payload. Presence (`{ requestId, deviceCount, online }`) and
   * signaling exceptions (`{ event, requestId, reason, message }`) are flat.
   */
  private fun jsonToMap(json: JSONObject): Map<String, Any?> {
    val map = mutableMapOf<String, Any?>()
    val keys = json.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      val value = json.opt(key)
      map[key] = if (value == JSONObject.NULL) null else value
    }
    return map
  }

  private fun parseDataChannels(options: Map<String, Any?>?): Map<String, DataChannel.Init>? {
    @Suppress("UNCHECKED_CAST")
    val dataChannels = options?.get("dataChannels") as? Map<String, Any?> ?: return null
    if (dataChannels.isEmpty()) {
      return null
    }
    return dataChannels.mapValues { (_, value) ->
      val init = DataChannel.Init()
      val config = value as? Map<*, *> ?: return@mapValues init
      (config["ordered"] as? Boolean)?.let { init.ordered = it }
      (config["maxRetransmits"] as? Number)?.let { init.maxRetransmits = it.toInt() }
      (config["maxRetransmitTimeMs"] as? Number)?.let { init.maxRetransmitTimeMs = it.toInt() }
      (config["maxPacketLifeTime"] as? Number)?.let { init.maxRetransmitTimeMs = it.toInt() }
      (config["protocol"] as? String)?.let { init.protocol = it }
      (config["negotiated"] as? Boolean)?.let { init.negotiated = it }
      (config["id"] as? Number)?.let { init.id = it.toInt() }
      init
    }
  }

  /**
   * Parse the `queueChannels` option: the set of data-channel labels whose
   * inbound messages the background service buffers while the app is offline
   * (and replays on reactivation). Returns null when omitted, meaning every
   * channel is buffered. The wallet passes its deliverable channels here
   * (e.g. `ac2-v1`, `ac2-stream`) so control-only traffic isn't queued.
   */
  private fun parseQueueChannels(options: Map<String, Any?>?): Set<String>? {
    val list = options?.get("queueChannels") as? List<*> ?: return null
    val channels = list.filterIsInstance<String>().toSet()
    return channels.ifEmpty { null }
  }

  private fun parseIceServers(iceServers: List<Map<String, Any?>>?): List<PeerConnection.IceServer> {
    if (iceServers.isNullOrEmpty()) {
      return listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
      )
    }
    return iceServers.mapNotNull { server ->
      val urls = when (val u = server["urls"]) {
        is String -> listOf(u)
        is List<*> -> u.filterIsInstance<String>()
        else -> emptyList()
      }
      if (urls.isEmpty()) {
        return@mapNotNull null
      }
      val builder = PeerConnection.IceServer.builder(urls)
      (server["username"] as? String)?.let { builder.setUsername(it) }
      (server["credential"] as? String)?.let { builder.setPassword(it) }
      builder.createIceServer()
    }
  }

  /**
   * Build a [NotificationPresenter] from the `notifications` template map passed
   * to `connect(options)`. The consumer (wallet) owns all per-message-type copy;
   * this only provides the generic mechanism (channel suppression + JSON `type`
   * lookup), so the notification is rendered natively even when the JS runtime
   * is suspended/dead.
   *
   * Expected shape:
   * ```
   * notifications: {
   *   suppressChannels: ["ac2-heartbeat", "ac2-stream"],
   *   typeKey: "type",                       // JSON field selecting a template
   *   templates: { "ac2/SigningRequest": { title, body } },
   *   fallback: { title, body }              // used when no type matches
   * }
   * ```
   * Returns null when no config is supplied (legacy raw-text behavior).
   */
  private fun buildNotificationPresenter(options: Map<String, Any?>?): NotificationPresenter? {
    @Suppress("UNCHECKED_CAST")
    val config = options?.get("notifications") as? Map<String, Any?> ?: return null
    val suppressChannels = (config["suppressChannels"] as? List<*>)
      ?.filterIsInstance<String>()
      ?.toSet()
      ?: emptySet()
    val typeKey = config["typeKey"] as? String ?: "type"
    @Suppress("UNCHECKED_CAST")
    val templates = config["templates"] as? Map<String, Any?> ?: emptyMap()
    @Suppress("UNCHECKED_CAST")
    val fallback = config["fallback"] as? Map<String, Any?>
    return NotificationPresenter { label, message ->
      if (label in suppressChannels) {
        return@NotificationPresenter null
      }
      val type = try {
        val json = JSONObject(message)
        if (json.has(typeKey)) json.optString(typeKey) else null
      } catch (e: Exception) {
        null
      }
      @Suppress("UNCHECKED_CAST")
      val template = (type?.let { templates[it] } as? Map<String, Any?>) ?: fallback
      if (template == null) {
        return@NotificationPresenter null
      }
      NotificationContent(
        template["title"] as? String,
        template["body"] as? String ?: message
      )
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        val channel = NotificationChannel(
          CHANNEL_ID,
          CHANNEL_NAME,
          NotificationManager.IMPORTANCE_LOW
        )
        manager.createNotificationChannel(channel)
      }
    }
  }

  private fun createNotificationBuilder(): NotificationCompat.Builder {
    return NotificationCompat.Builder(context, CHANNEL_ID)
      .setContentTitle(CHANNEL_NAME)
      .setContentText("Connected to the signaling service")
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
  }
}

/**
 * A minimal in-memory [CookieJar] (mirrors the `liquid-auth-android` demo's
 * `Cookies` jar) so the shared [OkHttpClient] persists the `connect.sid`
 * session cookie across the auth requests and the signaling socket for the
 * lifetime of the module.
 */
private class LiquidCookieJar : CookieJar {
  private val storage: MutableList<Cookie> = mutableListOf()

  @Synchronized
  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    for (cookie in cookies) {
      storage.removeAll {
        it.name == cookie.name && it.domain == cookie.domain && it.path == cookie.path
      }
      storage.add(cookie)
    }
  }

  @Synchronized
  override fun loadForRequest(url: HttpUrl): List<Cookie> {
    val now = System.currentTimeMillis()
    storage.removeAll { it.expiresAt < now }
    return storage.filter { it.matches(url) }
  }
}
