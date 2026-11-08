-- P1-28: one counter per terminal, purely local — no server round-trip needed to
-- produce a new document number, which is the whole point (rule 10: offline
-- terminals cannot collide, since each terminal's branch_number/terminal_number
-- pair — synced down at pairing time, server-assigned and UNIQUE — makes its
-- series distinct from every other terminal's regardless of what either one does
-- offline). Never reset: a reused number is exactly the collision this exists to
-- prevent.
CREATE TABLE document_number_sequence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_number INTEGER NOT NULL
);

INSERT INTO document_number_sequence (id, next_number) VALUES (1, 1);
