import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Loading, theme } from '@transportco/ui';
import { SessionProvider, useSession } from '@/lib/session';

function RouteGuard() {
  const { status } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;

    const first = segments[0] ?? '';

    if (status === 'anonymous' && first !== 'sign-in') {
      router.replace('/sign-in');
    } else if (status === 'authenticated' && (first === 'sign-in' || first === '')) {
      router.replace('/dashboard');
    }
  }, [status, segments, router]);

  if (status === 'loading') return <Loading message="Signing you in" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.color.background },
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
