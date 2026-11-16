-- P2-36: the branch's paired-device roster, as last fetched from the server
-- while online — wholesale replace on every refresh (same "server's version
-- wins" convention as menu_cache), so hub_auth.rs can verify a peer entirely
-- offline against whatever was cached here, surviving a restart.
CREATE TABLE hub_device_roster (
    device_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL
);
