import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthenticatedSession } from '@transportco/types';
import { api, tokenStore } from './api';

/**
 * Session state.
 *
 * Restored from secure storage on launch so a returning customer lands on their
 * home screen rather than a login form. The token itself is never held in React
 * state — only the profile is — so a component tree dump cannot leak it.
 */

interface Profile {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  reference: string;
  referralCode: string;
  totalTrips: number;
  loyalty: { balancePoints: number; tier: string };
  outstandingBalanceMinor: number;
  outstandingBalanceLabel: string;
}

interface SessionValue {
  status: 'loading' | 'authenticated' | 'anonymous';
  profile: Profile | null;
  signIn: (identifier: string, password: string) => Promise<void>;
  completeVerification: (session: AuthenticatedSession) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionValue['status']>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      const me = await api.get<Profile>('/customer/me');
      setProfile(me);
      setStatus('authenticated');
    } catch {
      // A stored token that no longer works (revoked, expired past refresh)
      // means signed out, not an error screen.
      await tokenStore.clear();
      setProfile(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const { access, refresh } = await tokenStore.get();
      if (!access && !refresh) {
        setStatus('anonymous');
        return;
      }
      await loadProfile();
    })();
  }, [loadProfile]);

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      const session = await api.public.post<AuthenticatedSession>('/auth/login', {
        identifier,
        password,
      });
      await tokenStore.set(session.tokens.accessToken, session.tokens.refreshToken);
      await loadProfile();
    },
    [loadProfile],
  );

  const completeVerification = useCallback(
    async (session: AuthenticatedSession) => {
      await tokenStore.set(session.tokens.accessToken, session.tokens.refreshToken);
      await loadProfile();
    },
    [loadProfile],
  );

  const signOut = useCallback(async () => {
    const { refresh } = await tokenStore.get();
    if (refresh) {
      // Best effort: the local session ends either way, but telling the server
      // revokes the refresh token everywhere.
      await api.public.post('/auth/logout', { refreshToken: refresh }).catch(() => undefined);
    }
    await tokenStore.clear();
    setProfile(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ status, profile, signIn, completeVerification, signOut, refreshProfile: loadProfile }),
    [status, profile, signIn, completeVerification, signOut, loadProfile],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
