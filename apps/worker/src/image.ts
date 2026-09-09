import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { RenditionKind } from '@pixhaus/storage';
import { encode as encodeBlurhash } from 'blurhash';
import sharp, { type Sharp } from 'sharp';

/**
 * Everything the worker derives from one original, and nothing about where any
 * of it is stored. 
 * 
/** What every rendition is, matching `renditions.format`'s CHECK. */
export const RENDITION_CONTENT_TYPE = 'image/webp';

/**
 * `longestEdge` is a bound on both dimensions, applied with `fit: 'inside'`, so
 * a portrait and a landscape frame of the same size cost the same to decode.
 */
export const RENDITION_SPECS: readonly {
  kind: RenditionKind;
  longestEdge: number;
  quality: number;
}[] = [
  { kind: 'thumb', longestEdge: 320, quality: 80 },
  { kind: 'grid', longestEdge: 800, quality: 80 },
  { kind: 'preview', longestEdge: 2048, quality: 82 },
];

export type DerivedRendition = {
  kind: RenditionKind;
  body: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
};

export type DerivedAsset = {
  /** SHA-256 of the original, hex. `assets.content_hash` CHECKs length 64. */
  contentHash: string;
  /** Of the original, with EXIF orientation applied. */
  width: number;
  height: number;
  blurhash: string;
  renditions: DerivedRendition[];
};

/**
 * Reads the original exactly once and gets both things we need out of that one
 * read: the hash that becomes `content_hash`, and the bytes libvips decodes.
 *
 * Collecting into a Buffer rather than piping the stream into sharp is
 * deliberate. sharp concatenates a stream input into a single Buffer internally
 * before it decodes anything, so this costs no extra memory — and it turns a
 * download that dies halfway into a thrown error rather than a sharp instance
 * that is never `end()`ed and a promise that never settles.
 */
export async function deriveFromStream(source: Readable): Promise<DerivedAsset> {
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];

  for await (const chunk of source) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    chunks.push(buffer);
  }

  return derive(Buffer.concat(chunks), hash.digest('hex'));
}

export async function derive(original: Buffer, contentHash: string): Promise<DerivedAsset> {
  const input = sharp(original, { failOn: 'error' });

  const metadata = await input.metadata();

  const renditions = await Promise.all(RENDITION_SPECS.map((spec) => renderOne(input, spec)));

  return {
    contentHash,
    // `autoOrient`, not `width`/`height`: those are as-stored, and an EXIF
    // orientation of 5–8 means the image a viewer sees is rotated a quarter
    // turn from that.
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
    blurhash: await encodePlaceholder(input),
    renditions,
  };
}

async function renderOne(
  input: Sharp,
  spec: (typeof RENDITION_SPECS)[number],
): Promise<DerivedRendition> {
  const { data, info } = await input
    .clone()
    // No argument: apply whatever EXIF orientation says, rather than ignoring
    // it. With an argument it would be a fixed rotation instead.
    .rotate()
    .resize({
      width: spec.longestEdge,
      height: spec.longestEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .withIccProfile('srgb')
    .webp({ quality: spec.quality })
    .toBuffer({ resolveWithObject: true });

  return {
    kind: spec.kind,
    body: data,
    width: info.width,
    height: info.height,
    sizeBytes: info.size,
  };
}

/**
 * The placeholder the grid paints before any rendition has loaded. 4×3
 * components is blurhash's usual default for a landscape-ish photo, and encodes
 * to ~30 characters.
 */
async function encodePlaceholder(input: Sharp): Promise<string> {
  const { data, info } = await input
    .clone()
    .rotate()
    .resize({ width: 32, height: 32, fit: 'inside' })
    // blurhash's encoder takes RGBA and nothing else, so the alpha channel has
    // to exist even for a JPEG that has none.
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return encodeBlurhash(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
}
