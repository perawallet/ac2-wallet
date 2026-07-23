# Vendored RTC adapter shim — `nativeChannel.ts`

> Provenance note for the Liquid Auth consolidation (see
> `react-native-liquid-auth/docs/CONSOLIDATION_PLAN.md`, decisions **D1** / **D7**).

`lib/ac2/nativeChannel.ts` (`NativeDataChannel` / `NativePeerConnection`) is
**vendored from `react-native-liquid-auth`**, which now owns the canonical copy
so the wallet and any other consumer share the same adapter base. The shims
present the package's *event-based* native background service
(`onMessage` / `onStateChange` / `onConnectionStateChange` / ...) as the
`RTCDataChannel`- and `RTCPeerConnection`-shaped objects the wallet's
connection code (the AC2 SDK client, heartbeat, stream, and
`peerConnectionMonitor`) already consumes.

| | |
| --- | --- |
| **Upstream repo** | `react-native-liquid-auth` |
| **Upstream path** | `src/nativeChannel.ts` |
| **Target commit** | branch `chore/consolidation` (based on `3c2acd9`) |
| **Portion vendored** | The RTC shims only (`NativeDataChannel`, `NativePeerConnection`, `DataChannelReadyState`, `DataChannelMessageEvent`) |

## Sync direction

**Upstream → vendored copy (one-way).** `lib/ac2/nativeChannel.ts` is
**byte-identical** to `react-native-liquid-auth/src/nativeChannel.ts`. Any change
to the shim must be made **upstream** in the package first, then re-copied here;
never edit this copy directly.

Verify the copy is in sync:

```sh
diff -u ../react-native-liquid-auth/src/nativeChannel.ts lib/ac2/nativeChannel.ts
```

## Why a copy (not a package import)

`react-native-liquid-auth` is not yet a resolvable dependency of the wallet
(unpublished `0.0.1`, unscoped, outside the wallet's pnpm workspace). Vendoring a
byte-identical copy keeps `pnpm install` and the Jest suite green today while the
package remains the single source of truth. Replacing this copy with a real
`import { NativeDataChannel, NativePeerConnection } from 'react-native-liquid-auth'`
is an on-device-pass step, once the package is published/scoped (e.g.
`@algorandfoundation/react-native-liquid-auth`) and added as a wallet dependency.

The AC2-specific transport factory that drives these shims
(`lib/ac2/nativeTransport.ts`, `createNativeAc2Transport`) intentionally stays in
the wallet — only the generic RTC shims were upstreamed.
