import type { Readable } from 'node:stream';

import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ObjectStore,
  createS3Client,
  type ObjectHead,
  type ObjectStoreConfig,
} from '@pixhaus/storage';

import { describeError } from '../common/describe-error';
import type { Env } from '../config/env';

export type { ObjectHead };

export type PresignedUpload = {
  url: string;
  expiresAt: Date;
  /** The headers the uploader MUST send. They are signed; anything else fails. */
  headers: Record<string, string>;
};

/**
 * Strips the characters that could break out of the quoted filename in a
 * Content-Disposition header, or inject a second one.
 */
function sanitiseFilename(name: string): string {
  return name.replace(/["\\r\n]/g, '').slice(0, 200) || 'download';
}

/**
 * The API's view of object storage.
 *
 * Reads and writes come from @pixhaus/storage, which the worker uses too, so
 * both sides build keys and talk to the bucket the same way. What lives here is
 * the half only the API does: presigning.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  /** Server-side reads and writes, over the endpoint the API can reach. */
  private readonly store: ObjectStore;

  /**
   * Signing only, built on the endpoint the BROWSER can reach. SigV4 signs the
   * Host header, so a URL signed for `minio:9000` dies the moment it is pointed
   * at `localhost:9000`.
   */
  private readonly signer: S3Client;

  private readonly bucket: string;
  readonly uploadUrlTtlSeconds: number;
  readonly maxUploadBytes: number;

  constructor(config: ConfigService<Env, true>) {
    const shared: Omit<ObjectStoreConfig, 'endpoint'> = {
      region: config.get('STORAGE_REGION', { infer: true }),
      bucket: config.get('STORAGE_BUCKET', { infer: true }),
      accessKeyId: config.get('STORAGE_ACCESS_KEY', { infer: true }),
      secretAccessKey: config.get('STORAGE_SECRET_KEY', { infer: true }),
      forcePathStyle: config.get('STORAGE_FORCE_PATH_STYLE', { infer: true }),
    };

    const endpoint = config.get('STORAGE_ENDPOINT', { infer: true });
    const publicEndpoint = config.get('STORAGE_PUBLIC_ENDPOINT', { infer: true }) ?? endpoint;

    const internal = createS3Client({ ...shared, endpoint });
    this.store = new ObjectStore(internal, shared.bucket);
    this.signer =
      publicEndpoint === endpoint
        ? internal
        : createS3Client({ ...shared, endpoint: publicEndpoint });

    this.bucket = shared.bucket;
    this.uploadUrlTtlSeconds = config.get('UPLOAD_URL_TTL_SECONDS', { infer: true });
    this.maxUploadBytes = config.get('UPLOAD_MAX_BYTES', { infer: true });
  }

  /**
   * A URL the browser PUTs to directly.
   *
   * signableHeaders is what puts content-length and content-type INSIDE the
   * signature rather than leaving them to the uploader — send different ones and
   * storage rejects the request before a byte of body is stored.
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

  head(key: string): Promise<ObjectHead | null> {
    return this.store.head(key);
  }

  getRange(key: string, start: number, end: number): Promise<Buffer | null> {
    return this.store.getRange(key, start, end);
  }

  getStream(key: string): Promise<Readable> {
    return this.store.getStream(key);
  }

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.store.put(key, body, contentType);
  }

  /** Best-effort. A failed cleanup is logged, not thrown — the reaper retries. */
  async remove(keys: string[]): Promise<void> {
    try {
      await this.store.remove(keys);
    } catch (error) {
      this.logger.error(`failed to delete ${keys.length} object(s): ${describeError(error)}`);
    }
  }

  bucketReachable(): Promise<void> {
    return this.store.bucketReachable();
  }
}
