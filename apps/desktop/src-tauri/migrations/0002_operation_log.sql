-- P1-24: every terminal write is meant to go into the same local transaction as its
-- entry here (rule 8). idempotency_key is UNIQUE so a retried operation — same
-- client-generated key, submitted twice because of a crash or a network retry —
-- can never produce a second row (rule 9); id (UUIDv7) is the operation's own
-- identity, kept distinct from idempotency_key per that rule's wording even though
-- in practice a caller will often make them equal.
CREATE TABLE operation_log (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    operation_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- NULL until the sync client (P1-25) gets a server ack for it; this migration
    -- only reserves the column; nothing here reads or writes it yet.
    synced_at TEXT
);

CREATE INDEX operation_log_unsynced_idx ON operation_log (created_at) WHERE synced_at IS NULL;
