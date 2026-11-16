import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { SnapshotMenu } from "@mezbaan/contracts";
import { MenuSnapshotCacheService } from "./menu-snapshot-cache.service.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let redis: Redis;
let service: MenuSnapshotCacheService;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on("error", () => {
    // Same reasoning as redis.module.ts — an unhandled 'error' event on a
    // Node EventEmitter crashes the process.
  });
  // Same reasoning as redis.module.ts's own connect() call — lazyConnect
  // + enableOfflineQueue:false needs the connection actually established
  // before the first real command, or it throws instead of connecting.
  await redis.connect();
  service = new MenuSnapshotCacheService(redis);
});

afterAll(() => {
  redis.disconnect();
});

function sampleMenu(label: string): SnapshotMenu {
  return { branchId: `branch-${label}`, categories: [], products: [], variants: [], prices: [], modifierGroups: [], modifierOptions: [], productModifierGroups: [] };
}

describe("MenuSnapshotCacheService — against a real Redis (requires it running, same assumption this project's DB-backed tests already make for Postgres)", () => {
  it("returns null for a key that was never cached", async () => {
    const result = await service.get(randomUUID(), randomUUID());
    expect(result).toBeNull();
  });

  it("set then get round-trips the exact menu", async () => {
    const restaurantId = randomUUID();
    const branchId = randomUUID();
    const menu = sampleMenu("roundtrip");

    await service.set(restaurantId, branchId, menu);
    const cached = await service.get(restaurantId, branchId);

    expect(cached).toEqual(menu);
  });

  it("invalidateRestaurant makes a previously cached entry unreachable", async () => {
    const restaurantId = randomUUID();
    const branchId = randomUUID();
    await service.set(restaurantId, branchId, sampleMenu("to-invalidate"));

    await service.invalidateRestaurant(restaurantId);

    expect(await service.get(restaurantId, branchId)).toBeNull();
  });

  it("a fresh set after invalidation is cached again under the new generation", async () => {
    const restaurantId = randomUUID();
    const branchId = randomUUID();
    await service.set(restaurantId, branchId, sampleMenu("before"));
    await service.invalidateRestaurant(restaurantId);

    const afterMenu = sampleMenu("after");
    await service.set(restaurantId, branchId, afterMenu);

    expect(await service.get(restaurantId, branchId)).toEqual(afterMenu);
  });

  it("invalidating one restaurant never affects another's cached entry", async () => {
    const restaurantA = randomUUID();
    const restaurantB = randomUUID();
    const branchId = randomUUID();
    const menuB = sampleMenu("b-untouched");
    await service.set(restaurantA, branchId, sampleMenu("a"));
    await service.set(restaurantB, branchId, menuB);

    await service.invalidateRestaurant(restaurantA);

    expect(await service.get(restaurantB, branchId)).toEqual(menuB);
  });
});

describe("MenuSnapshotCacheService — fails soft when Redis is unreachable", () => {
  it("get/set/invalidateRestaurant all resolve harmlessly instead of throwing", async () => {
    const unreachable = new Redis("redis://127.0.0.1:1", { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 200 });
    unreachable.on("error", () => {});
    const brokenService = new MenuSnapshotCacheService(unreachable);

    await expect(brokenService.get(randomUUID(), randomUUID())).resolves.toBeNull();
    await expect(brokenService.set(randomUUID(), randomUUID(), sampleMenu("unreachable"))).resolves.toBeUndefined();
    await expect(brokenService.invalidateRestaurant(randomUUID())).resolves.toBeUndefined();

    unreachable.disconnect();
  });
});
