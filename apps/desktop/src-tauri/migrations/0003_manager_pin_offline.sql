-- P1-27b: staff + PIN hashes synced down from P1-27's signed snapshot, and this
-- terminal's own local record of failed-PIN attempts/lockout — tracked separately
-- from the server's counter, since there's no server round-trip while offline.
CREATE TABLE offline_staff (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    role_key TEXT NOT NULL,
    branch_id TEXT,
    status TEXT NOT NULL,
    pin_hash TEXT,
    snapshot_version TEXT NOT NULL
);

CREATE TABLE offline_pin_lockout (
    user_id TEXT PRIMARY KEY,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT
);
