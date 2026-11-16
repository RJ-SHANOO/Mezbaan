import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { SnapshotMenu } from "@mezbaan/contracts";
import { REDIS } from "./redis.module.js";

/** Safety net, not the primary invalidation mechanism — see
 * `invalidateRestaurant`'s own docs for why most catalog edits don't
 * explicitly bust this cache. Five minutes bounds how stale an
 * un-invalidated change (a product rename, a new modifier option) can
 * ever be, without needing every catalog service to know about this cache. */
const DEFAULT_TTL_SECONDS = 5 * 60;

/**
 * P2-43: caches `SyncSnapshotService.loadMenu`'s expensive result — a
 * per-branch catalog read plus an N+1-shaped price-resolution loop over
 * every product/variant/modifier-option across all three order types,
 * re-run today on EVERY terminal sync even when nothing changed. Keyed by
 * `(restaurantId, branchId)`, this is purely a rarely-changing-data cache
 * — the outer sync snapshot's own `version`/signature (P1-27, P2-17's
 * "prices as of" display) are still minted fresh on every request
 * regardless of a cache hit, so caching this never makes a sync look
 * staler than it actually is.
 *
 * Every method fails soft: a Redis miss, timeout, or outage is always
 * treated exactly like a cache miss (rule 14 — a cache must never be the
 * reason a sync fails), never surfaced to the caller as an error.
 */
@Injectable()
export class MenuSnapshotCacheService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async get(restaurantId: string, branchId: string): Promise<SnapshotMenu | null> {
    try {
      const generation = await this.currentGeneration(restaurantId);
      const raw = await this.redis.get(this.contentKey(restaurantId, branchId, generation));
      return raw ? (JSON.parse(raw) as SnapshotMenu) : null;
    } catch {
      return null;
    }
  }

  async set(restaurantId: string, branchId: string, menu: SnapshotMenu, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<void> {
    try {
      const generation = await this.currentGeneration(restaurantId);
      await this.redis.set(this.contentKey(restaurantId, branchId, generation), JSON.stringify(menu), "EX", ttlSeconds);
    } catch {
      // Best-effort — the response this was computed for has already been returned either way.
    }
  }

  /**
   * "Clear the cache when a new version is published" — called by
   * `PriceListsService.publish` (the canonical "a new menu/price version
   * exists" event this whole task is built around). Bumps a per-restaurant
   * generation counter rather than deleting keys directly: every cached
   * entry's own key embeds the generation current when it was written, so
   * incrementing this makes every EXISTING entry for this restaurant
   * unreachable in one atomic `INCR` — no need to know which branches
   * exist, and no key-pattern scan/delete, which Redis has no efficient,
   * safe way to do in production anyway. Stale entries aren't actively
   * deleted; they simply age out via their own TTL once nothing reads them.
   *
   * Deliberately NOT wired into every other catalog mutation (a new
   * product, a renamed category, an edited modifier group) — doing so
   * would mean threading this service into most of Phase 2's
   * already-reviewed catalog services for a change whose staleness the
   * 5-minute TTL safety net already bounds. Price-list publication is the
   * dominant, most consequential case (the one this task's own wording —
   * "a new version is published" — names), and the rest is an accepted,
   * documented gap rather than an oversight.
   */
  async invalidateRestaurant(restaurantId: string): Promise<void> {
    try {
      await this.redis.incr(this.generationKey(restaurantId));
    } catch {
      // Best-effort — the TTL above still bounds staleness if this fails.
    }
  }

  private async currentGeneration(restaurantId: string): Promise<string> {
    const value = await this.redis.get(this.generationKey(restaurantId));
    return value ?? "0";
  }

  private generationKey(restaurantId: string): string {
    return `menu:gen:${restaurantId}`;
  }

  private contentKey(restaurantId: string, branchId: string, generation: string): string {
    return `menu:${restaurantId}:${branchId}:${generation}`;
  }
}
