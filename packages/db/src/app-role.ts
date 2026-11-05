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
`;
