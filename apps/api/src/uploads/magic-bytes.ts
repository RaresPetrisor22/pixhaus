import type { AcceptedContentType } from './content-types';

/**
 * The only content check in the system. A presigned PUT signs the content-type
 * HEADER, which forces the uploader to say "image/jpeg" — it does not make the
 * bytes an image. This is where that claim gets tested.
 */

/** Enough for every signature below;*/
export const MAGIC_BYTES_NEEDED = 64;

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) {
    return false;
  }
  return bytes.every((byte, i) => buffer[offset + i] === byte);
}

function ascii(buffer: Buffer, offset: number, length: number): string {
  return buffer.length < offset + length ? '' : buffer.toString('latin1', offset, offset + length);
}

export function sniffImageType(buffer: Buffer): AcceptedContentType | null {
  // SOI marker, then any marker byte.
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  // The 8-byte PNG signature. The CRLF/EOF bytes exist to detect FTP mangling.
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  // RIFF container; the form type at offset 8 is what makes it WebP.
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') {
    return 'image/webp';
  }

  // ISO-BMFF: a size field, then 'ftyp', then the brand.
  if (ascii(buffer, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(buffer, 8, 4))) {
    return 'image/avif';
  }

  // Byte order mark, then 42. Little- and big-endian spellings.
  if (
    startsWith(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(buffer, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return 'image/tiff';
  }

  return null;
}
