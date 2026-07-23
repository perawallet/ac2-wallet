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
import foundation.algorand.auth.connect.SignalClient
import foundation.algorand.auth.connect.SignalService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
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
  private val httpClient = OkHttpClient()
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
            activity::class.java
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

    OnDestroy {
      unbindService()
    }
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
