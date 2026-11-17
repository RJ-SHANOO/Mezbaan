-- P2-45: a completed offline sale, priced entirely from local data (no
-- network call in the sale path). `id` is a fresh client-generated UUIDv7
-- (rule 9) minted only once the write actually commits; `idempotency_key`
-- is the caller-supplied key a retried checkout attempt reuses, looked up
-- separately so a retry can still return the already-created invoice
-- rather than erroring. Append-only by convention — this crate never
-- defines an update/delete for these rows (rule 4's spirit, applied
-- locally; the real append-only enforcement is server-side once this
-- syncs there).
CREATE TABLE offline_invoices (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    document_number TEXT NOT NULL UNIQUE,
    order_type TEXT NOT NULL,
    currency TEXT NOT NULL,
    subtotal_minor TEXT NOT NULL,
    service_charge_minor TEXT NOT NULL,
    tax_base_minor TEXT NOT NULL,
    tax_minor TEXT NOT NULL,
    total_minor TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE offline_invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_minor TEXT NOT NULL,
    currency TEXT NOT NULL
);
CREATE INDEX offline_invoice_items_invoice_id_idx ON offline_invoice_items (invoice_id);

CREATE TABLE offline_invoice_item_modifiers (
    item_id INTEGER NOT NULL,
    modifier_option_id TEXT NOT NULL,
    name TEXT NOT NULL,
    unit_price_minor TEXT NOT NULL,
    currency TEXT NOT NULL
);
CREATE INDEX offline_invoice_item_modifiers_item_id_idx ON offline_invoice_item_modifiers (item_id);
