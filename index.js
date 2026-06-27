// Custom entry point.
//
// These polyfills MUST be installed before expo-router evaluates any route
// module, because the keystore / wallet-provider import chain captures
// `globalThis.crypto` (via @noble/hashes) and references a bare global `Buffer`
// at module-eval time. Importing them here — ahead of `expo-router/entry` —
// guarantees they run before the route tree (and therefore before any screen
// that statically imports the keystore chain). This is what lets the tab
// screens import their content statically instead of via React.lazy.
import './lib/runtime/install-crypto';
import './lib/runtime/install-buffer';

import 'expo-router/entry';
