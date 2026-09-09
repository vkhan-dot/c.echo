-- Centras.Echo — Database Schema
-- Run: pnpm db:migrate

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Users ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    role        TEXT DEFAULT 'employee'
                CHECK (role IN ('admin', 'moderator', 'employee')),
    avatar_url  TEXT,
    password_hash TEXT NOT NULL DEFAULT 'GOOGLE_SSO_ONLY',
    google_id   TEXT UNIQUE,   -- linked Google sub on first SSO login
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Refresh Tokens ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ─── Meetings ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meetings (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title         TEXT NOT NULL,
    creator_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    livekit_room  TEXT UNIQUE NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    ended_at      TIMESTAMPTZ,
    duration_sec  INT,
    is_recorded   BOOLEAN DEFAULT FALSE,
    senti_status  TEXT DEFAULT 'none'
                  CHECK (senti_status IN ('none', 'processing', 'done', 'failed')),
    summary       JSONB,
    scheduled_start TIMESTAMPTZ,
    is_public     BOOLEAN DEFAULT FALSE,
    egress_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_meetings_creator   ON meetings(creator_id);
CREATE INDEX IF NOT EXISTS idx_meetings_created   ON meetings(created_at DESC);

-- Ensure columns exist in case the table was already created
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS egress_id TEXT;

-- ─── Meeting Participants ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meeting_participants (
    meeting_id  UUID REFERENCES meetings(id) ON DELETE CASCADE,
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_participants_meeting ON meeting_participants(meeting_id);
CREATE INDEX IF NOT EXISTS idx_participants_user    ON meeting_participants(user_id);

-- ─── Consent ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meeting_consents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id   UUID REFERENCES meetings(id) ON DELETE CASCADE,
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    consented_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_consents_meeting ON meeting_consents(meeting_id);

-- ─── Transcripts ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meeting_transcripts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id   UUID REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_name TEXT NOT NULL,
    phrase       TEXT NOT NULL,
    start_sec    INT NOT NULL,
    end_sec      INT,
    phrase_tsv   TSVECTOR GENERATED ALWAYS AS (
                   to_tsvector('russian', phrase)
                 ) STORED
);

CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON meeting_transcripts(meeting_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_transcripts_fts     ON meeting_transcripts USING GIN(phrase_tsv);

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participants ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS meetings_access ON meetings;
DROP POLICY IF EXISTS participants_access ON meeting_participants;
DROP POLICY IF EXISTS transcripts_access ON meeting_transcripts;
DROP POLICY IF EXISTS consents_access ON meeting_consents;

-- RLS policies based on session parameter app.current_user_id
CREATE POLICY meetings_access ON meetings
    FOR ALL
    USING (
        creator_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        OR EXISTS (
            SELECT 1 FROM meeting_participants mp
            WHERE mp.meeting_id = meetings.id
              AND mp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    );

CREATE POLICY participants_access ON meeting_participants
    FOR ALL
    USING (
        true
    );

CREATE POLICY transcripts_access ON meeting_transcripts
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM meeting_participants mp
            WHERE mp.meeting_id = meeting_transcripts.meeting_id
              AND mp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    );

CREATE POLICY consents_access ON meeting_consents
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM meeting_participants mp
            WHERE mp.meeting_id = meeting_consents.meeting_id
              AND mp.user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    );

-- ─── Waiting Room ─────────────────────────────────────────────────────────────

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS waiting_room_enabled BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS meeting_waiting_room (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id    UUID REFERENCES meetings(id) ON DELETE CASCADE,
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'admitted', 'rejected')),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (meeting_id, user_id)
);

ALTER TABLE meeting_waiting_room ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS waiting_room_access ON meeting_waiting_room;
CREATE POLICY waiting_room_access ON meeting_waiting_room
    FOR ALL
    USING (true);

-- ─── Host moderation ──────────────────────────────────────────────────────────

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS mute_on_entry BOOLEAN DEFAULT FALSE;

-- Current host (can be transferred). Defaults to creator on insert; backfilled below.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS host_id UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE meetings SET host_id = creator_id WHERE host_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_meetings_host ON meetings(host_id);

