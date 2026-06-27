import { useProvider } from '@/hooks/useProvider';
import { Redirect } from 'expo-router';

// The root gate in `_layout.tsx` ensures this only renders once fonts are
// loaded and the keystore has finished bootstrapping, so all we do here is
// route based on whether the user has any keys.
export default function Index() {
  const { keys } = useProvider();

  if (keys.length > 0) return <Redirect href="/chat" />;
  return <Redirect href="/onboarding" />;
}
