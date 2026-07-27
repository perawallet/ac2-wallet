Pod::Spec.new do |s|
  s.name           = 'LiquidAuthNative'
  s.version        = '1.0.0'
  s.summary        = 'React Native bindings for the Liquid Auth signaling service'
  s.description    = 'Native bindings that expose the Liquid Auth WebRTC signaling service to React Native / Expo apps.'
  s.author         = 'Algorand Foundation'
  s.homepage       = 'https://github.com/algorandfoundation/react-native-liquid-auth'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Native dependencies for the vendored LiquidAuthSDK signaling stack
  # (ported from liquid-auth-ios — see VENDORED.md). Socket.IO drives the
  # signaling transport; WebRTC (stasel/WebRTC binary, module `WebRTC`) provides
  # the peer connection / data channels.
  s.dependency 'Socket.IO-Client-Swift'
  s.dependency 'WebRTC-lib'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_VERSION' => '5.9',
  }

  # Includes both the module bindings and the vendored LiquidAuthSDK/ sources.
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
