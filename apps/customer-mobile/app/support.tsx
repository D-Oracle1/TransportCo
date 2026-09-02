import { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '@transportco/config';
import { Badge, Banner, Button, Card, Field, Label, Screen, theme } from '@transportco/ui';
import { api, ApiError } from '@/lib/api';

/**
 * In-app support.
 *
 * The categories mirror the reasons customers actually contact a transport
 * company, so a ticket arrives already triaged. A safety report is flagged
 * urgent by the server the moment it lands.
 */
const CATEGORIES = [
  { value: 'driver_did_not_arrive', label: 'Driver did not arrive' },
  { value: 'driver_issue', label: 'Issue with the driver' },
  { value: 'payment_problem', label: 'Payment problem' },
  { value: 'incorrect_charge', label: 'Incorrect charge' },
  { value: 'lost_item', label: 'Lost item' },
  { value: 'trip_issue', label: 'Problem with a trip' },
  { value: 'cancellation', label: 'Cancellation' },
  { value: 'safety_issue', label: 'Safety concern' },
  { value: 'other', label: 'Something else' },
] as const;

interface Ticket {
  id: string;
  reference: string;
  category: string;
  subject: string;
  status: string;
  created_at: string;
}

export default function Support() {
  const router = useRouter();

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value'] | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [banner, setBanner] = useState<{ text: string; tone: 'success' | 'danger' } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void api
      .get<Ticket[]>('/support/tickets')
      .then(setTickets)
      .catch(() => undefined);
  }, []);

  async function submit() {
    if (!category) return;

    setSubmitting(true);
    setBanner(null);

    try {
      const ticket = await api.post<{ reference: string }>('/support/tickets', {
        category,
        subject: subject || CATEGORIES.find((item) => item.value === category)!.label,
        message,
      });

      setBanner({ text: `Ticket ${ticket.reference} created. We will reply shortly.`, tone: 'success' });
      setSubject('');
      setMessage('');
      setCategory(null);
      setTickets(await api.get<Ticket[]>('/support/tickets'));
    } catch (error) {
      setBanner({
        text: error instanceof ApiError ? error.message : 'We could not send that. Please try again.',
        tone: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
      <Screen scroll>
        <Label variant="h1">Support</Label>
        <Label variant="body" tone="secondary" style={{ marginTop: 4 }}>
          Tell us what happened and we will look into it.
        </Label>

        {banner ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Banner message={banner.text} tone={banner.tone} />
          </View>
        ) : null}

        <Card style={{ marginTop: theme.spacing.lg }}>
          <Label variant="bodyStrong">Urgent safety concern?</Label>
          <Label variant="caption" tone="muted" style={{ marginTop: 4, marginBottom: theme.spacing.md }}>
            Call our operations line directly. Someone answers day and night.
          </Label>
          <Button
            label={`Call ${BRAND.supportPhone}`}
            variant="danger"
            onPress={() => Linking.openURL(`tel:${BRAND.supportPhone}`)}
          />
        </Card>

        <Label variant="overline" tone="muted" style={{ marginTop: theme.spacing.xl }}>
          What is this about?
        </Label>

        <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.md }}>
          {CATEGORIES.map((item) => (
            <Pressable key={item.value} onPress={() => setCategory(item.value)}>
              <Card
                style={{
                  padding: theme.spacing.md,
                  borderWidth: category === item.value ? 2 : 1,
                  borderColor: category === item.value ? theme.color.primary : theme.color.border,
                }}
              >
                <Label variant="body">{item.label}</Label>
              </Card>
            </Pressable>
          ))}
        </View>

        {category ? (
          <View style={{ marginTop: theme.spacing.xl }}>
            <Field label="Subject" value={subject} onChangeText={setSubject} placeholder="Short summary" />
            <Field
              label="What happened?"
              value={message}
              onChangeText={setMessage}
              placeholder="Give us the details — trip reference, time, what went wrong."
              multiline
              numberOfLines={5}
              style={{ minHeight: 120, textAlignVertical: 'top', paddingTop: theme.spacing.md }}
            />
            <Button
              label="Send to support"
              onPress={submit}
              loading={submitting}
              disabled={message.trim().length < 10}
            />
          </View>
        ) : null}

        {tickets.length > 0 ? (
          <View style={{ marginTop: theme.spacing['2xl'] }}>
            <Label variant="overline" tone="muted">
              Your tickets
            </Label>
            {tickets.map((ticket) => (
              <Card key={ticket.id} style={{ marginTop: theme.spacing.md, padding: theme.spacing.md }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Label variant="bodyStrong">{ticket.reference}</Label>
                  <Badge
                    label={ticket.status.replace(/_/g, ' ').toLowerCase()}
                    tone={ticket.status === 'RESOLVED' ? 'success' : 'info'}
                  />
                </View>
                <Label variant="caption" tone="muted" style={{ marginTop: 4 }}>
                  {ticket.subject}
                </Label>
              </Card>
            ))}
          </View>
        ) : null}

        <Button
          label="Back"
          variant="ghost"
          onPress={() => router.back()}
          style={{ marginTop: theme.spacing.xl }}
        />
      </Screen>
    </SafeAreaView>
  );
}
