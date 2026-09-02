import { Suspense } from 'react';
import { LoginForm } from '@/components/LoginForm';

/**
 * Sign-in page.
 *
 * The form reads `?next=` via `useSearchParams`, which opts a component out of
 * static rendering. Wrapping it in Suspense keeps the shell prerenderable and
 * the form client-side, which is exactly the split we want here.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={<main className="flex min-h-screen items-center justify-center bg-ink-100" />}
    >
      <LoginForm />
    </Suspense>
  );
}
