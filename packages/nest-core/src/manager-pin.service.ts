import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { hashPassword, verifyPassword } from "./password.js";
import { PermissionsService } from "./permissions.service.js";

export const MANAGER_PIN_OPTIONS = Symbol("MANAGER_PIN_OPTIONS");

export interface ManagerPinServiceOptions {
  maxFailedAttempts?: number;
  lockoutMinutes?: number;
}

export interface SetManagerPinParams {
  restaurantId: string;
  userId: string;
  pin: string;
}

export interface ApproveWithManagerPinParams {
  restaurantId: string;
  branchId?: string | null;
  deviceId?: string | null;
  managerUserId: string;
  pin: string;
  requiredPermission: string;
  /** What's being approved, e.g. "void" or "refund" — only used as the audit action
   * label, never trusted as the permission to check (the caller passes that
   * separately, already resolved from a server-side map). */
  action: string;
}

const INVALID_PIN = "Invalid manager PIN";
const PIN_LOCKED = "Manager PIN is temporarily locked after too many failed attempts";
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MINUTES = 15;

/**
 * Lets a manager approve a sensitive action (void, refund, ...) in place — the cashier
 * stays logged in at the terminal, and the approving manager just enters their PIN
 * rather than logging in themselves (P1-13). Every outcome is audited (rule 6: an
 * approval, denial or lockout is never silent).
 *
 * This is the server-authoritative half only. Offline verification (CLAUDE.md rule 3:
 * offline terminals use only signed, versioned data synced from the server) has no
 * local-db/SQLite infrastructure to build on yet (that's P1-19); it needs its own
 * design once that lands, likely a signed PIN-hash bundle synced down like prices.
 */
@Injectable()
export class ManagerPinService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogService: AuditLogService,
    @Inject(MANAGER_PIN_OPTIONS) private readonly options: ManagerPinServiceOptions,
  ) {}

  private get maxFailedAttempts(): number {
    return this.options.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
  }

  private get lockoutMs(): number {
    return (this.options.lockoutMinutes ?? DEFAULT_LOCKOUT_MINUTES) * 60 * 1000;
  }

  /** A manager sets or replaces their own PIN. Resets any existing lockout — changing
   * the PIN is itself proof of access to the account, same reasoning as a password
   * reset revoking sessions in AuthService. */
  async setPin(params: SetManagerPinParams): Promise<void> {
    const pinHash = await hashPassword(params.pin);

    await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await tx
        .insert(schema.managerPins)
        .values({ restaurantId: params.restaurantId, userId: params.userId, pinHash })
        .onConflictDoUpdate({
          target: [schema.managerPins.restaurantId, schema.managerPins.userId],
          set: { pinHash, failedAttempts: 0, lockedUntil: null, updatedAt: new Date() },
        });

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.userId,
          action: "manager_pin.set",
          targetType: "user",
          targetId: params.userId,
        },
        tx,
      );
    });
  }

  /** Verifies that `managerUserId` both holds `requiredPermission` and knows their own
   * PIN, then records the outcome. Throws ForbiddenException on any failure — wrong
   * PIN, no PIN set, locked out, or missing permission all look the same to the
   * caller, but are distinguished in the audit log. */
  async approve(params: ApproveWithManagerPinParams): Promise<{ approved: true }> {
    // Deliberately never throws from inside withTenant: a thrown error aborts the
    // whole transaction, which would roll back the very audit entry and lockout
    // counter update meant to record the denial (rule 6 — a denial must still be
    // visible). Every path returns a result instead, and the ForbiddenException is
    // thrown only after the transaction has committed.
    const outcome = await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const auditBase = {
        restaurantId: params.restaurantId,
        branchId: params.branchId ?? null,
        actorUserId: params.managerUserId,
        deviceId: params.deviceId ?? null,
        targetType: "manager_pin_approval",
        targetId: params.action,
      };
      const deny = async (reason: string, message: string): Promise<{ ok: false; message: string }> => {
        await this.auditLogService.record({ ...auditBase, action: reason }, tx);
        return { ok: false, message };
      };

      const rows = await tx
        .select({
          roleKey: schema.roles.key,
          userStatus: schema.users.status,
          pinId: schema.managerPins.id,
          pinHash: schema.managerPins.pinHash,
          failedAttempts: schema.managerPins.failedAttempts,
          lockedUntil: schema.managerPins.lockedUntil,
        })
        .from(schema.users)
        .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
        .leftJoin(schema.managerPins, eq(schema.managerPins.userId, schema.users.id))
        .where(and(eq(schema.users.id, params.managerUserId), eq(schema.users.restaurantId, params.restaurantId)));

      const row = rows[0];
      if (!row || row.userStatus !== "active" || !row.pinId || !row.pinHash) {
        return deny(`${params.action}.approval_denied`, INVALID_PIN);
      }

      if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
        return deny(`${params.action}.approval_locked`, PIN_LOCKED);
      }

      if (!(await this.permissionsService.hasPermission(row.roleKey, params.requiredPermission))) {
        return deny(`${params.action}.approval_denied`, INVALID_PIN);
      }

      if (!(await verifyPassword(params.pin, row.pinHash))) {
        const failedAttempts = (row.failedAttempts ?? 0) + 1;
        const locked = failedAttempts >= this.maxFailedAttempts;
        await tx
          .update(schema.managerPins)
          .set({
            failedAttempts: locked ? 0 : failedAttempts,
            lockedUntil: locked ? new Date(Date.now() + this.lockoutMs) : null,
            updatedAt: new Date(),
          })
          .where(eq(schema.managerPins.id, row.pinId));
        return deny(locked ? `${params.action}.approval_locked` : `${params.action}.approval_denied`, locked ? PIN_LOCKED : INVALID_PIN);
      }

      await tx
        .update(schema.managerPins)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(schema.managerPins.id, row.pinId));
      await this.auditLogService.record({ ...auditBase, action: `${params.action}.approved` }, tx);

      return { ok: true } as const;
    });

    if (!outcome.ok) {
      throw new ForbiddenException(outcome.message);
    }
    return { approved: true };
  }
}
