import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router';

import { api, describe, type Asset, type Gallery as GalleryRecord, type Page } from '../api';
import { Blurhash } from '../blurhash';
import { Hero } from '../hero';
import { ShareLinks } from '../share-links';
import { Notice } from '../ui';
import { uploadFile, type UploadStep } from '../upload';
import { StatusPill } from './Galleries';

type Upload = { name: string; step: UploadStep; error?: string };

const IN_FLIGHT = new Set<Asset['status']>(['pending', 'uploaded', 'processing']);

// Every page of the listing. Fine at demo scale; a virtualized grid is on the
// list for the day a real 500-photo gallery shows up.
async function loadAllAssets(galleryId: string): Promise<Asset[]> {
  const assets: Asset[] = [];
  let cursor: string | null = null;
  do {
    const query = `limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    const page: Page<'assets', Asset> = await api.get(
      `/api/galleries/${galleryId}/assets?${query}`,
    );
    assets.push(...page.assets);
    cursor = page.nextCursor;
  } while (cursor);
  return assets;
}

export default function Gallery() {
  const { id = '' } = useParams();
  const [gallery, setGallery] = useState<GalleryRecord | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const photos = useRef<HTMLDivElement>(null);

  const refreshAssets = useCallback(
    () =>
      loadAllAssets(id)
        .then(setAssets)
        .catch((err) => setError(describe(err))),
    [id],
  );

  useEffect(() => {
    api
      .get<GalleryRecord>(`/api/galleries/${id}`)
      .then(setGallery)
      .catch((err) => setError(describe(err)));
    void refreshAssets();
  }, [id, refreshAssets]);

  // The worker is asynchronous: poll while anything is still on its way.
  useEffect(() => {
    if (!assets.some((asset) => IN_FLIGHT.has(asset.status))) return;
    const timer = setTimeout(() => void refreshAssets(), 1500);
    return () => clearTimeout(timer);
  }, [assets, refreshAssets]);

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    const offset = uploads.length;
    setUploads((current) => [
      ...current,
      ...files.map((f) => ({ name: f.name, step: 'presigning' as const })),
    ]);

    const setStep = (index: number, patch: Partial<Upload>) =>
      setUploads((current) => current.map((u, i) => (i === index ? { ...u, ...patch } : u)));

    // One at a time: simple, and kind to the worker.
    for (const [i, file] of files.entries()) {
      try {
        await uploadFile(id, file, (step) => setStep(offset + i, { step }));
        await refreshAssets();
      } catch (err) {
        setStep(offset + i, { step: 'failed', error: describe(err) });
      }
    }
  }

  async function remove(asset: Asset) {
    await api.delete(`/api/assets/${asset.id}`);
    setAssets((current) => current.filter((a) => a.id !== asset.id));
  }

  async function setCover(asset: Asset) {
    try {
      setGallery(await api.patch(`/api/galleries/${id}`, { coverAssetId: asset.id }));
    } catch (err) {
      setError(describe(err));
    }
  }

  if (error && !gallery) {
    return (
      <section className="mx-auto mt-10 max-w-3xl space-y-4">
        <Notice tone="error">{error}</Notice>
        <Link to="/galleries" className="text-sm underline">
          Back to galleries
        </Link>
      </section>
    );
  }

  if (!gallery) return null;
  const pending = uploads.filter((u) => u.step !== 'done');

  // What the client will see, so the photographer is looking at the real thing
  // while they choose it. Falls back to the first photo until they do.
  const coverId = gallery.coverAssetId ?? assets.find((a) => a.status === 'ready')?.id;

  return (
    <section>
      {coverId && (
        <Hero
          src={`/api/assets/${coverId}/renditions/preview`}
          title={gallery.title}
          subtitle={gallery.coverAssetId ? undefined : 'no cover chosen — showing the first photo'}
          onView={() => photos.current?.scrollIntoView({ behavior: 'smooth' })}
        />
      )}

      <div className="space-y-6 pt-8">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <Link to="/galleries" className="text-sm text-neutral-500 hover:underline">
              ← Galleries
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">{gallery.title}</h1>
          </div>
          <span className="text-xs">
            <StatusPill status={gallery.status} />
          </span>
        </div>

        <ShareLinks
          galleryId={id}
          onShared={() =>
            void api
              .get<GalleryRecord>(`/api/galleries/${id}`)
              .then(setGallery)
              .catch(() => undefined)
          }
        />

        {gallery.status !== 'archived' && (
          <label className="block cursor-pointer rounded-md border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-600 hover:bg-neutral-50">
            Choose photos to upload
            <input type="file" multiple accept="image/*" className="hidden" onChange={onFiles} />
          </label>
        )}

        {error && <Notice tone="error">{error}</Notice>}

        {pending.length > 0 && (
          <ul className="space-y-1 text-sm">
            {pending.map((u, i) => (
              <li key={i} className="flex justify-between text-neutral-600">
                <span className="truncate">{u.name}</span>
                <span className={u.step === 'failed' ? 'text-red-700' : ''}>
                  {u.error ?? u.step}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* Columns, not a grid: a grid row is as tall as its tallest photo, so
          one portrait shot leaves a hole beside every landscape one. */}
        <div ref={photos} className="columns-[340px] gap-3 pb-16">
          {assets.map((asset) => (
            <Tile
              key={asset.id}
              asset={asset}
              isCover={asset.id === gallery.coverAssetId}
              onOpen={() => setPreview(asset)}
              onCover={() => void setCover(asset)}
              onRemove={() => void remove(asset)}
            />
          ))}
        </div>

        {assets.length === 0 && pending.length === 0 && (
          <p className="pb-16 text-sm text-neutral-500">No photos yet.</p>
        )}
      </div>

      {preview && (
        // The photographer plane sends the cookie, so the API's 302 to the
        // presigned URL is enough; no fetch first.
        <div
          onClick={() => setPreview(null)}
          className="fixed inset-0 z-10 grid cursor-zoom-out place-items-center bg-black/80 p-4"
        >
          <img
            src={`/api/assets/${preview.id}/renditions/preview`}
            alt={preview.originalFilename}
            className="max-h-full max-w-full"
          />
        </div>
      )}
    </section>
  );
}

function Tile({
  asset,
  isCover,
  onOpen,
  onCover,
  onRemove,
}: {
  asset: Asset;
  isCover: boolean;
  onOpen: () => void;
  onCover: () => void;
  onRemove: () => void;
}) {
  const ratio = asset.width && asset.height ? `${asset.width} / ${asset.height}` : '3 / 2';

  return (
    <figure
      className="group relative mb-3 break-inside-avoid overflow-hidden rounded-md bg-neutral-200"
      style={{ aspectRatio: ratio }}
      title={asset.originalFilename}
    >
      {asset.blurhash && (
        <Blurhash hash={asset.blurhash} className="absolute inset-0 h-full w-full" />
      )}
      {asset.status === 'ready' && (
        <img
          src={`/api/assets/${asset.id}/renditions/grid`}
          alt={asset.originalFilename}
          loading="lazy"
          onClick={onOpen}
          className="absolute inset-0 h-full w-full cursor-zoom-in object-cover"
        />
      )}
      {asset.status !== 'ready' && (
        <figcaption
          className={`absolute inset-x-0 bottom-0 px-2 py-1 text-xs ${
            asset.status === 'failed' ? 'bg-red-600 text-white' : 'bg-black/50 text-white'
          }`}
        >
          {asset.status === 'failed' ? 'processing failed' : 'processing…'}
        </figcaption>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Delete photo"
        className="absolute top-2 right-2 hidden h-7 w-7 rounded-full bg-black/60 text-white group-hover:block"
      >
        ×
      </button>
      {asset.status === 'ready' && !isCover && (
        <button
          type="button"
          onClick={onCover}
          className="absolute bottom-2 left-2 hidden rounded bg-black/60 px-2 py-1 text-xs text-white group-hover:block"
        >
          Make cover
        </button>
      )}
      {isCover && (
        <span className="absolute bottom-2 left-2 rounded bg-white/90 px-2 py-1 text-xs font-medium text-neutral-900">
          Cover
        </span>
      )}
    </figure>
  );
}
