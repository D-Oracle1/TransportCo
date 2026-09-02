import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Loading, theme } from '@transportco/ui';
import { SessionProvider, useSession } from '@/lib/session';

/**
 * Root layout and route guard.
 *
 * Keeps the customer where they belong: signed-out users cannot reach a booking
 * screen, and signed-in users are not shown the welcome screen again on every
 * cold start.
 */
const AUTH_ROUTES = ['welcome', 'sign-in', 'sign-up', 'verify'];

function RouteGuard() {
  const { status } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;

    const first = segments[0] ?? '';
    const inAuthFlow = AUTH_ROUTES.includes(first);

    if (status === 'anonymous' && !inAuthFlow) {
      router.replace('/welcome');
    } else if (status === 'authenticated' && (inAuthFlow || first === '')) {
      router.replace('/home');
    }
  }, [status, segments, router]);

  if (status === 'loading') return <Loading message="Getting things ready" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.color.background },
        animation: 'slide_from_right',
      }}
    />
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <RouteGuard />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
