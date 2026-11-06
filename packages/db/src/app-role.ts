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
`;
