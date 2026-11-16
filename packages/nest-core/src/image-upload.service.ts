import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { S3_CLIENT, STORAGE_OPTIONS, type StorageModuleOptions } from "./storage.module.js";

export interface UploadImageParams {
  restaurantId: string;
  buffer: Buffer;
  contentType: string;
}

export interface UploadedImage {
  url: string;
  key: string;
}

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
// Exported so the app wiring up @fastify/multipart (apps/api-admin's main.ts) can pass
// the exact same number as its own stream-level `limits.fileSize` — defense in depth,
// rejecting an oversized upload before it's even fully buffered, not just after.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// No responsive srcset here (categories/products/combos/receipt_settings
// each store exactly one imageUrl column, not a set of sizes) — this
// caps the longer dimension of whatever was uploaded so a multi-MB phone
// photo doesn't ship to a POS screen at full resolution. withoutEnlargement
// means a smaller source image is never upscaled.
const MAX_DIMENSION_PX = 1600;
const WEBP_QUALITY = 82;
// Content-addressed-ish (a random key, not the original filename) so two
// uploads never collide and the long-lived Cache-Control below is actually
// safe: this exact URL will never point at different bytes later.
const CACHE_CONTROL = "public, max-age=31536000, immutable";

const INVALID_CONTENT_TYPE = `file must be one of: ${[...ALLOWED_CONTENT_TYPES].join(", ")}`;
const FILE_TOO_LARGE = `file must be ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB or smaller`;

/**
 * P2-44: the real upload-to-storage pipeline P2-01/P2-33 deferred —
 * `imageUrl`/`logoUrl` on categories/products/combos/receipt_settings were
 * always just a reference column; this is what actually produces the
 * value that goes in it. Resizes (never upscales), re-encodes to WebP, and
 * uploads to whatever S3-compatible endpoint StorageModule was configured
 * with (Garage locally, R2 in production — section 3's "Files" entry).
 *
 * **Known gap, stated explicitly rather than silently assumed away**: the
 * URL this returns is only actually fetchable by an anonymous browser once
 * the bucket itself is configured for public read — R2 behind a Cloudflare
 * custom domain in production, or Garage's own website-access bucket
 * setting locally (infra/garage-init.sh does not enable this). Wiring that
 * up is bucket/infra configuration, not something this service's own code
 * can do from inside a Node process — tracked here rather than assumed
 * solved.
 */
@Injectable()
export class ImageUploadService {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(STORAGE_OPTIONS) private readonly options: StorageModuleOptions,
  ) {}

  async upload(params: UploadImageParams): Promise<UploadedImage> {
    if (!ALLOWED_CONTENT_TYPES.has(params.contentType)) throw new BadRequestException(INVALID_CONTENT_TYPE);
    if (params.buffer.byteLength > MAX_UPLOAD_BYTES) throw new BadRequestException(FILE_TOO_LARGE);

    let optimized: Buffer;
    try {
      optimized = await sharp(params.buffer)
        .rotate() // auto-orient from EXIF before resizing — resizing first would bake in the wrong orientation
        .resize({ width: MAX_DIMENSION_PX, height: MAX_DIMENSION_PX, fit: "inside", withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch {
      // sharp throws on anything it can't actually decode as an image, regardless
      // of what Content-Type header the client claimed — rule 17, validate at the
      // boundary, and this is the real validation; the Content-Type check above is
      // just a fast, cheap rejection for the common case of a wildly wrong upload.
      throw new BadRequestException("file could not be read as an image");
    }

    const key = `images/${params.restaurantId}/${randomUUID()}.webp`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: optimized,
        ContentType: "image/webp",
        CacheControl: CACHE_CONTROL,
      }),
    );

    return { url: `${this.options.publicBaseUrl.replace(/\/$/, "")}/${key}`, key };
  }
}
