import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';

import { api, describe } from '../api';
import { useSession } from '../session';
import { Button, Card, Field, Notice } from '../ui';

export default function Register() {
  const { session } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (session.status === 'in') return <Navigate to="/galleries" replace />;

  if (sentTo) {
    return (
      <Card title="Check your inbox">
        <Notice tone="info">
          A verification link is on its way to <strong>{sentTo}</strong>. Open it, then sign in.
        </Notice>
        <Link to="/login" className="text-sm underline">
          Go to sign in
        </Link>
      </Card>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));
    const inviteCode = String(form.get('inviteCode') ?? '').trim();
    setBusy(true);
    setError(null);

    try {
      await api.post('/api/auth/register', {
        studioName: form.get('studioName'),
        email,
        password: form.get('password'),
        ...(inviteCode ? { inviteCode } : {}),
      });
      setSentTo(email);
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }

  return (
    <Card title="Create a studio">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Studio name" name="studioName" autoComplete="organization" required />
        <Field label="Email" name="email" type="email" autoComplete="email" required />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          hint="At least 12 characters. A sentence works well."
          required
        />
        <Field
          label="Invite code"
          name="inviteCode"
          autoComplete="off"
          hint="Needed where registration is invite-only."
        />
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create studio'}
        </Button>
      </form>
      <p className="text-sm text-neutral-600">
        Already have one?{' '}
        <Link to="/login" className="underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
