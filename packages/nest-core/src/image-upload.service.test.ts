import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { ImageUploadService, MAX_UPLOAD_BYTES } from "./image-upload.service.js";
import type { StorageModuleOptions } from "./storage.module.js";

/** P2-44: against a REAL local Garage (S3-compatible) instance, same
 * assumption this project's DB-backed tests already make for Postgres —
 * infra/docker-compose.yml provisions it, and infra/garage-init.sh creates
 * the bucket/key this points at by default. */
const options: StorageModuleOptions = {
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "garage",
  bucket: process.env.S3_BUCKET ?? "mezbaan-local",
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "GKf72f4a98ea11b3a20ece3475",
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "e64b2bc9bd42da7e9d1f585cf1b7364468ef0f30810c08b5b03b05a2cf41a09d",
  publicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? "http://localhost:9000/mezbaan-local",
};

const client = new S3Client({
  endpoint: options.endpoint,
  region: options.region,
  credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  forcePathStyle: true,
});
const service = new ImageUploadService(client, options);

afterAll(() => {
  client.destroy();
});

/** A real, decodable PNG — not a stub — so sharp genuinely has something to resize/re-encode. */
async function samplePng(widthPx: number, heightPx: number): Promise<Buffer> {
  return sharp({ create: { width: widthPx, height: heightPx, channels: 3, background: { r: 10, g: 200, b: 80 } } })
    .png()
    .toBuffer();
}

describe("ImageUploadService.upload", () => {
  it("resizes down, re-encodes to WebP, uploads with long-lived Cache-Control, and returns a working URL", async () => {
    const original = await samplePng(2000, 2000);
    const result = await service.upload({ restaurantId: randomUUID(), buffer: original, contentType: "image/png" });

    expect(result.key).toMatch(/^images\/.+\.webp$/);
    expect(result.url).toBe(`${options.publicBaseUrl}/${result.key}`);

    const head = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: result.key }));
    expect(head.ContentType).toBe("image/webp");
    expect(head.CacheControl).toBe("public, max-age=31536000, immutable");
    expect(head.ContentLength).toBeGreaterThan(0);
    // The source was 2000x2000 — resized down, not left at original size.
    expect(head.ContentLength!).toBeLessThan(original.byteLength);

    const got = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: result.key }));
    const bytes = Buffer.from(await got.Body!.transformToByteArray());
    const metadata = await sharp(bytes).metadata();
    expect(metadata.format).toBe("webp");
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(1600);
  });

  it("never upscales an image smaller than the max dimension", async () => {
    const original = await samplePng(200, 150);
    const result = await service.upload({ restaurantId: randomUUID(), buffer: original, contentType: "image/png" });

    const got = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: result.key }));
    const bytes = Buffer.from(await got.Body!.transformToByteArray());
    const metadata = await sharp(bytes).metadata();
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(150);
  });

  it("rejects a content type that isn't an image", async () => {
    const buffer = Buffer.from("not an image at all");
    await expect(service.upload({ restaurantId: randomUUID(), buffer, contentType: "text/plain" })).rejects.toThrow(/must be one of/);
  });

  it("rejects a file over the size limit even with a valid content type", async () => {
    const buffer = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    await expect(service.upload({ restaurantId: randomUUID(), buffer, contentType: "image/png" })).rejects.toThrow(/smaller/);
  });

  it("rejects bytes that claim to be an image but aren't actually decodable as one", async () => {
    const buffer = Buffer.from("this claims to be a png but sharp will reject it");
    await expect(service.upload({ restaurantId: randomUUID(), buffer, contentType: "image/png" })).rejects.toThrow(/could not be read as an image/);
  });

  it("two uploads of the same source image get distinct keys and URLs", async () => {
    const restaurantId = randomUUID();
    const original = await samplePng(300, 300);
    const first = await service.upload({ restaurantId, buffer: original, contentType: "image/png" });
    const second = await service.upload({ restaurantId, buffer: original, contentType: "image/png" });

    expect(first.key).not.toBe(second.key);
    expect(first.url).not.toBe(second.url);
  });
});
