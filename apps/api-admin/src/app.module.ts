import { Module } from "@nestjs/common";
import {
  AuthModule,
  BranchesModule,
  CatalogModule,
  DbModule,
  DEV_JWT_SECRET,
  DevicesAdminModule,
  FeatureFlagsModule,
  GoodsReceivedNotesModule,
  HealthController,
  ImageUploadController,
  ImageUploadService,
  InventoryModule,
  KitchenModule,
  ManagerPinModule,
  MetricsController,
  OnboardingModule,
  ProductionModule,
  PurchaseOrdersModule,
  PurchaseReturnsModule,
  RecipesModule,
  RedisModule,
  StorageModule,
  SuppliersModule,
  SupplierInvoicesModule,
  SupplierLedgerModule,
  StockCountsModule,
  WastageModule,
  ParLevelsModule,
  TablesModule,
  UserInvitationModule,
} from "@mezbaan/nest-core";

const DEFAULT_APP_DATABASE_URL = "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";
const DEFAULT_REDIS_URL = "redis://localhost:6379";
// Garage's local defaults (infra/.env.example) — path-style, so the bucket name
// has to be in the URL. S3_PUBLIC_BASE_URL is genuinely different in production:
// a Cloudflare custom domain already scoped to one R2 bucket (section 3's
// "Files" entry), not a raw S3 endpoint URL at all.
const DEFAULT_S3_ENDPOINT = "http://localhost:9000";
const DEFAULT_S3_REGION = "garage";
const DEFAULT_S3_BUCKET = "mezbaan-local";
const DEFAULT_S3_ACCESS_KEY_ID = "GKf72f4a98ea11b3a20ece3475";
const DEFAULT_S3_SECRET_ACCESS_KEY = "e64b2bc9bd42da7e9d1f585cf1b7364468ef0f30810c08b5b03b05a2cf41a09d";
const DEFAULT_S3_PUBLIC_BASE_URL = `${DEFAULT_S3_ENDPOINT}/${DEFAULT_S3_BUCKET}`;

@Module({
  imports: [
    DbModule.forRoot({ connectionString: process.env.APP_DATABASE_URL ?? DEFAULT_APP_DATABASE_URL }),
    // P2-43: PriceListsService.publish invalidates MenuSnapshotCacheService (CatalogModule) on this.
    RedisModule.forRoot({ url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL }),
    // P2-44: backs ImageUploadService below — resized/WebP images for
    // categories/products/combos/receipt-settings all go through this one place.
    StorageModule.forRoot({
      endpoint: process.env.S3_ENDPOINT ?? DEFAULT_S3_ENDPOINT,
      region: process.env.S3_REGION ?? DEFAULT_S3_REGION,
      bucket: process.env.S3_BUCKET ?? DEFAULT_S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? DEFAULT_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? DEFAULT_S3_SECRET_ACCESS_KEY,
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? DEFAULT_S3_PUBLIC_BASE_URL,
    }),
    AuthModule.forRoot({ jwtSecret: process.env.JWT_SECRET ?? DEV_JWT_SECRET }),
    ManagerPinModule.forRoot(),
    OnboardingModule.forRoot(),
    BranchesModule.forRoot(),
    UserInvitationModule.forRoot(),
    DevicesAdminModule.forRoot(),
    FeatureFlagsModule.forRoot(),
    CatalogModule.forRoot(),
    TablesModule.forRoot(),
    KitchenModule.forRoot(),
    InventoryModule.forRoot(),
    RecipesModule.forRoot(),
    ProductionModule.forRoot(),
    SuppliersModule.forRoot(),
    PurchaseOrdersModule.forRoot(),
    GoodsReceivedNotesModule.forRoot(),
    SupplierInvoicesModule.forRoot(),
    PurchaseReturnsModule.forRoot(),
    SupplierLedgerModule.forRoot(),
    StockCountsModule.forRoot(),
    WastageModule.forRoot(),
    ParLevelsModule.forRoot(),
  ],
  controllers: [HealthController, MetricsController, ImageUploadController],
  providers: [ImageUploadService],
})
export class AppModule {}
