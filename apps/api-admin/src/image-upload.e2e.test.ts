import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import fastifyMultipart from "@fastify/multipart";
import sharp from "sharp";
import type { Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, MAX_UPLOAD_BYTES, PermissionGuard, PermissionsService, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-44: proves the HTTP surface (multipart wiring, the menu.manage permission
 * gate, a real response shape) over a real local Garage upload — the actual
 * resize/WebP/Cache-Control behavior is image-upload.service.test.ts's job. */
const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });
  app.useGlobalGuards(
    new TenantContextGuard({ secret: SECRET }),
    new PermissionGuard(new PermissionsService(app.get<Database>(DATABASE)), app.get(Reflector)),
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
});

interface SignupHttpResponse {
  accessToken: string;
}

async function signup(label: string): Promise<string> {
  const slug = `${label}-${randomUUID()}`;
  const response = await app.inject({
    method: "POST",
    url: "/onboarding/signup",
    payload: {
      restaurantName: `${label} Restaurant`,
      slug,
      ownerEmail: `${label}@example.test`,
      ownerPassword: "a long enough password",
      ownerDisplayName: "The Owner",
      firstBranchName: "Main Branch",
      timezone: "Asia/Karachi",
    },
  });
  if (response.statusCode !== 201) throw new Error(`signup fixture failed: ${response.statusCode} ${response.body}`);
  return response.json<SignupHttpResponse>().accessToken;
}

async function samplePngBuffer(widthPx: number, heightPx: number): Promise<Buffer> {
  return sharp({ create: { width: widthPx, height: heightPx, channels: 3, background: { r: 0, g: 100, b: 200 } } })
    .png()
    .toBuffer();
}

function multipartBody(fileBuffer: Buffer, filename: string, contentType: string): { body: Buffer; boundary: string } {
  const boundary = `----mezbaanTestBoundary${randomUUID().replace(/-/g, "")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, boundary };
}

describe("POST /images (api-admin, P2-44)", () => {
  it("rejects an unauthenticated request", async () => {
    const png = await samplePngBuffer(100, 100);
    const { body, boundary } = multipartBody(png, "test.png", "image/png");
    const response = await app.inject({ method: "POST", url: "/images", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(response.statusCode).toBe(401);
  });

  it("uploads a real image and returns a working URL (positive control)", async () => {
    const accessToken = await signup("image-upload-e2e");
    const png = await samplePngBuffer(500, 500);
    const { body, boundary } = multipartBody(png, "test.png", "image/png");

    const response = await app.inject({
      method: "POST",
      url: "/images",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    const result = response.json<{ url: string }>();
    expect(result.url).toMatch(/\/images\/.+\.webp$/);
  });

  it("rejects a request with no file field", async () => {
    const accessToken = await signup("image-upload-e2e-no-file");
    const boundary = `----mezbaanTestBoundary${randomUUID().replace(/-/g, "")}`;
    const body = Buffer.from(`--${boundary}--\r\n`);

    const response = await app.inject({
      method: "POST",
      url: "/images",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-image upload", async () => {
    const accessToken = await signup("image-upload-e2e-bad-type");
    const { body, boundary } = multipartBody(Buffer.from("just some text"), "notes.txt", "text/plain");

    const response = await app.inject({
      method: "POST",
      url: "/images",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
  });
});
