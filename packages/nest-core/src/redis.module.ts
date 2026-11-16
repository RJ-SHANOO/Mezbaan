import { Module, type DynamicModule } from "@nestjs/common";
import { Redis } from "ioredis";

export const REDIS = Symbol("REDIS");

export interface RedisModuleOptions {
  url: string;
}

/**
 * P2-43: the first real consumer of section 3's "Cache and jobs: Valkey or
 * Redis" stack entry — nothing in this codebase has connected to it until
 * now, even though P1-02's docker-compose already provisions it. Mirrors
 * `DbModule`'s own shape exactly (a Symbol token, a `forRoot` static
 * factory, global so every feature module can inject it without
 * re-importing).
 *
 * `lazyConnect: true` + `maxRetriesPerRequest: 1`: a cache must never be
 * the reason a sale or a sync fails (rule 14) — a slow/unreachable Redis
 * should fail one call fast, not retry-and-block it. Callers (menu-
 * cache.service.ts) already treat any Redis error as a cache miss and fall
 * back to computing fresh, so a long client-side retry loop here would
 * only add latency to the fallback path for no benefit.
 */
@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    const client = new Redis(options.url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    client.on("error", () => {
      // Swallowed deliberately (rule 16 still applies at the call site,
      // which logs with context) — ioredis emits this on every failed
      // reconnect attempt, and an unhandled 'error' event on a Node
      // EventEmitter crashes the process if nothing listens for it.
    });
    // `lazyConnect: true` only defers the initial TCP connection — it does
    // NOT make ioredis connect-on-first-command the way a non-lazy client
    // does. Combined with `enableOfflineQueue: false`, a command issued
    // before something calls connect() throws immediately ("Stream isn't
    // writeable") rather than ever establishing a connection. Kicking off
    // `connect()` here, once, at module construction (well before the
    // first real request in any real app lifetime) is what actually makes
    // the cache work; the rejection is swallowed the same way the 'error'
    // listener above does, since every call site already treats a broken
    // client as a cache miss.
    client.connect().catch(() => {});

    return {
      module: RedisModule,
      providers: [{ provide: REDIS, useValue: client }],
      exports: [REDIS],
      global: true,
    };
  }
}
