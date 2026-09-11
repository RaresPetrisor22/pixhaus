import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { api, describe, type ClientSession } from '../api';
import { setBadge } from '../client';
import { Card, Notice } from '../ui';

// The magic link. Exchanges the long-lived token for a badge, then leaves this
// URL — replace, not push — so the token is out of the address bar and history.
export default function ClientEntry() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    api
      .post<ClientSession>('/api/client/session', { token })
      .then((session) => {
        setBadge(session);
        navigate('/gallery', { replace: true });
      })
      .catch((err) => setError(describe(err)));
  }, [token, navigate]);

  if (error) {
    return (
      <Card title="This link did not work">
        <Notice tone="error">{error}</Notice>
        <p className="text-sm text-neutral-600">
          Ask whoever sent it for a fresh one — links expire, and can be revoked.
        </p>
      </Card>
    );
  }

  return <Card title="Opening your gallery…">{null}</Card>;
}
