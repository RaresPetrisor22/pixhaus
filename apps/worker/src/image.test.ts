import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decode as decodeBlurhash, isBlurhashValid } from 'blurhash';
import sharp, { type Exif } from 'sharp';

import { derive, RENDITION_SPECS } from './image.ts';

const HASH = 'a'.repeat(64);

const preview = (derived: Awaited<ReturnType<typeof derive>>): Buffer =>
  derived.renditions.find((r) => r.kind === 'preview')!.body;

type Rgb = { r: number; g: number; b: number };

const RED: Rgb = { r: 200, g: 40, b: 30 };

/** A deterministic flat-colour JPEG — the colour is what the colour test reads. */
function photo(
  width: number,
  height: number,
  options: { exif?: Exif; icc?: string; background?: Rgb } = {},
): Promise<Buffer> {
  let image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: options.background ?? RED,
    },
  });

  if (options.icc) {
    image = image.withIccProfile(options.icc);
  }

  if (options.exif) {
    image = image.withExif(options.exif);
  }

  return image.jpeg().toBuffer();
}

describe('derive — the three renditions', () => {
  test('longest edge is bounded and aspect ratio is kept', async () => {
    const derived = await derive(await photo(4000, 3000), HASH);

    assert.deepEqual(
      derived.renditions.map((r) => [r.kind, r.width, r.height]),
      [
        ['thumb', 320, 240],
        ['grid', 800, 600],
        ['preview', 2048, 1536],
      ],
    );
  });

  test('a portrait original is bounded on its long edge too', async () => {
    const derived = await derive(await photo(1000, 2000), HASH);
    const preview = derived.renditions.find((r) => r.kind === 'preview')!;

    assert.deepEqual([preview.width, preview.height], [1000, 2000]);

    const grid = derived.renditions.find((r) => r.kind === 'grid')!;
    assert.deepEqual([grid.width, grid.height], [400, 800]);
  });

  test('a small original is never upscaled', async () => {
    const derived = await derive(await photo(200, 150), HASH);

    for (const rendition of derived.renditions) {
      assert.deepEqual([rendition.width, rendition.height], [200, 150], rendition.kind);
    }
  });

  test('every rendition is webp, and its recorded size is its real size', async () => {
    const derived = await derive(await photo(1200, 900), HASH);

    for (const rendition of derived.renditions) {
      const meta = await sharp(rendition.body).metadata();

      assert.equal(meta.format, 'webp', rendition.kind);
      assert.equal(rendition.sizeBytes, rendition.body.byteLength, rendition.kind);
    }
  });

  test('the spec table is the source of truth for what gets made', async () => {
    const derived = await derive(await photo(1200, 900), HASH);

    assert.deepEqual(
      derived.renditions.map((r) => r.kind),
      RENDITION_SPECS.map((s) => s.kind),
    );
  });
});

describe('derive — metadata is stripped from derivatives', () => {
  test('EXIF, GPS included, does not travel into a rendition', async () => {
    const original = await photo(800, 600, {
      exif: {
        IFD0: { Make: 'Pixhaus', Model: 'Test Camera' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '44/1 25/1 0/1' },
      },
    });

    // The fixture is only worth anything if the EXIF really is in the original.
    assert.ok((await sharp(original).metadata()).exif, 'fixture has no EXIF');

    const derived = await derive(original, HASH);

    for (const rendition of derived.renditions) {
      const meta = await sharp(rendition.body).metadata();
      assert.equal(meta.exif, undefined, `${rendition.kind} carries EXIF`);
      assert.equal(meta.xmp, undefined, `${rendition.kind} carries XMP`);
    }
  });
});

describe('derive — colour', () => {
  // Saturated green: the channel P3 and sRGB disagree about most, so a missing
  // conversion is loud rather than a rounding difference.
  const WIDE: Rgb = { r: 0, g: 200, b: 100 };

  test('a rendition is tagged sRGB, not handed the original profile', async () => {
    const wide = await photo(400, 300, { icc: 'p3', background: WIDE });
    const derived = await derive(wide, HASH);

    const produced = (await sharp(preview(derived)).metadata()).icc;
    const input = (await sharp(wide).metadata()).icc;

    assert.ok(produced, 'the rendition carries no ICC profile at all');
    assert.ok(input, 'fixture has no ICC profile');
    assert.notDeepEqual(produced, input, 'the P3 profile was carried through unchanged');
  });

  test('and the pixels were rendered into sRGB, not just relabelled', async () => {
    const wide = await photo(400, 300, { icc: 'p3', background: WIDE });
    const derived = await derive(wide, HASH);

    // The same resize with the input's profile kept instead of converted. If
    // the ICC transform were a no-op the two would agree.
    const untransformed = await sharp(wide)
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .keepIccProfile()
      .webp({ quality: 82 })
      .toBuffer();

    // keepIccProfile on the way back in as well, or sharp colour-manages the
    // read and converts the control to sRGB behind our backs — which would
    // make the two agree no matter what the pipeline did.
    const converted = await sharp(preview(derived)).keepIccProfile().raw().toBuffer();
    const kept = await sharp(untransformed).keepIccProfile().raw().toBuffer();

    const delta = Math.max(
      Math.abs(converted[0] - kept[0]),
      Math.abs(converted[1] - kept[1]),
      Math.abs(converted[2] - kept[2]),
    );

    // Well clear of what webp's lossy encoding accounts for on a flat colour.
    assert.ok(delta > 8, `pixels moved by only ${delta} — the ICC transform did not run`);
  });
});

describe('derive — orientation', () => {
  test('EXIF orientation is applied, and the recorded dimensions follow it', async () => {
    // 6 means "rotate 90° clockwise to display", so a 1200×900 file is a
    // 900×1200 photo. withMetadata, not withExif: sharp owns the Orientation
    // tag and writes it from this option only.
    const rotated = await sharp(await photo(1200, 900))
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const derived = await derive(rotated, HASH);

    assert.deepEqual([derived.width, derived.height], [900, 1200]);

    const grid = derived.renditions.find((r) => r.kind === 'grid')!;
    assert.deepEqual([grid.width, grid.height], [600, 800]);
  });

  test('without an orientation tag the dimensions are as stored', async () => {
    const derived = await derive(await photo(1200, 900), HASH);

    assert.deepEqual([derived.width, derived.height], [1200, 900]);
  });
});

describe('derive — the placeholder', () => {
  test('blurhash encodes, decodes, and carries the original colour', async () => {
    const derived = await derive(await photo(1200, 900), HASH);

    assert.equal(isBlurhashValid(derived.blurhash).result, true, derived.blurhash);

    // The fixture is a flat red, so the decoded placeholder should be reddish —
    // proof the pixels reached the encoder in RGBA order rather than BGRA.
    const pixels = decodeBlurhash(derived.blurhash, 8, 8);
    assert.ok(pixels[0] > pixels[1] && pixels[0] > pixels[2], 'placeholder is not red');
  });
});

describe('derive — the hash is passed through untouched', () => {
  test('content_hash is whatever the caller streamed, not something re-derived', async () => {
    const derived = await derive(await photo(400, 300), HASH);

    assert.equal(derived.contentHash, HASH);
  });
});
