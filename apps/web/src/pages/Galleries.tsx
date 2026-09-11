import { useState } from 'react';

import { api } from '../api';
import { useSession } from '../session';
import { Button, Notice } from '../ui';

// Placeholder until M3.6.2. What it already does is the part that matters for
// the way in: tells an unverified account why it cannot create anything yet.
export default function Galleries() {
  const { session } = useSession();
  const [resent, setResent] = useState(false);

  if (session.status !== 'in') return null;
  const { user, studio } = session.me;

  async function resend() {
    await api.post('/api/auth/resend-verification', { email: user.email });
    setResent(true);
  }

  return (
    <section className="mx-auto mt-12 max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{studio.name}</h1>
      {!user.emailVerified && (
        <Notice tone="info">
          <div className="flex items-center justify-between gap-4">
            <span>Verify your email to create galleries and share links.</span>
            {resent ? (
              <span className="text-xs">Sent.</span>
            ) : (
              <Button variant="secondary" onClick={() => void resend()}>
                Resend link
              </Button>
            )}
          </div>
        </Notice>
      )}
      <p className="text-neutral-600">Galleries arrive in the next step.</p>
    </section>
  );
}
