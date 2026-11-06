/**
 * Postgres superusers and table owners bypass row-level security unconditionally.
 * Migrations run as the owner (DATABASE_URL); everything else — the app and tests —
 * must connect as this restricted, non-superuser role for RLS to actually apply.
 */
export const APP_ROLE_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mezbaan_app') THEN
    CREATE ROLE mezbaan_app LOGIN PASSWORD 'mezbaan_app_dev_password';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO mezbaan_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mezbaan_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mezbaan_app;

-- Append-only tables (rule 4's "never update or delete" — audit_logs isn't a
-- financial table, but "append-only audit log" means the same thing): revoke the
-- UPDATE/DELETE the broad grant above just gave, even though app code never issues
-- those statements against them. This is the second barrier, same reasoning as RLS.
-- Runs every migrate:run, idempotently — revoking an already-revoked privilege is a
-- no-op. Add a line here whenever a new append-only table is introduced.
REVOKE UPDATE, DELETE ON audit_logs FROM mezbaan_app;

-- Commission rate locked at registration (rule 7): revoke the blanket UPDATE the
-- broad grant above just gave and re-grant it only for the columns allowed to change
-- after signup (name, status, updated_at) — commission_rate_basis_points is excluded,
-- so no code path, today or in the future, can alter it once P1-15 sets it. A
-- column-level GRANT can't narrow an existing table-level one on its own; the
-- table-level UPDATE has to be revoked first, which is why both lines are needed.
REVOKE UPDATE ON restaurants FROM mezbaan_app;
GRANT UPDATE (name, status, updated_at) ON restaurants TO mezbaan_app;
`;
