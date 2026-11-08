import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { useEffect, type ReactElement } from "react";

interface RollbackStatus {
  attempt: number;
  shouldRollBack: boolean;
  rollbackTargetVersion: string | null;
}

/**
 * Runs once a window is paired (a device token exists) — checks api-pos's
 * staged-rollout-aware update endpoint (P1-21) and installs anything it offers.
 *
 * If this install's own local boot-health tracking has decided the currently
 * running version is bad (see update_health.rs), this asks for that exact
 * previous version back via X-Rollback-To-Version instead of whatever's newest.
 * tauri.conf.json's `allowDowngrades: true` is what makes the updater actually
 * accept an older version as "an update" rather than silently rejecting it (the
 * default comparator only accepts newer ones). Renders nothing.
 */
export function UpdateChecker(): ReactElement | null {
  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const token = await invoke<string | null>("get_device_token");
      if (!token || cancelled) return;

      const rollback = await invoke<RollbackStatus>("rollback_status");
      const headers: Record<string, string> = { "X-Device-Token": token };
      if (rollback.shouldRollBack && rollback.rollbackTargetVersion) {
        headers["X-Rollback-To-Version"] = rollback.rollbackTargetVersion;
      }

      const update = await check({ headers });
      if (update && !cancelled) {
        // The installer replaces (and on Windows, exits) this process outside of
        // the normal window-close path — tell the watchdog (P1-22) this exit is
        // deliberate before it happens, so it doesn't race the install by also
        // trying to relaunch the old binary.
        await invoke("mark_clean_shutdown");
        await update.downloadAndInstall();
      }
    }

    run().catch((error: unknown) => {
      console.error("update check failed:", error);
    });

    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
