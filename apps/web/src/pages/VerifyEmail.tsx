import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';

import { api, describe } from '../api';
import { Button, Card, Field, Notice } from '../ui';

type State = { kind: 'verifying' } | { kind: 'verified' } | { kind: 'failed'; message: string };

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<State>(
    token ? { kind: 'verifying' } : { kind: 'failed', message: 'This link is missing its token.' },
  );
  // The token is single-use, and StrictMode runs effects twice in development.
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;

    api
      .post('/api/auth/verify-email', { token })
      .then(() => setState({ kind: 'verified' }))
      .catch((err) => setState({ kind: 'failed', message: describe(err) }));
  }, [token]);

  if (state.kind === 'verifying') {
    return <Card title="Verifying…">{null}</Card>;
  }

  if (state.kind === 'verified') {
    return (
      <Card title="Email verified">
        <Notice tone="info">Your studio is ready.</Notice>
        <Link to="/login" className="text-sm underline">
          Sign in
        </Link>
      </Card>
    );
  }

  return (
    <Card title="That link did not work">
      <Notice tone="error">{state.message}</Notice>
      <Resend />
    </Card>
  );
}

function Resend() {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/auth/resend-verification', {
        email: new FormData(event.currentTarget).get('email'),
      });
    } finally {
      // The API answers the same way whether or not the address exists.
      setDone(true);
    }
  }

  if (done) {
    return <Notice tone="info">If that address has a studio, a fresh link is on its way.</Notice>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Field label="Send a new link to" name="email" type="email" autoComplete="email" required />
      <Button type="submit" variant="secondary" disabled={busy}>
        Resend
      </Button>
    </form>
  );
}
