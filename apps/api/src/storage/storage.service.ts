import { Readable } from 'node:stream';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Env } from '../config/env';

export type ObjectHead = { sizeBytes: number; contentType: string | null; etag: string | null };

export type PresignedUpload = {
  url: string;
  expiresAt: Date;
  headers: Record<string, string>;
};

/**
 * Strips the two characters that could break out of the quoted filename in a
 * Content-Disposition header, plus control characters that could inject one.
 */
function sanitiseFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '').slice(0, 200) || 'download';
}

/** S3 says 404 in several dialects depending on the operation and provider. */
function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  private readonly internal: S3Client;

  /**
   * Signing only. Built on the endpoint the BROWSER can reach, because SigV4
   * signs the Host header — a URL signed for `minio:9000` dies the moment it is
   * pointed at `localhost:9000`..
   */
  private readonly signer: S3Client;

  private readonly bucket: string;
  readonly uploadUrlTtlSeconds: number;
  readonly maxUploadBytes: number;

  constructor(config: ConfigService<Env, true>) {
    const endpoint = config.get('STORAGE_ENDPOINT', { infer: true });
    const publicEndpoint = config.get('STORAGE_PUBLIC_ENDPOINT', { infer: true }) ?? endpoint;

    const common = {
      region: config.get('STORAGE_REGION', { infer: true }),
      forcePathStyle: config.get('STORAGE_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('STORAGE_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('STORAGE_SECRET_KEY', { infer: true }),
      },
    };

    this.internal = new S3Client({ ...common, endpoint });
    this.signer =
      publicEndpoint === endpoint
        ? this.internal
        : new S3Client({ ...common, endpoint: publicEndpoint });

    this.bucket = config.get('STORAGE_BUCKET', { infer: true });
    this.uploadUrlTtlSeconds = config.get('UPLOAD_URL_TTL_SECONDS', { infer: true });
    this.maxUploadBytes = config.get('UPLOAD_MAX_BYTES', { infer: true });
  }

  /**
   * A URL the browser PUTs to directly.
   */
  async presignPut(
    key: string,
    options: { contentLength: number; contentType: string; expiresIn?: number },
  ): Promise<PresignedUpload> {
    const expiresIn = options.expiresIn ?? this.uploadUrlTtlSeconds;

    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentLength: options.contentLength,
        ContentType: options.contentType,
      }),
      { expiresIn, signableHeaders: new Set(['content-length', 'content-type']) },
    );

    return {
      url,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      headers: {
        'content-type': options.contentType,
        'content-length': String(options.contentLength),
      },
    };
  }

  /** Read URL. `downloadFilename` turns a view into a save-as. */
  presignGet(
    key: string,
    options: { expiresIn: number; downloadFilename?: string } = { expiresIn: 300 },
  ): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.downloadFilename
          ? `attachment; filename="${sanitiseFilename(options.downloadFilename)}"`
          : undefined,
      }),
      { expiresIn: options.expiresIn },
    );
  }

  /** Metadata, no body. Null when the object is not there. */
  async head(key: string): Promise<ObjectHead | null> {
    try {
      const result = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      return {
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        etag: result.ETag?.replace(/"/g, '') ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * The first bytes of an object, for magic-byte sniffing. `end` is inclusive,
   * as HTTP ranges are.
   */
  async getRange(key: string, start: number, end: number): Promise<Buffer | null> {
    try {
      const result = await this.internal.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
      );

      return Buffer.from(await result.Body!.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  /** The worker's read of an original. */
  async getStream(key: string): Promise<Readable> {
    const result = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    return result.Body as Readable;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  /**A failed cleanup is logged, not thrown — the reaper retries. */
  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    try {
      await this.internal.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    } catch (error) {
      this.logger.error(
        `failed to delete ${keys.length} object(s): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Readiness: can we reach the bucket, and does it exist. */
  async bucketReachable(): Promise<void> {
    await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}
