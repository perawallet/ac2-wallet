/**
 * Side-effect: installs `global.Buffer` (from the `buffer` package). Several
 * `@algorandfoundation/algokit-utils` modules reference a bare global `Buffer`
 * (e.g. `Buffer.from(...)`), which Hermes does not provide by default. MUST be
 * imported before any algokit code is evaluated.
 */
import { Buffer } from 'buffer';

if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}
