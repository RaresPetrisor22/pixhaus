import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router';

import { api, describe, type Asset, type Gallery as GalleryRecord, type Page } from '../api';
import { Blurhash } from '../blurhash';
import { Hero } from '../hero';
import { StarIcon } from '../icons';
import { Lightbox } from '../lightbox';
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
  const [open, setOpen] = useState<number | null>(null);
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

  // Only finished photos can be opened, so the lightbox walks those.
  const ready = assets.filter((asset) => asset.status === 'ready');

  // Clamped, because the arrow keys fire at both ends where the buttons hide.
  const step = useCallback(
    (delta: number) =>
      setOpen((at) => {
        if (at === null) return at;
        const next = at + delta;
        return next < 0 || next >= ready.length ? at : next;
      }),
    [ready.length],
  );
  const close = useCallback(() => setOpen(null), []);

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
              onOpen={() => setOpen(ready.findIndex((one) => one.id === asset.id))}
              onCover={() => void setCover(asset)}
              onRemove={() => void remove(asset)}
            />
          ))}
        </div>

        {assets.length === 0 && pending.length === 0 && (
          <p className="pb-16 text-sm text-neutral-500">No photos yet.</p>
        )}
      </div>

      {open !== null && ready[open] && (
        // The photographer plane sends the cookie, so the API's 302 to the
        // presigned URL is enough; no fetch first.
        <Lightbox
          src={`/api/assets/${ready[open].id}/renditions/preview`}
          alt={ready[open].originalFilename}
          position={`${open + 1} / ${ready.length}`}
          hasPrev={open > 0}
          hasNext={open < ready.length - 1}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onClose={close}
        />
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

  const round =
    'grid place-items-center rounded-full border border-white/25 bg-black/40 text-white opacity-0 backdrop-blur transition duration-300 group-hover:opacity-100 hover:bg-black/70';

  return (
    <figure
      className={`group relative mb-3 break-inside-avoid overflow-hidden rounded-md bg-neutral-200 ${
        asset.status === 'ready' ? 'cursor-pointer' : ''
      }`}
      style={{ aspectRatio: ratio }}
      title={asset.originalFilename}
      onClick={asset.status === 'ready' ? onOpen : undefined}
    >
      {asset.blurhash && (
        <Blurhash hash={asset.blurhash} className="absolute inset-0 h-full w-full" />
      )}
      {asset.status === 'ready' && (
        <img
          src={`/api/assets/${asset.id}/renditions/grid`}
          alt={asset.originalFilename}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
        />
      )}

      {/* Darkens the edges on hover, so a photo answers the pointer without
          anything being drawn on top of it. */}
      {asset.status === 'ready' && (
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.45)_100%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
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
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        aria-label="Delete photo"
        className={`absolute top-3 right-3 h-9 w-9 text-lg leading-none ${round}`}
      >
        ×
      </button>

      {asset.status === 'ready' && !isCover && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCover();
          }}
          aria-label="Make this the cover photo"
          className={`absolute bottom-3 left-3 h-9 w-9 ${round}`}
        >
          <StarIcon />
        </button>
      )}
      {isCover && (
        <span className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-[0.7rem] tracking-[0.15em] text-neutral-900 uppercase backdrop-blur">
          <StarIcon className="h-3.5 w-3.5" />
          Cover
        </span>
      )}
    </figure>
  );
}
