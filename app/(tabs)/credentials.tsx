import * as React from 'react';
import { View } from 'react-native';

// Lazily load the credentials surface. `CredentialsScreen` pulls in the
// keystore / wallet-provider chain (via `useProvider`), which must only be
// evaluated AFTER the root layout installs the crypto/buffer polyfills. A
// static import here would evaluate `react-native-keystore` during startup
// module evaluation — before those polyfills run — and crash with
// "Base64Module.install is not a function". Deferring to render time keeps the
// keystore import after polyfills are installed.
const CredentialsScreen = React.lazy(() =>
  import('@/components/CredentialsScreen').then((m) => ({ default: m.CredentialsScreen })),
);

export default function CredentialsTab() {
  return (
    <React.Suspense fallback={<View className="flex-1 bg-background" />}>
      <CredentialsScreen />
    </React.Suspense>
  );
}
