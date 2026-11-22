import { Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { and, eq, gt } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { generateOpaqueToken, hashOpaqueToken, parseOpaqueTokenRestaurantId } from "./opaque-token.js";

export interface DeviceRecord {
  id: string;
  restaurantId: string;
  branchId: string;
  label: string;
  deviceType: "pos_terminal" | "kitchen_display" | "tablet" | "other";
  terminalNumber: number;
  // P2-45: joined from branches.branchNumber, not a devices column itself —
  // see DeviceService.attachBranchNumber/attachBranchNumbers.
  branchNumber: number;
  // P2-45 (exit-gate hardening): who an offline sale synced from this device
  // is attributed to. Null until an admin configures it via setDefaultActor.
  defaultActorUserId: string | null;
  status: "active" | "revoked";
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateDeviceParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  label: string;
  deviceType: DeviceRecord["deviceType"];
}

export interface GeneratePairingCodeParams {
  restaurantId: string;
  actorUserId: string;
  deviceId: string;
}

export interface PairingCodeResult {
  pairingCode: string;
  expiresAt: Date;
}

export interface RedeemPairingCodeResult {
  deviceToken: string;
  device: DeviceRecord;
}

export interface RevokeDeviceParams {
  restaurantId: string;
  actorUserId: string;
  deviceId: string;
}

export interface SetDefaultActorParams {
  restaurantId: string;
  actorUserId: string;
  deviceId: string;
  defaultActorUserId: string;
}

const DEVICE_NOT_FOUND = "Device not found";
const INVALID_PAIRING_CODE = "Invalid or expired pairing code";
const INVALID_DEVICE_TOKEN = "Invalid or revoked device token";
const USER_NOT_FOUND = "User not found";
const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Device pairing, token issuance and revocation (P1-20). Mirrors AuthService's
 * session pattern exactly: tokens (and pairing codes) are opaque, restaurant-id
 * prefixed strings (see opaque-token.ts) — only their SHA-256 hash is ever stored
 * (rule 20), and the restaurant-id prefix lets a not-yet-authenticated caller (a
 * terminal redeeming a pairing code, or presenting its device token) round-trip the
 * tenant so RLS context can be set *before* the row lookup.
 */
@Injectable()
export class DeviceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<DeviceRecord[]> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({ device: schema.devices, branchNumber: schema.branches.branchNumber })
        .from(schema.devices)
        .innerJoin(schema.branches, eq(schema.devices.branchId, schema.branches.id));
      return rows.map(({ device, branchNumber }) => ({ ...device, branchNumber }));
    });
  }

  /** P2-36: every active device's id + token hash for one branch — what a
   * hub fetches once while online so it can verify a peer's device token
   * itself afterward, entirely offline, by hashing the presented raw token
   * and checking it against this roster (see hub_auth.rs). Never exposes
   * the raw token, same convention as every other tokenHash column. */
  async listRosterForBranch(restaurantId: string, branchId: string): Promise<Array<{ deviceId: string; tokenHash: string }>> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({ deviceId: schema.devices.id, tokenHash: schema.devices.tokenHash })
        .from(schema.devices)
        .where(and(eq(schema.devices.branchId, branchId), eq(schema.devices.status, "active")));
      return rows.filter((row): row is { deviceId: string; tokenHash: string } => row.tokenHash !== null);
    });
  }

  async create(params: CreateDeviceParams): Promise<DeviceRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      // terminal_number (P1-28's "T2" prefix) is assigned automatically by a DB
      // trigger — same reasoning as branches.branchNumber.
      const rows = await tx
        .insert(schema.devices)
        .values({ restaurantId: params.restaurantId, branchId: params.branchId, label: params.label, deviceType: params.deviceType })
        .returning();
      const device = rows[0];
      if (!device) throw new Error("create: device insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: device.branchId,
          actorUserId: params.actorUserId,
          action: "device.created",
          targetType: "device",
          targetId: device.id,
        },
        tx,
      );
      return this.attachBranchNumber(tx, device);
    });
  }

  /** P2-45: a single extra indexed lookup — fine for the single-device methods
   * below (list() above uses a real join instead, since N devices would mean
   * N extra round trips here). */
  private async attachBranchNumber(tx: Database, device: typeof schema.devices.$inferSelect): Promise<DeviceRecord> {
    const branchRows = await tx.select({ branchNumber: schema.branches.branchNumber }).from(schema.branches).where(eq(schema.branches.id, device.branchId));
    const branchNumber = branchRows[0]?.branchNumber;
    if (branchNumber === undefined) throw new Error(`attachBranchNumber: device ${device.id}'s branch ${device.branchId} disappeared`);
    return { ...device, branchNumber };
  }

  /** Regenerating overwrites any previous unredeemed code for the same device —
   * there's only ever one live pairing code per device. */
  async generatePairingCode(params: GeneratePairingCodeParams): Promise<PairingCodeResult> {
    const pairingCode = generateOpaqueToken(params.restaurantId);
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.devices)
        .set({ pairingCodeHash: hashOpaqueToken(pairingCode), pairingCodeExpiresAt: expiresAt })
        .where(and(eq(schema.devices.id, params.deviceId), eq(schema.devices.restaurantId, params.restaurantId)))
        .returning({ id: schema.devices.id });
      if (!rows[0]) throw new NotFoundException(DEVICE_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          deviceId: params.deviceId,
          action: "device.pairing_code_generated",
          targetType: "device",
          targetId: params.deviceId,
        },
        tx,
      );
      return { pairingCode, expiresAt };
    });
  }

  /** Public (no auth) — a terminal has no token yet. The pairing code itself,
   * generated by an authenticated admin via generatePairingCode, is the proof of
   * authorization. A single atomic UPDATE...WHERE (not select-then-update) closes
   * the race window a two-step check-then-write would leave open, and makes an
   * expired or already-redeemed code fail the exact same way as a wrong one. */
  async redeemPairingCode(pairingCode: string): Promise<RedeemPairingCodeResult> {
    const restaurantId = parseOpaqueTokenRestaurantId(pairingCode);
    if (!restaurantId) throw new UnauthorizedException(INVALID_PAIRING_CODE);
    const codeHash = hashOpaqueToken(pairingCode);
    const deviceToken = generateOpaqueToken(restaurantId);

    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.devices)
        .set({
          tokenHash: hashOpaqueToken(deviceToken),
          pairingCodeHash: null,
          pairingCodeExpiresAt: null,
          status: "active",
          revokedAt: null,
          lastSeenAt: new Date(),
        })
        .where(and(eq(schema.devices.pairingCodeHash, codeHash), gt(schema.devices.pairingCodeExpiresAt, new Date())))
        .returning();
      const device = rows[0];
      if (!device) throw new UnauthorizedException(INVALID_PAIRING_CODE);

      await this.auditLogService.record(
        {
          restaurantId,
          branchId: device.branchId,
          deviceId: device.id,
          action: "device.paired",
          targetType: "device",
          targetId: device.id,
        },
        tx,
      );
      return { deviceToken, device: await this.attachBranchNumber(tx, device) };
    });
  }

  /** Same atomic UPDATE...WHERE shape as redeemPairingCode, for the same reason:
   * validating and touching lastSeenAt in one round trip means a revoked-mid-check
   * device can't slip through. */
  async validateDeviceToken(rawToken: string): Promise<DeviceRecord> {
    const restaurantId = parseOpaqueTokenRestaurantId(rawToken);
    if (!restaurantId) throw new UnauthorizedException(INVALID_DEVICE_TOKEN);
    const tokenHash = hashOpaqueToken(rawToken);

    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.devices)
        .set({ lastSeenAt: new Date() })
        .where(and(eq(schema.devices.tokenHash, tokenHash), eq(schema.devices.status, "active")))
        .returning();
      const device = rows[0];
      if (!device) throw new UnauthorizedException(INVALID_DEVICE_TOKEN);
      return this.attachBranchNumber(tx, device);
    });
  }

  /** Clearing tokenHash (not just flipping status) means a leaked old token can
   * never be matched again even if status were somehow bypassed — belt and
   * suspenders with the status check in validateDeviceToken. */
  async revoke(params: RevokeDeviceParams): Promise<DeviceRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .update(schema.devices)
        .set({ status: "revoked", revokedAt: new Date(), tokenHash: null })
        .where(and(eq(schema.devices.id, params.deviceId), eq(schema.devices.restaurantId, params.restaurantId)))
        .returning();
      const device = rows[0];
      if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: device.branchId,
          actorUserId: params.actorUserId,
          deviceId: device.id,
          action: "device.revoked",
          targetType: "device",
          targetId: device.id,
        },
        tx,
      );
      return this.attachBranchNumber(tx, device);
    });
  }

  /** P2-45 (exit-gate hardening): sets who an offline sale synced from this
   * device is attributed to (orders.openedByUserId, invoices.actorUserId) —
   * desktop has no login flow, so this is the real cashier identity stand-in
   * until one exists. Rejects a userId outside this restaurant rather than
   * trusting the FK alone, same tenant-isolation reasoning as every other
   * cross-entity reference in this codebase. */
  async setDefaultActor(params: SetDefaultActorParams): Promise<DeviceRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const userRows = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.id, params.defaultActorUserId), eq(schema.users.restaurantId, params.restaurantId)));
      if (!userRows[0]) throw new NotFoundException(USER_NOT_FOUND);

      const rows = await tx
        .update(schema.devices)
        .set({ defaultActorUserId: params.defaultActorUserId })
        .where(and(eq(schema.devices.id, params.deviceId), eq(schema.devices.restaurantId, params.restaurantId)))
        .returning();
      const device = rows[0];
      if (!device) throw new NotFoundException(DEVICE_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: device.branchId,
          actorUserId: params.actorUserId,
          deviceId: device.id,
          action: "device.default_actor_set",
          targetType: "device",
          targetId: device.id,
          metadata: { defaultActorUserId: params.defaultActorUserId },
        },
        tx,
      );
      return this.attachBranchNumber(tx, device);
    });
  }
}
