Pod::Spec.new do |s|
  s.name           = 'LiquidAuthNative'
  s.version        = '1.0.0'
  s.summary        = 'React Native bindings for the Liquid Auth signaling service'
  s.description    = 'Native bindings that expose the Liquid Auth WebRTC signaling service to React Native / Expo apps.'
  s.author         = 'Algorand Foundation'
  s.homepage       = 'https://github.com/algorandfoundation/react-native-liquid-auth'
  # LOCAL DIVERGENCE (see VENDORED.md): upstream declares 16.4, inherited from
  # liquid-auth-ios' passkey/AuthenticationServices code that this vendored
  # subset does not include. Nothing here is gated on 16.4 (no @available), and
  # the highest minimum among the dependencies is ExpoModulesCore's 15.1.
  # Declaring 16.4 made Expo autolinking skip this pod on the wallet's 15.1
  # platform, so the native module never reached the iOS binary.
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Native dependencies for the vendored LiquidAuthSDK signaling stack
  # (ported from liquid-auth-ios — see VENDORED.md). Socket.IO drives the
  # signaling transport; WebRTC (module `WebRTC`) provides the peer connection /
  # data channels.
  s.dependency 'Socket.IO-Client-Swift'
  # LOCAL DIVERGENCE (see VENDORED.md): upstream uses `WebRTC-lib`, which
  # vendors a `WebRTC.xcframework` whose name collides with the one
  # react-native-webrtc brings in via `JitsiWebRTC`. Reuse the app's existing,
  # version-pinned WebRTC binary instead of linking two same-named frameworks.
  s.dependency 'JitsiWebRTC'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_VERSION' => '5.9',
  }

  # Includes both the module bindings and the vendored LiquidAuthSDK/ sources.
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
