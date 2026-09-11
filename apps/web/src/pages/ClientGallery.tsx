import { useEffect, useState } from 'react';

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
import { Card, Notice } from '../ui';

type State =
  | { kind: 'loading' }
  | { kind: 'no-badge' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; title: string; assets: ClientAsset[] };

async function loadAll(token: string): Promise<{ title: string; assets: ClientAsset[] }> {
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

  return { title: first.gallery.title, assets };
}

export default function ClientGallery() {
  const [state, setState] = useState<State>(() =>
    bearer() ? { kind: 'loading' } : { kind: 'no-badge' },
  );
  const [preview, setPreview] = useState<string | null>(null);
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

  async function open(asset: ClientAsset) {
    try {
      const { url } = await api.get<SignedUrl>(
        `/api/client/assets/${asset.id}/renditions/preview`,
        { bearer: bearer() ?? '' },
      );
      setPreview(url);
    } catch (err) {
      setState({ kind: 'failed', message: describe(err) });
    }
  }

  async function download(asset: ClientAsset) {
    try {
      const { url } = await api.post<SignedUrl>(
        `/api/client/assets/${asset.id}/download`,
        undefined,
        { bearer: bearer() ?? '' },
      );
      // Storage answers with content-disposition: attachment, so this saves
      // rather than navigating away.
      window.location.href = url;
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
    <section className="mx-auto mt-10 max-w-6xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{state.title}</h1>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
        {state.assets.map((asset) => (
          <figure
            key={asset.id}
            className="group relative overflow-hidden rounded-md bg-neutral-200"
            style={{
              aspectRatio:
                asset.width && asset.height ? `${asset.width} / ${asset.height}` : '3 / 2',
            }}
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
                onClick={() => void open(asset)}
                className="absolute inset-0 h-full w-full cursor-zoom-in object-cover"
              />
            )}
            {canDownload && (
              <button
                type="button"
                onClick={() => void download(asset)}
                className="absolute right-1 bottom-1 hidden rounded bg-black/60 px-2 py-1 text-xs text-white group-hover:block"
              >
                Download
              </button>
            )}
          </figure>
        ))}
      </div>

      {state.assets.length === 0 && (
        <p className="text-sm text-neutral-500">No photos in this gallery yet.</p>
      )}

      {preview && (
        <div
          onClick={() => setPreview(null)}
          className="fixed inset-0 z-10 grid cursor-zoom-out place-items-center bg-black/80 p-4"
        >
          <img src={preview} alt="" className="max-h-full max-w-full" />
        </div>
      )}
    </section>
  );
}
