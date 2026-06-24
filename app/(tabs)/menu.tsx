import * as React from 'react';
import { View } from 'react-native';

// Lazily load the menu surface. `MenuScreen` pulls in the keystore /
// wallet-provider chain (via `useProvider`), which must only be evaluated AFTER
// the root layout installs the crypto/buffer polyfills. A static import here
// would evaluate `react-native-keystore` during the startup module-eval phase —
// before those polyfills run — and crash with
// "Base64Module.install is not a function". Deferring to render time keeps the
// keystore import after the polyfills are installed.
const MenuScreen = React.lazy(() =>
  import('@/components/MenuScreen').then((m) => ({ default: m.MenuScreen })),
);

export default function MenuTab() {
  return (
    <React.Suspense fallback={<View className="flex-1 bg-background" />}>
      <MenuScreen />
    </React.Suspense>
  );
}
