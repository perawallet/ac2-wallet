/**
 * Side-effect installer for the fatal-error black box (see `fatal-guard.ts`).
 * Imported from the entry point ahead of `expo-router/entry` — import order
 * is what guarantees it observes route-module evaluation errors, since ES
 * import hoisting would defeat an inline call in `index.js`.
 */
import { installFatalGuard } from './fatal-guard';

installFatalGuard();
