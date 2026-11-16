-- P2-38: the hub's locally cached view of whatever's been shared across
-- devices through it (orders/table status/kitchen tickets) — a LAN
-- convenience cache, not a financial record (rule 3/4 don't apply here;
-- the real sale is still recorded through the real server once connectivity
-- returns). One row per (entity_kind, entity_id); `version` is a caller-
-- supplied monotonic number (see hub_state.rs) that decides which update
-- wins when two devices touch the same entity.
CREATE TABLE hub_shared_state (
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    origin_device_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (entity_kind, entity_id)
);
