import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '@transportco/config';
import { Badge, Banner, Button, Card, Label, Loading, Screen, theme } from '@transportco/ui';
import { useSession } from '@/lib/session';

export default function Profile() {
  const router = useRouter();
  const { profile, signOut } = useSession();

  if (!profile) return <Loading />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <Screen scroll>
        <Label variant="h1">{profile.fullName}</Label>
        <Label variant="body" tone="secondary" style={{ marginTop: 4 }}>
          {profile.phone}
        </Label>

        {profile.outstandingBalanceMinor > 0 ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner
              tone="danger"
              message={`You owe ${profile.outstandingBalanceLabel}. Settle it to book another ride.`}
            />
            <Button
              label="Settle balance"
              variant="accent"
              onPress={() => router.push('/balance')}
              style={{ marginTop: theme.spacing.sm }}
            />
          </View>
        ) : null}

        <Card style={{ marginTop: theme.spacing.xl }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <View>
              <Label variant="overline" tone="muted">
                Loyalty
              </Label>
              <Label variant="h2">{profile.loyalty.balancePoints.toLocaleString('en-NG')}</Label>
              <Label variant="caption" tone="muted">
                points
              </Label>
            </View>
            <Badge label={profile.loyalty.tier} tone="accent" />
          </View>
        </Card>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <Label variant="overline" tone="muted">
            Your referral code
          </Label>
          <Label variant="h2" style={{ marginTop: 4, letterSpacing: 2 }}>
            {profile.referralCode}
          </Label>
          <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
            Share it — friends can enter it when they sign up.
          </Label>
        </Card>

        <Card style={{ marginTop: theme.spacing.lg }}>
          <Label variant="overline" tone="muted">
            Account
          </Label>
          <Label variant="body" style={{ marginTop: 6 }}>
            {profile.reference}
          </Label>
          <Label variant="caption" tone="muted">
            {profile.totalTrips} completed trips
          </Label>
        </Card>

        <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.md }}>
          <Button label="My trips" variant="secondary" onPress={() => router.push('/trips')} />
          <Button label="Get support" variant="secondary" onPress={() => router.push('/support')} />
          <Button
            label="Sign out"
            variant="ghost"
            onPress={async () => {
              await signOut();
              router.replace('/welcome');
            }}
          />
        </View>

        <Label variant="caption" tone="muted" center style={{ marginTop: theme.spacing['2xl'] }}>
          {BRAND.legalName} · {BRAND.supportPhone}
        </Label>
      </Screen>
    </SafeAreaView>
  );
}
