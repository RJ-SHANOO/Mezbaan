import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";
import { generateOpaqueToken, hashOpaqueToken, parseOpaqueTokenRestaurantId } from "./opaque-token.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signAccessToken } from "./tenant-context.js";

export const AUTH_OPTIONS = Symbol("AUTH_OPTIONS");

export interface AuthServiceOptions {
  jwtSecret: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlDays?: number;
  passwordResetTtlMinutes?: number;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
}

const INVALID_CREDENTIALS = "Invalid email or password";
const INVALID_REFRESH_TOKEN = "Invalid or expired refresh token";
const INVALID_RESET_TOKEN = "Invalid or expired reset token";

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_OPTIONS) private readonly options: AuthServiceOptions,
  ) {}

  private get refreshTokenTtlMs(): number {
    return (this.options.refreshTokenTtlDays ?? 30) * 24 * 60 * 60 * 1000;
  }

  private get passwordResetTtlMs(): number {
    return (this.options.passwordResetTtlMinutes ?? 60) * 60 * 1000;
  }

  /** Resolving "which restaurant is this login for" happens before we know the tenant
   * context — the same bootstrap problem restaurant creation has (see restaurants.ts).
   * Uses a privileged lookup internally; the caller never supplies a restaurantId. */
  private async resolveRestaurantId(slug: string): Promise<string> {
    const rows = await withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx
        .select({ id: schema.restaurants.id, status: schema.restaurants.status })
        .from(schema.restaurants)
        .where(eq(schema.restaurants.slug, slug)),
    );
    const restaurant = rows[0];
    if (!restaurant || restaurant.status !== "active") {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    return restaurant.id;
  }

  async login(params: { restaurantSlug: string; email: string; password: string }): Promise<LoginResult> {
    const restaurantId = await this.resolveRestaurantId(params.restaurantSlug);

    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({
          id: schema.users.id,
          passwordHash: schema.users.passwordHash,
          status: schema.users.status,
          branchId: schema.users.branchId,
          roleKey: schema.roles.key,
        })
        .from(schema.users)
        .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
        .where(and(eq(schema.users.restaurantId, restaurantId), eq(schema.users.email, params.email)));

      const user = rows[0];
      // Same generic error whether the email doesn't exist or the password is wrong —
      // never reveal which, that's how account enumeration happens.
      if (!user || user.status !== "active" || !(await verifyPassword(params.password, user.passwordHash))) {
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }

      return this.issueSession(tx, {
        restaurantId,
        userId: user.id,
        roleKey: user.roleKey,
        branchId: user.branchId,
      });
    });
  }

  private async issueSession(
    tx: Database,
    params: { restaurantId: string; userId: string; roleKey: string; branchId: string | null },
  ): Promise<LoginResult> {
    const accessToken = signAccessToken(
      {
        sub: params.userId,
        restaurantId: params.restaurantId,
        isSuperAdmin: false,
        roleKey: params.roleKey,
        branchId: params.branchId,
      },
      { secret: this.options.jwtSecret, expiresInSeconds: this.options.accessTokenTtlSeconds },
    );

    const refreshToken = generateOpaqueToken(params.restaurantId);
    await tx.insert(schema.sessions).values({
      restaurantId: params.restaurantId,
      userId: params.userId,
      refreshTokenHash: hashOpaqueToken(refreshToken),
      expiresAt: new Date(Date.now() + this.refreshTokenTtlMs),
    });

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string): Promise<LoginResult> {
    const restaurantId = parseOpaqueTokenRestaurantId(refreshToken);
    if (!restaurantId) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
    }
    const tokenHash = hashOpaqueToken(refreshToken);

    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({
          sessionId: schema.sessions.id,
          userId: schema.sessions.userId,
          expiresAt: schema.sessions.expiresAt,
          revokedAt: schema.sessions.revokedAt,
          roleKey: schema.roles.key,
          branchId: schema.users.branchId,
          userStatus: schema.users.status,
        })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
        .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
        .where(and(eq(schema.sessions.restaurantId, restaurantId), eq(schema.sessions.refreshTokenHash, tokenHash)));

      const session = rows[0];
      if (
        !session ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() < Date.now() ||
        session.userStatus !== "active"
      ) {
        throw new UnauthorizedException(INVALID_REFRESH_TOKEN);
      }

      // Rotate on every use: revoke this session, issue a fresh one. A stolen refresh
      // token that's already been used by its legitimate owner can't be replayed.
      await tx
        .update(schema.sessions)
        .set({ revokedAt: new Date(), lastUsedAt: new Date() })
        .where(eq(schema.sessions.id, session.sessionId));

      return this.issueSession(tx, {
        restaurantId,
        userId: session.userId,
        roleKey: session.roleKey,
        branchId: session.branchId,
      });
    });
  }

  /** Idempotent and silent on an already-meaningless token — logout should never be a
   * user-facing error just because the client's token was already stale. */
  async logout(refreshToken: string): Promise<void> {
    const restaurantId = parseOpaqueTokenRestaurantId(refreshToken);
    if (!restaurantId) return;
    const tokenHash = hashOpaqueToken(refreshToken);

    await withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.restaurantId, restaurantId),
            eq(schema.sessions.refreshTokenHash, tokenHash),
            isNull(schema.sessions.revokedAt),
          ),
        ),
    );
  }

  /** Returns null whether the restaurant or the email didn't match — same "nothing to
   * report" response either way, for the same no-enumeration reason as login(). */
  async requestPasswordReset(params: { restaurantSlug: string; email: string }): Promise<{ resetToken: string } | null> {
    let restaurantId: string;
    try {
      restaurantId = await this.resolveRestaurantId(params.restaurantSlug);
    } catch {
      return null;
    }

    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.restaurantId, restaurantId),
            eq(schema.users.email, params.email),
            eq(schema.users.status, "active"),
          ),
        );
      const user = rows[0];
      if (!user) return null;

      const resetToken = generateOpaqueToken(restaurantId);
      await tx.insert(schema.passwordResetTokens).values({
        restaurantId,
        userId: user.id,
        tokenHash: hashOpaqueToken(resetToken),
        expiresAt: new Date(Date.now() + this.passwordResetTtlMs),
      });

      return { resetToken };
    });
  }

  async resetPassword(params: { resetToken: string; newPassword: string }): Promise<void> {
    const restaurantId = parseOpaqueTokenRestaurantId(params.resetToken);
    if (!restaurantId) {
      throw new UnauthorizedException(INVALID_RESET_TOKEN);
    }
    const tokenHash = hashOpaqueToken(params.resetToken);

    await withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({
          id: schema.passwordResetTokens.id,
          userId: schema.passwordResetTokens.userId,
          expiresAt: schema.passwordResetTokens.expiresAt,
          usedAt: schema.passwordResetTokens.usedAt,
        })
        .from(schema.passwordResetTokens)
        .where(
          and(eq(schema.passwordResetTokens.restaurantId, restaurantId), eq(schema.passwordResetTokens.tokenHash, tokenHash)),
        );

      const resetRow = rows[0];
      if (!resetRow || resetRow.usedAt !== null || resetRow.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedException(INVALID_RESET_TOKEN);
      }

      const newPasswordHash = await hashPassword(params.newPassword);
      await tx
        .update(schema.users)
        .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
        .where(eq(schema.users.id, resetRow.userId));
      await tx.update(schema.passwordResetTokens).set({ usedAt: new Date() }).where(eq(schema.passwordResetTokens.id, resetRow.id));

      // A password reset must invalidate every existing login — otherwise a stolen
      // session survives the very action meant to kick the attacker out.
      await tx
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.sessions.userId, resetRow.userId), isNull(schema.sessions.revokedAt)));
    });
  }
}
