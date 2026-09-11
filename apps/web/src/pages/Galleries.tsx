import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { api, describe, type Gallery, type Page } from '../api';
import { useSession } from '../session';
import { Button, Field, Notice } from '../ui';

type GalleryPage = Page<'galleries', Gallery>;

export default function Galleries() {
  const { session } = useSession();
  const navigate = useNavigate();
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    api
      .get<GalleryPage>('/api/galleries')
      .then((page) => {
        setGalleries(page.galleries);
        setCursor(page.nextCursor);
      })
      .catch((err) => setError(describe(err)));
  }, []);

  if (session.status !== 'in') return null;
  const { user, studio } = session.me;

  async function loadMore() {
    const page = await api.get<GalleryPage>(`/api/galleries?cursor=${cursor}`);
    setGalleries((current) => [...current, ...page.galleries]);
    setCursor(page.nextCursor);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const gallery = await api.post<Gallery>('/api/galleries', {
        title: new FormData(event.currentTarget).get('title'),
      });
      navigate(`/galleries/${gallery.id}`);
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  }

  async function resend() {
    await api.post('/api/auth/resend-verification', { email: user.email });
    setResent(true);
  }

  return (
    <section className="mx-auto mt-10 max-w-3xl space-y-6">
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

      <form onSubmit={create} className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="New gallery" name="title" placeholder="Ana & Mihai — wedding" required />
        </div>
        <Button type="submit" disabled={busy}>
          Create
        </Button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}

      <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
        {galleries.map((gallery) => (
          <li key={gallery.id}>
            <Link
              to={`/galleries/${gallery.id}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-neutral-50"
            >
              <span className="font-medium">{gallery.title}</span>
              <span className="flex items-center gap-3 text-xs text-neutral-500">
                <StatusPill status={gallery.status} />
                {new Date(gallery.createdAt).toLocaleDateString()}
              </span>
            </Link>
          </li>
        ))}
        {galleries.length === 0 && !error && (
          <li className="px-4 py-6 text-sm text-neutral-500">No galleries yet.</li>
        )}
      </ul>

      {cursor && (
        <Button variant="secondary" onClick={() => void loadMore()}>
          Load more
        </Button>
      )}
    </section>
  );
}

export function StatusPill({ status }: { status: Gallery['status'] }) {
  const tone = {
    draft: 'bg-neutral-100 text-neutral-600',
    active: 'bg-green-100 text-green-800',
    archived: 'bg-amber-100 text-amber-800',
  }[status];

  return <span className={`rounded-full px-2 py-0.5 ${tone}`}>{status}</span>;
}
