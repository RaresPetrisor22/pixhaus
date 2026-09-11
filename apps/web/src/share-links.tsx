import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api, describe, type Grant, type IssuedGrant } from './api';
import { Button, Field, Notice } from './ui';

function inThirtyDays(): string {
  return new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
}

export function ShareLinks({ galleryId, onShared }: { galleryId: string; onShared: () => void }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [issued, setIssued] = useState<IssuedGrant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(
    () =>
      api
        .get<Grant[]>(`/api/galleries/${galleryId}/grants`)
        .then(setGrants)
        .catch((err) => setError(describe(err))),
    [galleryId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function share(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<IssuedGrant>(`/api/galleries/${galleryId}/grants`, {
        audienceEmail: form.get('audienceEmail'),
        rights: form.get('download') ? ['view', 'download'] : ['view'],
        expiresAt: new Date(String(form.get('expiresAt'))).toISOString(),
        ...(form.get('label') ? { label: form.get('label') } : {}),
      });
      setIssued(result);
      setCopied(false);
      onShared();
      await load();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(grant: Grant) {
    await api.delete(`/api/grants/${grant.id}`);
    await load();
  }

  const link = issued ? `${window.location.origin}/g/${issued.token}` : null;

  return (
    <details className="rounded-md border border-neutral-200">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        Share {grants.length > 0 && `· ${grants.length} link${grants.length === 1 ? '' : 's'}`}
      </summary>

      <div className="space-y-4 border-t border-neutral-200 px-4 py-4">
        <form onSubmit={share} className="grid gap-3 sm:grid-cols-2">
          <Field label="Send to" name="audienceEmail" type="email" required />
          <Field
            label="Expires"
            name="expiresAt"
            type="date"
            defaultValue={inThirtyDays()}
            required
          />
          <Field
            label="Label"
            name="label"
            placeholder="Bride's parents"
            hint="Only you see this."
          />
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="download" defaultChecked />
            Allow downloads
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create link'}
            </Button>
          </div>
        </form>

        {error && <Notice tone="error">{error}</Notice>}

        {link && (
          <Notice tone="info">
            <p className="mb-2">
              Emailed to <strong>{issued?.grant.audienceEmail}</strong>. The link is shown once —
              the server keeps only a hash of it.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-white px-2 py-1 text-xs">{link}</code>
              <Button
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </Notice>
        )}

        {grants.length > 0 && (
          <ul className="divide-y divide-neutral-200 text-sm">
            {grants.map((grant) => (
              <li key={grant.id} className="flex items-center justify-between gap-4 py-2">
                <div className="min-w-0">
                  <div className="truncate">
                    {grant.audienceEmail}
                    {grant.label && <span className="text-neutral-500"> · {grant.label}</span>}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {grant.rights.join(' + ')} · expires{' '}
                    {new Date(grant.expiresAt).toLocaleDateString()}
                    {grant.lastSeenAt
                      ? ` · opened ${new Date(grant.lastSeenAt).toLocaleDateString()}`
                      : ' · not opened yet'}
                  </div>
                </div>
                {grant.revokedAt ? (
                  <span className="text-xs text-neutral-500">revoked</span>
                ) : (
                  <Button variant="secondary" onClick={() => void revoke(grant)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
