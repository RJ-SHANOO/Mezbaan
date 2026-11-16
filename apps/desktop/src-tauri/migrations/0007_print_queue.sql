-- P2-32: a persistent, local print queue so a printer failure never loses a
-- print job across an app restart (rule 13/14) — enqueue is a plain INSERT
-- that survives a crash the same way operation_log's writes do; actually
-- sending happens later, outside any DB lock (see print_queue.rs).
CREATE TABLE print_jobs (
    id TEXT PRIMARY KEY,
    printer_connection TEXT NOT NULL, -- JSON PrinterConnectionConfig
    data BLOB NOT NULL,               -- raw ESC/POS bytes
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'printing', 'failed', 'done', 'dead_letter')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_error TEXT,
    is_copy INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX print_jobs_status_idx ON print_jobs (status, next_attempt_at);
