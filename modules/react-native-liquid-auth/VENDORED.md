# Vendored: react-native-liquid-auth (Expo local module)

This directory is a **vendored copy** of the `react-native-liquid-auth` package,
consumed by `ac2-wallet` as an [Expo local module](https://docs.expo.dev/modules/get-started/#creating-the-local-expo-module)
under `modules/`. It exists so the wallet is a self-contained, buildable app
without a pnpm workspace, a published package, or an externally checked-out
sibling repo.

## Provenance

- **Upstream repo:** https://github.com/algorandfoundation/react-native-liquid-auth
- **Upstream commit:** `1b5d4ca7dc69b11c13a44e0a7696a877eff2a0bc` (`chore: bind connections to service`)
- **Vendored on:** 2026-07-23

## Sync direction (one-way: upstream → copy)

This is a **one-way mirror**. The upstream repo is the source of truth. Do not
make behavioral edits to the native Kotlin/Swift or the `src/` TypeScript here;
change upstream first, then re-vendor. Consistent with the vendor-a-copy
convention (consolidation decisions D1/D7).

## What was copied / trimmed

Copied from upstream (verbatim):

- `src/` — JS/TS API (`index.ts`, `LiquidAuthNativeModule.ts`, `.web.ts`,
  `LiquidAuthNative.types.ts`, `nativeChannel.ts`). Consumed directly by Metro;
  there is **no `build/` step** for a local module.
- `android/` — Kotlin native module + gradle (autolinked from `modules/`).
- `ios/` — Swift native module + `LiquidAuthNative.podspec` + vendored
  `LiquidAuthSDK/` (autolinked from `modules/`).
- `expo-module.config.json` — declares the native module for autolinking.
- `LICENSE`.

Excluded (not needed to build/consume as a local module):

- `node_modules/`, `build/`, `example/`, `internal/`, `pnpm-lock.yaml`, `.git`.
- The upstream `src/__tests__/` (the package's own Jest suite).

The `package.json` here is **trimmed**: `main`/`types` point at `src/index.ts`
(Metro bundles the TypeScript directly), and build scripts / devDependencies /
lockfile are dropped. `name`, `version`, and `peerDependencies` are kept so Expo
autolinking still discovers the module.

## How the wallet reaches it

The bare specifier `react-native-liquid-auth` is mapped to
`modules/react-native-liquid-auth/src` via a Metro resolver alias
(`metro.config.js`), so every existing `require('react-native-liquid-auth')` /
import resolves unchanged. The vendored tree is excluded from the wallet's
`tsc`, `oxlint`, and `oxfmt` (and scoped in Jest via `moduleNameMapper`).

## Known caveat

The iOS podspec pulls `WebRTC-lib`, which can clash with the wallet's
`react-native-webrtc` at `pod install`. This is not introduced by vendoring; it
is resolved when the in-process WebRTC path is retired (Phase 4 cleanup).

## Upgrade path (removing this copy)

When the package is published to a registry, this is a small, mechanical change:
delete `modules/react-native-liquid-auth/`, drop the Metro alias +
`tsconfig`/`oxlint`/`oxfmt`/Jest isolation entries, and add a normal scoped
dependency (e.g. `@algorandfoundation/react-native-liquid-auth`).
