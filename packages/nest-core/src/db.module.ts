import { Module, type DynamicModule } from "@nestjs/common";
import { createDb, createPool, type Database } from "@mezbaan/db";

export const DATABASE = Symbol("DATABASE");

export interface DbModuleOptions {
  connectionString: string;
}

@Module({})
export class DbModule {
  static forRoot(options: DbModuleOptions): DynamicModule {
    const pool = createPool(options.connectionString);
    const db: Database = createDb(pool);
    return {
      module: DbModule,
      providers: [{ provide: DATABASE, useValue: db }],
      exports: [DATABASE],
      global: true,
    };
  }
}
