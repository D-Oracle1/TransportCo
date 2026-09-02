import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthenticatedSession } from '@transportco/types';
import { api, tokenStore } from './api';
import { locationReporter, type ReportingState } from './location';

/**
 * Driver session.
 *
 * Also owns the driver's operational state, because availability and location
 * reporting are one concept: going online starts reporting, going offline stops
 * it. Splitting them is how you end up with a driver marked available whose
 * phone stopped reporting an hour ago.
 */

interface DriverProfile {
  fullName: string;
  state: ReportingState | 'ON_BREAK' | 'SUSPENDED' | 'ONLINE';
  rating: number | null;
  totalTrips: number;
  vehicle: { plateNumber: string; make: string | null; model: string | null } | null;
}

interface Dashboard {
  driver: DriverProfile;
  today: { trips: number; distanceMetres: number };
  activeTrips: Array<{
    id: string;
    reference: string;
    status: string;
    pickup_address: string;
    destination_address: string;
    final_fare_minor: number | null;
    payment_method: string | null;
    customer_name: string;
  }>;
  upcomingTrips: Array<{
    id: string;
    reference: string;
    scheduled_pickup_at: string;
    pickup_address: string;
    destination_address: string;
    customer_name: string;
  }>;
}

interface SessionValue {
  status: 'loading' | 'authenticated' | 'anonymous';
  dashboard: Dashboard | null;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setAvailability: (state: 'OFFLINE' | 'AVAILABLE' | 'ON_BREAK') => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/** Maps trip status to the location cadence that trip stage deserves. */
function reportingStateFor(dashboard: Dashboard | null): ReportingState {
  if (!dashboard) return 'OFFLINE';

  const active = dashboard.activeTrips[0];

  if (active) {
    switch (active.status) {
      case 'TRIP_STARTED':
        return 'ON_TRIP';
      case 'DRIVER_EN_ROUTE':
        return 'PICKING_UP';
      case 'DRIVER_ARRIVED':
        return 'ARRIVED';
      default:
        return 'ASSIGNED';
    }
  }

  return dashboard.driver.state === 'OFFLINE' || dashboard.driver.state === 'SUSPENDED'
    ? 'OFFLINE'
    : 'AVAILABLE';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionValue['status']>('loading');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<Dashboard>('/drivers/me/dashboard');
      setDashboard(next);
      setStatus('authenticated');

      // Cadence follows the trip, automatically.
      locationReporter.setState(reportingStateFor(next), next.activeTrips[0]?.id ?? null);
    } catch {
      await tokenStore.clear();
      setDashboard(null);
      setStatus('anonymous');
      locationReporter.stop();
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const { access, refresh: refreshToken } = await tokenStore.get();
      if (!access && !refreshToken) {
        setStatus('anonymous');
        return;
      }
      await refresh();
    })();
  }, [refresh]);

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      const session = await api.public.post<AuthenticatedSession>('/auth/login', { identifier, password });
      await tokenStore.set(session.tokens.accessToken, session.tokens.refreshToken);
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    locationReporter.stop();
    const { refresh: refreshToken } = await tokenStore.get();
    if (refreshToken) {
      await api.public.post('/auth/logout', { refreshToken }).catch(() => undefined);
    }
    await tokenStore.clear();
    setDashboard(null);
    setStatus('anonymous');
  }, []);

  const setAvailability = useCallback(
    async (next: 'OFFLINE' | 'AVAILABLE' | 'ON_BREAK') => {
      if (next !== 'OFFLINE') {
        const permission = await locationReporter.requestPermissions();
        if (!permission.granted) {
          throw new Error('Location permission is required before you can go online.');
        }
      }

      await api.post('/drivers/me/state', { state: next });
      await refresh();
    },
    [refresh],
  );

  const value = useMemo<SessionValue>(
    () => ({ status, dashboard, signIn, signOut, refresh, setAvailability }),
    [status, dashboard, signIn, signOut, refresh, setAvailability],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
