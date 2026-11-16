import { BadRequestException, Controller, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
// Side-effect only: brings @fastify/multipart's `declare module "fastify"` augmentation
// (FastifyRequest.file()) into this compilation — the plugin itself is registered at
// runtime by apps/api-admin's main.ts, not here; nest-core only needs its types.
import type {} from "@fastify/multipart";
import type { UploadedImage } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ImageUploadService } from "./image-upload.service.js";

/** P2-44: a generic upload primitive, not tied to one entity — the caller
 * uploads a file here, gets back a URL, then PATCHes that URL into
 * whichever entity's imageUrl/logoUrl it's actually setting (categories,
 * products, combos, receipt-settings all already accept an arbitrary URL
 * string there, unchanged by this task). Same menu.manage permission as
 * catalog management generally, since every current caller is a catalog
 * or receipt-settings edit. */
@Controller("images")
export class ImageUploadController {
  constructor(private readonly imageUploadService: ImageUploadService) {}

  @Post()
  @RequirePermission("menu.manage")
  async upload(@Req() request: FastifyRequest): Promise<UploadedImage> {
    const tenant = requireTenant();
    const file = await request.file();
    if (!file) throw new BadRequestException("no file uploaded — send multipart/form-data with a 'file' field");
    const buffer = await file.toBuffer();
    const result = await this.imageUploadService.upload({ restaurantId: tenant.restaurantId, buffer, contentType: file.mimetype });
    return { url: result.url };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
