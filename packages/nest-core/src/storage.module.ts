import { Module, type DynamicModule } from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";

export const S3_CLIENT = Symbol("S3_CLIENT");
export const STORAGE_OPTIONS = Symbol("STORAGE_OPTIONS");

export interface StorageModuleOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * The prefix a returned image URL is built from: `${publicBaseUrl}/${key}`
   * — include the bucket name here yourself if your endpoint needs it in
   * the path (Garage/path-style does; an R2 custom domain already scoped
   * to one bucket doesn't). In production this is a Cloudflare custom
   * domain in front of an R2 bucket (section 3's "Files" entry); locally
   * it defaults to Garage's own S3 endpoint + bucket name, which only
   * serves signed/authenticated requests, not anonymous GETs — see
   * ImageUploadService's own docs for why that's a known, documented gap
   * rather than something this task silently papers over.
   */
  publicBaseUrl: string;
}

/**
 * P2-44: the first real consumer of section 3's "Files: S3-compatible
 * storage" entry — mirrors RedisModule's exact shape (a Symbol token, a
 * `forRoot` static factory, global so every feature module can inject it
 * without re-importing). Works against any S3-compatible endpoint by
 * construction (the whole point of the AWS SDK v3 S3 client): Garage
 * locally, R2 in production, same client code either way — only the
 * `forRoot` options differ.
 */
@Module({})
export class StorageModule {
  static forRoot(options: StorageModuleOptions): DynamicModule {
    const client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Garage (and many other self-hosted S3-compatible stores) only
      // supports path-style bucket addressing, not virtual-hosted-style
      // subdomains — R2 accepts both, so this is safe for production too.
      forcePathStyle: true,
    });

    return {
      module: StorageModule,
      providers: [
        { provide: S3_CLIENT, useValue: client },
        { provide: STORAGE_OPTIONS, useValue: options },
      ],
      exports: [S3_CLIENT, STORAGE_OPTIONS],
      global: true,
    };
  }
}
