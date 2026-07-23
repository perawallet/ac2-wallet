/*
 * Copyright 2025 Algorand Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Foundation
import WebRTC

// MARK: - SignalServiceDelegate

protocol SignalServiceDelegate: AnyObject {
    func signalService(_ service: SignalService, didReceiveStatusUpdate title: String, message: String)
}

// MARK: - SignalService

public class SignalService {
    public static let shared = SignalService()

    weak var delegate: SignalServiceDelegate?
    private var signalClient: SignalClient?
    private var peerClient: PeerApi?
    var dataChannel: RTCDataChannel?
    /// All open data channels keyed by label, so a caller can route a message
    /// to a specific named channel (e.g. `ac2-v1` / `ac2-stream`).
    private var namedDataChannels: [String: RTCDataChannel] = [:]
    private var peerConnection: RTCPeerConnection?
    private var dataChannelDelegates: [RTCDataChannel: DataChannelDelegate] = [:]

    private var messageQueue: [String] = []

    private var lastKnownReferer: String?
    private var isDeepLink: Bool = true

    var currentPeerType: LiquidAuthPeerType? // .offer or .answer

    /// Guards the one-shot `onConnected` callback so it fires exactly once per
    /// `connectToPeer`, when the first data channel reaches the `open` state.
    private var didFireConnected = false

    private init() { }

    // MARK: - Public Methods

    /// Starts the signaling service
    ///
    /// - Parameters:
    ///   - url: The signaling server URL
    ///   - httpClient: URLSession for HTTP communications
    public func start(url: String, httpClient _: URLSession) {
        // Initialize the SignalClient
        signalClient = SignalClient(url: url, service: self)
        signalClient?.connectSocket()
        delegate?.signalService(
            self,
            didReceiveStatusUpdate: "Signal Service",
            message: "Service started successfully."
        )
    }

    /// Stops the signaling service and cleans up resources
    func stop() {
        signalClient?.disconnectSocket()
        signalClient = nil
        peerClient = nil
        dataChannel = nil
        namedDataChannels.removeAll()
        peerConnection = nil
        delegate?.signalService(self, didReceiveStatusUpdate: "Signal Service", message: "Service stopped.")
    }

    /// Disconnects from the signaling service
    func disconnect() {
        signalClient?.disconnectSocket()
        delegate?.signalService(
            self,
            didReceiveStatusUpdate: "Signal Service",
            message: "Disconnected from the signaling server."
        )
    }

    /// Abort an in-flight ``connectToPeer`` negotiation without fully stopping
    /// the service. Mirrors `SignalService.cancel()` in the Android SDK.
    public func cancel() {
        signalClient?.cancel()
    }

    // MARK: - Check if the signaling service is initialized

    var isPeerClientInitialized: Bool {
        peerClient != nil
    }

    /// Connects to a peer using WebRTC signaling.
    ///
    /// The parameters mirror the shared "top-level signal client" shape used by
    /// the JavaScript client and the `react-native-liquid-auth` binding: a
    /// `LiquidAuthPeerType`, an optional map of named `dataChannels`, and
    /// channel-labeled message/state callbacks.
    ///
    /// - Parameters:
    ///   - requestId: Unique identifier for the peer connection
    ///   - type: The remote peer type (`.offer` or `.answer`)
    ///   - origin: Origin domain for the connection
    ///   - iceServers: ICE servers for NAT traversal
    ///   - dataChannels: Named data channels to open when acting as the offerer
    ///     (`.answer`). Defaults to a single `liquid` channel.
    ///   - onMessage: Callback for received messages `(channel, message)`
    ///   - onStateChange: Callback for channel state changes `(channel, state)`
    ///   - onLinkError: Callback for a refused `link` (e.g. room full)
    public func connectToPeer(
        requestId: String,
        type: LiquidAuthPeerType,
        origin: String,
        iceServers: [RTCIceServer],
        dataChannels: [String: DataChannelConfig] = DataChannelConfig.defaultChannels,
        onMessage: @escaping (String, String) -> Void,
        onStateChange: @escaping (String, String?) -> Void,
        onLinkError: ((LinkError) -> Void)? = nil,
        onConnected: (() -> Void)? = nil,
        onPresence: (([String: Any]) -> Void)? = nil,
        onConnectionStateChange: ((String) -> Void)? = nil
    ) {
        currentPeerType = type
        didFireConnected = false

        signalClient?.disconnectSocket()
        signalClient = nil
        namedDataChannels.removeAll()

        Logger.debug("Attempting to connect to peer with requestId: \(requestId), type: \(type.rawValue)")

        // Ensure the socket is connected
        signalClient = SignalClient(url: origin, service: self)
        // Register socket/peer callbacks before connecting so the socket
        // listeners (presence) are attached when the socket is created.
        signalClient?.onPresence = onPresence
        signalClient?.onConnectionStateChange = onConnectionStateChange

        // Wait for socket connection before starting signaling
        signalClient?.onSocketConnected = { [weak self] in
            guard let self else { return }
            Logger.debug("Socket connected, now starting WebRTC signaling.")
            _ = signalClient?.connectToPeer(
                requestId: requestId,
                type: type,
                iceServers: iceServers,
                dataChannels: dataChannels,
                onDataChannelOpen: { [weak self] dataChannel in
                    Logger.debug("SignalService: onDataChannelOpen called with: \(dataChannel.label)")
                    self?.dataChannel = dataChannel
                    self?.namedDataChannels[dataChannel.label] = dataChannel
                    Logger.debug("Data channel is open and ready: \(dataChannel.label)")
                    if dataChannel.readyState == .open {
                        self?.flushMessageQueue()
                    }
                },
                onMessage: { channel, message in
                    onMessage(channel, message)
                },
                onStateChange: { [weak self] channel, state in
                    onStateChange(channel, state)
                    // Resolve the caller's "connected" signal the first time any
                    // channel opens, on either the offerer or responder side.
                    if state == "open", self?.didFireConnected == false {
                        self?.didFireConnected = true
                        onConnected?()
                    }
                },
                onLinkError: onLinkError
            )

            peerClient = signalClient?.peerClient
            peerConnection = peerClient?.peerConnection

            if let peerConnection {
                Logger.debug("Peer connection state: \(peerConnection.connectionState.rawValue)")
            } else {
                Logger.error("Peer connection is nil.")
            }

            delegate?.signalService(
                self,
                didReceiveStatusUpdate: "Peer Connection",
                message: "Connected to peer with request ID: \(requestId)."
            )
        }

        signalClient?.connectSocket()
        Logger.debug("ICE servers: \(iceServers)")
        Logger.debug("Waiting for socket to connect before signaling.")
    }

    /// Sends a message through the data channel
    ///
    /// - Parameter message: The message to send
    public func sendMessage(_ message: String) {
        if let dataChannel, dataChannel.readyState == .open {
            Logger
                .debug(
                    "SignalService: Sending on channel to \(ObjectIdentifier(dataChannel)) label: \(dataChannel.label)"
                )
            let buffer = RTCDataBuffer(data: message.data(using: .utf8)!, isBinary: false)
            dataChannel.sendData(buffer)
            Logger.info("Message sent: \(message)")
        } else if let signalClient {
            // On the offerer side the primary channel is created locally and is
            // tracked by the peer client rather than `dataChannel`; route
            // through the client so sending works on both sides.
            signalClient.sendData(message)
            Logger.info("Message sent via client: \(message)")
        } else {
            Logger.error("sendMessage: Data channel is not available. Queuing message.")
            messageQueue.append(message)
        }
    }

    /// Sends a message over a specific named data channel.
    ///
    /// Mirrors `sendToChannel(label, message)` in the JavaScript client and the
    /// `react-native-liquid-auth` binding, so a caller can route to `ac2-v1` /
    /// `ac2-stream` / `ac2-heartbeat` independently of the primary channel.
    ///
    /// - Parameters:
    ///   - message: The message to send
    ///   - label: The label of the target data channel
    public func sendMessage(_ message: String, to label: String) {
        if let channel = namedDataChannels[label], channel.readyState == .open {
            let buffer = RTCDataBuffer(data: message.data(using: .utf8)!, isBinary: false)
            channel.sendData(buffer)
            Logger.info("Message sent on \(label): \(message)")
        } else if let signalClient {
            // On the offerer side named channels are created locally and tracked
            // by the peer client; route through the client so sending works on
            // both sides.
            signalClient.sendData(message, to: label)
            Logger.info("Message sent on \(label) via client: \(message)")
        } else {
            Logger.error("sendMessage: Data channel '\(label)' is not available.")
        }
    }

    /// Flushes queued messages when the data channel becomes available
    private func flushMessageQueue() {
        guard let dataChannel else { return }
        for message in messageQueue {
            let buffer = RTCDataBuffer(data: message.data(using: .utf8)!, isBinary: false)
            dataChannel.sendData(buffer)
            Logger.info("Flushed queued message: \(message)")
        }
        messageQueue.removeAll()
    }
}
