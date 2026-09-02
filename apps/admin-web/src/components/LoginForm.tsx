'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BRAND } from '@transportco/config';

/**
 * Operations sign-in.
 *
 * Credentials go to this app's own route handler, which exchanges them for
 * tokens server-side and sets httpOnly cookies. No token ever reaches this
 * component.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });

      const payload = (await response.json()) as { ok: boolean; message?: string };

      if (!response.ok || !payload.ok) {
        setError(payload.message ?? 'Sign-in failed. Check your details and try again.');
        return;
      }

      const next = searchParams.get('next');
      router.push(next && next.startsWith('/') ? next : '/dashboard');
      router.refresh();
    } catch {
      // A network failure is not a credential failure, and saying so avoids an
      // operator retyping a correct password five times.
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-100 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-500 text-lg font-bold text-white">
            {BRAND.monogram}
          </span>
          <div>
            <p className="text-lg font-bold leading-tight text-ink-900">{BRAND.name}</p>
            <p className="text-xs text-ink-500">Operations console</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="identifier">
              Email or phone
            </label>
            <input
              id="identifier"
              className="input"
              autoComplete="username"
              autoFocus
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="amaka@transportco.example"
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="input"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          {error ? (
            <p role="alert" className="rounded-md bg-danger-100 px-3 py-2 text-sm text-danger-700">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="text-center text-xs text-ink-500">
            Staff access only. Every action in this console is recorded.
          </p>
        </form>
      </div>
    </main>
  );
}
