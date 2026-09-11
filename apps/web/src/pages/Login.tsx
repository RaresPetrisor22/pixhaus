import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';

import { api, describe } from '../api';
import { useSession } from '../session';
import { Button, Card, Field, Notice } from '../ui';

export default function Login() {
  const { session, refresh } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session.status === 'in') return <Navigate to="/galleries" replace />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);

    try {
      await api.post('/api/auth/login', {
        email: form.get('email'),
        password: form.get('password'),
      });
      await refresh();
      navigate('/galleries', { replace: true });
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }

  return (
    <Card title="Sign in">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="text-sm text-neutral-600">
        No studio yet?{' '}
        <Link to="/register" className="underline">
          Create one
        </Link>
      </p>
    </Card>
  );
}
