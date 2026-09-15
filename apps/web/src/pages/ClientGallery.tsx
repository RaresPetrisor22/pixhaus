import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  api,
  describe,
  type ClientAsset,
  type ClientGalleryPage,
  type SignedUrl,
} from '../api';
import { Blurhash } from '../blurhash';
import { badge, bearer, clearBadge } from '../client';
import { Hero } from '../hero';
import { DownloadIcon } from '../icons';
import { Lightbox } from '../lightbox';
import { Card, Notice } from '../ui';

type State =
  | { kind: 'loading' }
  | { kind: 'no-badge' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; title: string; coverUrl: string | null; assets: ClientAsset[] };

type Loaded = { title: string; coverUrl: string | null; assets: ClientAsset[] };

async function loadAll(token: string): Promise<Loaded> {
  const options = { bearer: token };
  const first = await api.get<ClientGalleryPage>('/api/client/gallery?limit=50', options);
  const assets = [...first.assets];
  let cursor = first.nextCursor;

  while (cursor) {
    const page = await api.get<ClientGalleryPage>(
      `/api/client/gallery?limit=50&cursor=${cursor}`,
      options,
    );
    assets.push(...page.assets);
    cursor = page.nextCursor;
  }

  return { title: first.gallery.title, coverUrl: first.gallery.coverUrl, assets };
}

export default function ClientGallery() {
  const [state, setState] = useState<State>(() =>
    bearer() ? { kind: 'loading' } : { kind: 'no-badge' },
  );
  const [open, setOpen] = useState<number | null>(null);
  // Presigned preview URLs, kept so arrowing back and forth costs one round
  // trip per photo rather than one per keypress.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const photos = useRef<HTMLDivElement>(null);
  const canDownload = badge()?.rights.includes('download') ?? false;

  useEffect(() => {
    const token = bearer();
    if (!token) return;

    loadAll(token)
      .then((loaded) => setState({ kind: 'ready', ...loaded }))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) clearBadge();
        setState({ kind: 'failed', message: describe(err) });
      });
  }, []);

  const assets = state.kind === 'ready' ? state.assets : [];
  const current = open === null ? undefined : assets[open];

  useEffect(() => {
    if (!current || previews[current.id]) return;

    let cancelled = false;
    api
      .get<SignedUrl>(`/api/client/assets/${current.id}/renditions/preview`, {
        bearer: bearer() ?? '',
      })
      .then(({ url }) => {
        if (!cancelled) setPreviews((held) => ({ ...held, [current.id]: url }));
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: 'failed', message: describe(err) });
      });

    return () => {
      cancelled = true;
    };
  }, [current, previews]);

  // Clamped, because the arrow keys fire at both ends where the buttons hide.
  const step = useCallback(
    (delta: number) =>
      setOpen((at) => {
        if (at === null) return at;
        const next = at + delta;
        return next < 0 || next >= assets.length ? at : next;
      }),
    [assets.length],
  );
  const close = useCallback(() => setOpen(null), []);

  async function download(asset: ClientAsset) {
    try {
      const { url } = await api.post<SignedUrl>(
        `/api/client/assets/${asset.id}/download`,
        undefined,
        { bearer: bearer() ?? '' },
      );
      // Storage answers with content-disposition: attachment, so this saves
      // rather than navigating away.
      window.location.assign(url);
    } catch (err) {
      setState({ kind: 'failed', message: describe(err) });
    }
  }

  if (state.kind === 'loading') return null;

  if (state.kind === 'no-badge') {
    return (
      <Card title="Open your link">
        <Notice tone="info">Use the link from your email to open the gallery.</Notice>
      </Card>
    );
  }

  if (state.kind === 'failed') {
    return (
      <Card title="Something went wrong">
        <Notice tone="error">{state.message}</Notice>
      </Card>
    );
  }

  return (
    <section>
      {state.coverUrl && (
        <Hero
          src={state.coverUrl}
          title={state.title}
          onView={() => photos.current?.scrollIntoView({ behavior: 'smooth' })}
        />
      )}

      <h1
        className={`text-sm tracking-[0.2em] text-neutral-700 uppercase ${
          state.coverUrl ? 'py-6' : 'pt-10 pb-6'
        }`}
      >
        {state.title}
      </h1>

      {/* Columns, not a grid: a grid row is as tall as its tallest photo, so
          one portrait shot leaves a hole beside every landscape one. */}
      <div ref={photos} className="columns-[420px] gap-3 pb-16">
        {state.assets.map((asset, index) => (
          <figure
            key={asset.id}
            className="group relative mb-3 cursor-pointer break-inside-avoid overflow-hidden rounded-md bg-neutral-200"
            style={{
              aspectRatio:
                asset.width && asset.height ? `${asset.width} / ${asset.height}` : '3 / 2',
            }}
            onClick={() => setOpen(index)}
          >
            {asset.blurhash && (
              <Blurhash hash={asset.blurhash} className="absolute inset-0 h-full w-full" />
            )}
            {asset.gridUrl && (
              // Straight from storage. No header is possible on an <img>, which
              // is exactly why the gallery page embeds presigned URLs.
              <img
                src={asset.gridUrl}
                alt={asset.filename}
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
              />
            )}

            {/* Darkens the edges on hover, so a photo answers the pointer
                without anything being drawn on top of it. */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.45)_100%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />

            {canDownload && (
              <button
                type="button"
                aria-label={`Download ${asset.filename}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void download(asset);
                }}
                className="absolute right-3 bottom-3 grid h-10 w-10 translate-y-1 place-items-center rounded-full border border-white/25 bg-black/40 text-white opacity-0 backdrop-blur transition duration-300 group-hover:translate-y-0 group-hover:opacity-100 hover:bg-black/70"
              >
                <DownloadIcon className="h-[1.1rem] w-[1.1rem]" />
              </button>
            )}
          </figure>
        ))}
      </div>

      {state.assets.length === 0 && (
        <p className="pb-16 text-sm text-neutral-500">No photos in this gallery yet.</p>
      )}

      {current && open !== null && (
        <Lightbox
          src={previews[current.id] ?? null}
          alt={current.filename}
          position={`${open + 1} / ${assets.length}`}
          hasPrev={open > 0}
          hasNext={open < assets.length - 1}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onClose={close}
          onDownload={canDownload ? () => void download(current) : undefined}
        />
      )}
    </section>
  );
}
