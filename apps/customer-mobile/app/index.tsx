import { Loading } from '@transportco/ui';

/**
 * Launch screen. The root layout's guard decides where to send the customer;
 * this only has to look calm while that happens.
 */
export default function Index() {
  return <Loading message="TransportCo" />;
}
