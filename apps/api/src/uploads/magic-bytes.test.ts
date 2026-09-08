import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ACCEPTED_CONTENT_TYPES } from './content-types';
import { sniffImageType } from './magic-bytes';

const pad = (header: number[]) => Buffer.concat([Buffer.from(header), Buffer.alloc(64)]);
const riff = (form: string) =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(form), Buffer.alloc(48)]);
const ftyp = (brand: string) =>
  Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(48)]);

describe('sniffImageType — accepts', () => {
  test('every type the mint-time list allows is recognisable here', () => {
    const samples: Record<string, Buffer> = {
      'image/jpeg': pad([0xff, 0xd8, 0xff, 0xe0]),
      'image/png': pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'image/webp': riff('WEBP'),
      'image/avif': ftyp('avif'),
      'image/tiff': pad([0x49, 0x49, 0x2a, 0x00]),
    };

    // If these ever drift apart, a file could pass the declared-type check and
    // then be unrecognisable at finalize — accepted, then always rejected.
    assert.deepEqual(Object.keys(samples).sort(), [...ACCEPTED_CONTENT_TYPES].sort());

    for (const [expected, buffer] of Object.entries(samples)) {
      assert.equal(sniffImageType(buffer), expected);
    }
  });

  test('TIFF in both byte orders', () => {
    assert.equal(sniffImageType(pad([0x49, 0x49, 0x2a, 0x00])), 'image/tiff');
    assert.equal(sniffImageType(pad([0x4d, 0x4d, 0x00, 0x2a])), 'image/tiff');
  });

  test('AVIF sequence brand', () => {
    assert.equal(sniffImageType(ftyp('avis')), 'image/avif');
  });
});

describe('sniffImageType — rejects', () => {
  test('the attack this exists to stop: text named .jpg', () => {
    assert.equal(sniffImageType(Buffer.from('this is not a photo, it is a text file\n')), null);
  });

  test('other things that are not photos', () => {
    const cases: Record<string, Buffer> = {
      pdf: Buffer.from('%PDF-1.7\n'),
      zip: pad([0x50, 0x4b, 0x03, 0x04]),
      elf: pad([0x7f, 0x45, 0x4c, 0x46]),
      html: Buffer.from('<!doctype html><script>alert(1)</script>'),
      // Not on the accepted list, so it must not sniff as anything.
      gif: Buffer.from('GIF89a' + '\0'.repeat(58)),
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      empty: Buffer.alloc(0),
      zeros: Buffer.alloc(64),
    };

    for (const [name, buffer] of Object.entries(cases)) {
      assert.equal(sniffImageType(buffer), null, name);
    }
  });

  test('a near miss is still a miss', () => {
    // Two of three JPEG bytes, seven of eight PNG bytes.
    assert.equal(sniffImageType(pad([0xff, 0xd8, 0x00])), null);
    assert.equal(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00])), null);
    // RIFF, but a WAV rather than a WebP.
    assert.equal(sniffImageType(riff('WAVE')), null);
    // ftyp, but an MP4.
    assert.equal(sniffImageType(ftyp('mp42')), null);
  });

  test('a truncated read never throws, it just fails to match', () => {
    for (let length = 0; length < 16; length++) {
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).subarray(
        0,
        length,
      );
      assert.doesNotThrow(() => sniffImageType(buffer));
    }
    assert.doesNotThrow(() => sniffImageType(Buffer.from('RIF')));
  });

  test('the signature must be at the start, not merely present', () => {
    // A file that contains JPEG bytes later on is not a JPEG.
    assert.equal(
      sniffImageType(Buffer.concat([Buffer.from('junk'), pad([0xff, 0xd8, 0xff])])),
      null,
    );
  });
});
