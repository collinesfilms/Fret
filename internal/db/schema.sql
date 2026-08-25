-- Fret schema. SQLite, one file, WAL mode.
--
-- Sizes are bytes. Times are unix seconds UTC. Nothing here is large: the
-- bytes live in S3 and this database only ever holds bookkeeping.

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    subject         TEXT NOT NULL UNIQUE,   -- OIDC `sub`, the stable identity
    email           TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT '',
    -- Per-user preferences. These follow the account between devices, which
    -- is why they are here and not in localStorage.
    theme           TEXT NOT NULL DEFAULT 'system',   -- system | light | dark
    slug_style      TEXT NOT NULL DEFAULT 'code',     -- code | words
    slug_length     INTEGER NOT NULL DEFAULT 8,       -- characters, code style
    default_expiry  TEXT NOT NULL DEFAULT '7d',       -- 24h | 7d | 30d | never
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,           -- random 256-bit token id
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- A transfer is a slug plus a set of files. The slug is reserved the moment
-- the upload starts (status 'pending') so it can be edited while bytes move,
-- but only resolves publicly once status becomes 'live'.
CREATE TABLE IF NOT EXISTS transfers (
    id             TEXT PRIMARY KEY,        -- opaque internal id
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status         TEXT NOT NULL DEFAULT 'pending',  -- pending | live | deleted
    password_hash  TEXT NOT NULL DEFAULT '',         -- argon2id, '' = open
    -- The slug the link was first copied under, recorded once and never
    -- overwritten. It is what the restore tag offers, and slug uniqueness
    -- consults it too, so the name stays reserved and restoring always works.
    shared_slug    TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
    -- Both forms of the expiry are kept: the timestamp drives the sweeper,
    -- the symbol drives which segment the edit control shows as selected.
    expiry         TEXT NOT NULL DEFAULT '7d',       -- 24h | 7d | 30d | never
    expires_at     INTEGER,                          -- NULL = never
    total_bytes    INTEGER NOT NULL DEFAULT 0,
    downloads      INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    completed_at   INTEGER,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_expiry ON transfers(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);

CREATE TABLE IF NOT EXISTS files (
    id           TEXT PRIMARY KEY,
    transfer_id  TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,             -- flattened display name, unique per transfer
    size         INTEGER NOT NULL,
    object_key   TEXT NOT NULL,             -- key in the bucket
    upload_id    TEXT NOT NULL DEFAULT '',  -- S3 multipart id while in flight
    part_size    INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending | complete
    crc32        INTEGER,                   -- optional, supplied by the client
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_transfer ON files(transfer_id, position);

-- One row per successfully uploaded part. This table is the whole resume
-- story: on reconnect the client asks what is already here and uploads only
-- the gaps.
CREATE TABLE IF NOT EXISTS parts (
    file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    part_number  INTEGER NOT NULL,
    etag         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    uploaded_at  INTEGER NOT NULL,
    PRIMARY KEY (file_id, part_number)
);

-- Short-lived grants proving a recipient entered the right password.
CREATE TABLE IF NOT EXISTS unlocks (
    token       TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unlocks_expiry ON unlocks(expires_at);
