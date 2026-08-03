import ExpoModulesCore
import UIKit
import WebRTC

/**
 * iOS bindings for the Liquid Auth signaling service.
 *
 * Wraps the vendored `LiquidAuthSDK` signaling stack (ported from
 * `liquid-auth-ios`, see `ios/VENDORED.md`) so wallets can drive the WebRTC
 * signaling handshake from JavaScript. This mirrors the Android module's JS
 * contract: `start`/`connect`/`cancel`/`send`/`sendToChannel`/`disconnect`
 * plus the `onMessage`/`onStateChange`/`onTrack`/`onPresence`/`onLinkError`/
 * `onConnectionStateChange` events.
 *
 * Unlike Android there is no foreground `Service`; the shared
 * `SignalService.shared` singleton owns the connection. Long-lived background
 * execution on iOS is subject to platform constraints (see the consolidation
 * plan's Phase 3 open question).
 */
public class LiquidAuthNativeModule: Module {
  /// A cookie-jar-backed `URLSession` shared by the authenticated Liquid Auth
  /// HTTP exchange (``request``) and — implicitly — the signaling socket, so
  /// the `connect.sid` session cookie set during attestation/assertion is
  /// replayed on the socket handshake. This is the iOS analog of the Android
  /// module's shared `OkHttpClient` + `LiquidCookieJar`.
  ///
  /// The sharing works because it deliberately uses `HTTPCookieStorage.shared`:
  /// Socket.IO-Client-Swift builds its engine session with
  /// `URLSessionConfiguration.default` (which is backed by that same shared
  /// storage) and explicitly replays `session.configuration.httpCookieStorage`
  /// cookies onto the WebSocket upgrade. So nothing has to be threaded through
  /// `SignalClient` — but note the coupling: switching this to a private
  /// `HTTPCookieStorage` would silently unauthenticate the socket.
  private static let httpSession: URLSession = {
    let configuration = URLSessionConfiguration.default
    configuration.httpCookieStorage = HTTPCookieStorage.shared
    configuration.httpCookieAcceptPolicy = .always
    configuration.httpShouldSetCookies = true
    return URLSession(configuration: configuration)
  }()

  /// The signaling origin captured from `start(url:)`, reused as the
  /// `connectToPeer` origin (iOS re-creates the socket per negotiation).
  private var signalUrl: String?
  /// The in-flight `connect` promise, resolved when the first channel opens and
  /// rejected on link-error/abort. Only one negotiation is tracked at a time.
  private var pendingConnect: Promise?

  public func definition() -> ModuleDefinition {
    Name("LiquidAuthNative")

    Events(
      "onMessage",
      "onStateChange",
      "onTrack",
      "onPresence",
      "onLinkError",
      "onConnectionStateChange",
      "onSignalingStateChange"
    )

    /**
     * Generate a random request id.
     */
    Function("generateRequestId") { () -> String in
      UUID().uuidString
    }

    /**
     * Parse a `liquid://<origin>/?requestId=<id>` URI into its `origin` and
     * `requestId` parts.
     */
    Function("parseMessage") { (value: String) -> [String: String] in
      guard let parsed = Self.parseLiquidUri(value) else {
        throw NSError(
          domain: "LiquidAuthNative",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Invalid Liquid Auth URI: \(value)"]
        )
      }
      return ["origin": parsed.origin, "requestId": parsed.requestId]
    }

    /**
     * Start the signaling service and connect the signaling client to the given
     * origin. The origin is reused by `connect`.
     */
    AsyncFunction("start") { (url: String, promise: Promise) in
      self.signalUrl = url
      SignalService.shared.start(
        url: url,
        httpClient: URLSession.shared,
        onPresence: { [weak self] presence in
          self?.sendEvent("onPresence", presence)
        },
        onSignalingState: { [weak self] state in
          self?.sendEvent("onSignalingStateChange", ["state": state])
        }
      )
      promise.resolve(nil)
    }

    /**
     * Connect to a remote peer by `requestId`. `type` is the remote peer type
     * (`"offer"` or `"answer"`). Resolves when the primary data channel opens;
     * rejects with `E_LINK_ERROR` on a refused link or `E_ABORTED` on cancel.
     */
    AsyncFunction("connect") { (
      requestId: String,
      type: String,
      iceServers: [[String: Any]]?,
      options: [String: Any]?,
      promise: Promise
    ) in
      guard let peerType = LiquidAuthPeerType(rawValue: type) else {
        promise.reject("E_INVALID_TYPE", "Invalid peer type '\(type)', expected 'offer' or 'answer'")
        return
      }
      guard let origin = self.signalUrl else {
        promise.reject("E_NOT_STARTED", "Signaling service not started, call start() first")
        return
      }

      self.pendingConnect = promise
      let servers = Self.parseIceServers(iceServers)
      let channels = Self.parseDataChannels(options)

      SignalService.shared.connectToPeer(
        requestId: requestId,
        type: peerType,
        origin: origin,
        iceServers: servers,
        dataChannels: channels,
        onMessage: { [weak self] channel, message in
          self?.sendEvent("onMessage", ["channel": channel, "message": message])
        },
        onStateChange: { [weak self] channel, state in
          var payload: [String: Any] = ["channel": channel]
          if let state { payload["state"] = state }
          self?.sendEvent("onStateChange", payload)
        },
        onLinkError: { [weak self] error in
          guard let self else { return }
          var payload: [String: Any] = ["event": "link-error"]
          if let reason = error.rawReason { payload["reason"] = reason }
          if let requestId = error.requestId { payload["requestId"] = requestId }
          if let message = error.message { payload["message"] = message }
          self.sendEvent("onLinkError", payload)
          if let pending = self.pendingConnect {
            self.pendingConnect = nil
            pending.reject("E_LINK_ERROR", error.errorDescription ?? "Link refused")
          }
        },
        onConnected: { [weak self] in
          guard let self, let pending = self.pendingConnect else { return }
          self.pendingConnect = nil
          pending.resolve(nil)
        },
        onPresence: { [weak self] presence in
          self?.sendEvent("onPresence", presence)
        },
        onConnectionStateChange: { [weak self] state in
          self?.sendEvent("onConnectionStateChange", ["state": state])
        },
        onSignalingState: { [weak self] state in
          self?.sendEvent("onSignalingStateChange", ["state": state])
        }
      )
    }

    /**
     * Abort an in-flight `connect` negotiation. The pending `connect` promise
     * rejects with `E_ABORTED`.
     */
    AsyncFunction("cancel") { (promise: Promise) in
      SignalService.shared.cancel()
      if let pending = self.pendingConnect {
        self.pendingConnect = nil
        pending.reject("E_ABORTED", "Connection aborted")
      }
      promise.resolve(nil)
    }

    /**
     * Snapshot the background service's CURRENT connection so a re-attaching
     * app can hydrate instead of assuming a fresh start. Returns
     * `{ connected, requestId, iceConnectionState, channels, signalingConnected }`.
     * Safe to call before the service is bound (returns `connected: false`).
     */
    Function("getConnectionState") { () -> [String: Any?] in
      return SignalService.shared.getConnectionState()
    }

    /**
     * Re-attach to the ALREADY-live connection without renegotiating: rebind
     * the message/state/presence/link-error/connection-state listeners to this
     * (fresh) JS runtime and re-emit the current channel + ICE state so the app
     * hydrates. Use when [getConnectionState] reports `connected: true` (e.g.
     * after a relaunch that reconnected to the still-running service).
     */
    AsyncFunction("attach") { (options: [String: Any]?, promise: Promise) in
      SignalService.shared.attach(
        onMessage: { [weak self] channel, message in
          self?.sendEvent("onMessage", ["channel": channel, "message": message])
        },
        onStateChange: { [weak self] channel, state in
          var payload: [String: Any] = ["channel": channel]
          if let state { payload["state"] = state }
          self?.sendEvent("onStateChange", payload)
        },
        onPresence: { [weak self] presence in
          self?.sendEvent("onPresence", presence)
        },
        onLinkError: { [weak self] error in
          guard let self else { return }
          var payload: [String: Any] = ["event": "link-error"]
          if let reason = error.rawReason { payload["reason"] = reason }
          if let requestId = error.requestId { payload["requestId"] = requestId }
          if let message = error.message { payload["message"] = message }
          self.sendEvent("onLinkError", payload)
        },
        onConnectionStateChange: { [weak self] state in
          self?.sendEvent("onConnectionStateChange", ["state": state])
        },
        onSignalingState: { [weak self] state in
          self?.sendEvent("onSignalingStateChange", ["state": state])
        },
        queueChannels: Self.parseQueueChannels(options)
      )
      promise.resolve(nil)
    }

    /**
     * Set whether the app is currently online (foregrounded, with its JS
     * listeners attached). The app owns this signal so it — not the library —
     * controls the signaling delivery state. Deliberately does NOT replay the
     * offline queue (a relaunching app flips active before its listeners are
     * rewired); the replay happens when a fresh sink attaches (`connect` /
     * `attach`) or when the app calls `flushQueue` once its listeners are
     * wired.
     */
    Function("setActive") { (active: Bool) in
      SignalService.shared.setActive(active)
    }

    /**
     * Explicitly replay any messages buffered while the app was offline,
     * through the `onMessage` event in arrival order. Call it only once the JS
     * message listeners are wired, so the replay can't race the listener
     * setup. No-op when nothing is buffered.
     *
     * iOS caveat: unlike Android there is no foreground service, so the queue
     * only ever holds messages that arrived while the app was running but
     * marked inactive — never messages from while the app was suspended or
     * killed. See `SignalService`'s offline-queue notes.
     */
    Function("flushQueue") {
      SignalService.shared.flushQueue()
    }

    /**
     * Perform an HTTP request through the module's shared cookie-jar session,
     * so the Liquid Auth session cookie (`connect.sid`) is captured natively
     * and replayed on the signaling socket handshake. Mirrors the Android
     * module's `request`, including its `{ ok, status, statusText, body }`
     * result shape.
     */
    AsyncFunction("request") { (
      url: String,
      method: String,
      headers: [String: String]?,
      body: String?,
      promise: Promise
    ) in
      guard let requestUrl = URL(string: url) else {
        promise.reject("E_REQUEST", "Invalid URL: \(url)")
        return
      }

      let verb = method.uppercased()
      var request = URLRequest(url: requestUrl)
      request.httpMethod = verb
      headers?.forEach { name, value in
        request.setValue(value, forHTTPHeaderField: name)
      }

      // The Liquid Auth server derives the expected WebAuthn origin from the
      // User-Agent. If the caller didn't set one, URLSession would send a
      // default the server can't classify, and attestation/assertion fails —
      // the same trap the Android module documents.
      let hasUserAgent = headers?.keys.contains { $0.caseInsensitiveCompare("User-Agent") == .orderedSame } ?? false
      if !hasUserAgent {
        request.setValue(Self.defaultUserAgent(), forHTTPHeaderField: "User-Agent")
      }

      // Mirror Android: default the body's content type to JSON, and never
      // attach a body to GET/HEAD.
      if verb != "GET", verb != "HEAD" {
        let hasContentType = headers?.keys
          .contains { $0.caseInsensitiveCompare("Content-Type") == .orderedSame } ?? false
        if !hasContentType {
          request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        request.httpBody = (body ?? "").data(using: .utf8)
      }

      Self.httpSession.dataTask(with: request) { data, response, error in
        if let error {
          promise.reject("E_REQUEST", error.localizedDescription)
          return
        }
        guard let httpResponse = response as? HTTPURLResponse else {
          promise.reject("E_REQUEST", "Missing or non-HTTP response for \(url)")
          return
        }
        let status = httpResponse.statusCode
        promise.resolve([
          "ok": (200 ..< 300).contains(status),
          "status": status,
          // URLSession does not expose the raw HTTP reason phrase, so derive
          // the closest equivalent to Android's `response.message`.
          "statusText": HTTPURLResponse.localizedString(forStatusCode: status),
          "body": data.flatMap { String(data: $0, encoding: .utf8) } ?? "",
        ])
      }.resume()
    }

    /**
     * Send a message over the primary (`liquid`) data channel.
     */
    Function("send") { (message: String) in
      SignalService.shared.sendMessage(message)
    }

    /**
     * Send a message over a specific named data channel.
     */
    Function("sendToChannel") { (channel: String, message: String) in
      SignalService.shared.sendMessage(message, to: channel)
    }

    /**
     * Stop the signaling client and tear down the connection.
     */
    AsyncFunction("disconnect") { (promise: Promise) in
      SignalService.shared.stop()
      if let pending = self.pendingConnect {
        self.pendingConnect = nil
        pending.reject("E_ABORTED", "Connection closed")
      }
      promise.resolve(nil)
    }
  }

  // MARK: - HTTP helpers

  /// Build a User-Agent identifying this iOS app to the Liquid Auth server
  /// (e.g. `app.perawallet.ac2-wallet/1.0 (iOS 17.4; iPhone)`), mirroring the
  /// shape the Android module sends.
  ///
  /// ⚠️ UNVERIFIED AGAINST THE SERVER. On Android this string is load-bearing:
  /// the server parses it to resolve the expected WebAuthn origin (an APK
  /// client resolves to `android:apk-key-hash:<hash>`). The equivalent
  /// classification for an iOS client — most likely the associated-domain
  /// origin rather than a bundle-derived one — has not been confirmed against
  /// the Liquid Auth server, so this is a best-effort mirror of the Android
  /// shape. If attestation/assertion fails with an origin mismatch while the
  /// HTTP calls themselves succeed, this is the first thing to change; it is
  /// deliberately the only place the value is constructed.
  private static func defaultUserAgent() -> String {
    let bundle = Bundle.main
    let identifier = bundle.bundleIdentifier ?? "liquid-auth"
    let version = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    let device = UIDevice.current
    return "\(identifier)/\(version) (iOS \(device.systemVersion); \(device.model))"
  }

  // MARK: - Parsing helpers

  /// Extract `options.queueChannels` — the channel labels eligible for offline
  /// buffering — from the JS options map. `nil` (absent) means "all channels",
  /// matching the Android default.
  private static func parseQueueChannels(_ options: [String: Any]?) -> Set<String>? {
    guard let raw = options?["queueChannels"] as? [String] else { return nil }
    return Set(raw)
  }

  /// Parse a `liquid://<host>/?requestId=<id>` URI into its origin + requestId.
  private static func parseLiquidUri(_ uri: String) -> (origin: String, requestId: String)? {
    guard let components = URLComponents(string: uri),
          let host = components.host,
          let requestId = components.queryItems?.first(where: { $0.name == "requestId" })?.value
    else {
      return nil
    }
    return (origin: host, requestId: requestId)
  }

  /// Convert the JS ICE server descriptors into `RTCIceServer`s, defaulting to
  /// a public STUN server when none are provided (mirrors the Android module).
  private static func parseIceServers(_ iceServers: [[String: Any]]?) -> [RTCIceServer] {
    guard let iceServers, !iceServers.isEmpty else {
      return [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
    }
    return iceServers.compactMap { server in
      let urls: [String]
      if let single = server["urls"] as? String {
        urls = [single]
      } else if let many = server["urls"] as? [String] {
        urls = many
      } else {
        return nil
      }
      if urls.isEmpty { return nil }
      if let username = server["username"] as? String,
         let credential = server["credential"] as? String {
        return RTCIceServer(urlStrings: urls, username: username, credential: credential)
      }
      return RTCIceServer(urlStrings: urls)
    }
  }

  /// Convert the JS `options.dataChannels` map into `DataChannelConfig`s,
  /// defaulting to a single `liquid` channel (mirrors the Android module).
  private static func parseDataChannels(_ options: [String: Any]?) -> [String: DataChannelConfig] {
    guard let raw = options?["dataChannels"] as? [String: Any], !raw.isEmpty else {
      return DataChannelConfig.defaultChannels
    }
    var result: [String: DataChannelConfig] = [:]
    for (label, value) in raw {
      let config = value as? [String: Any] ?? [:]
      let packetLifeTime = (config["maxPacketLifeTime"] as? NSNumber)
        ?? (config["maxRetransmitTimeMs"] as? NSNumber)
      result[label] = DataChannelConfig(
        ordered: config["ordered"] as? Bool,
        maxRetransmits: (config["maxRetransmits"] as? NSNumber)?.intValue,
        maxPacketLifeTime: packetLifeTime?.intValue,
        channelProtocol: config["protocol"] as? String,
        negotiated: config["negotiated"] as? Bool,
        channelId: (config["id"] as? NSNumber)?.intValue
      )
    }
    return result
  }
}
