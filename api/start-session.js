const { db } = require('@vercel/postgres');
const { randomUUID } = require('crypto');

module.exports = async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const { participantId, songId, assignedSeat, emailHash } = request.body || {};
  const normalizedSeat = (typeof assignedSeat === 'string' && assignedSeat.trim().length) ? assignedSeat.trim() : null;
  const normalizedEmailHash = (typeof emailHash === 'string' && emailHash.trim().length) ? emailHash.trim() : null;
  if (!participantId || !songId) {
    return response.status(400).json({ ok: false, error: 'participantId and songId are required' });
  }

  // If no DB configured, still return a deterministic UUID for the session lifecycle
  if (!process.env.POSTGRES_URL) {
    const fallbackId = randomUUID();
    return response.status(200).json({ ok: true, sessionId: fallbackId, note: 'No DB configured; running in local-only mode' });
  }

  let client;
  try {
    client = await db.connect();

    // Ensure table/constraint exist (run outside transaction to avoid abort-on-error behaviour)
    await client.sql`
      CREATE TABLE IF NOT EXISTS thesis_sessions (
        session_id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'pending',
        last_event_at TIMESTAMPTZ DEFAULT NOW(),
        playback_seconds DOUBLE PRECISION DEFAULT 0,
        keypress_count INTEGER DEFAULT 0,
        hit_count INTEGER DEFAULT 0,
        negative_hit_count INTEGER DEFAULT 0,
        valid BOOLEAN DEFAULT FALSE,
        assigned_seat TEXT,
        email_hash TEXT
      );
    `;
    await client.sql`ALTER TABLE thesis_sessions ALTER COLUMN session_id TYPE TEXT USING session_id::TEXT;`.catch(() => {});
    await client.sql`ALTER TABLE thesis_sessions ALTER COLUMN session_id SET NOT NULL;`.catch(() => {});
    await client.sql`ALTER TABLE thesis_sessions ADD CONSTRAINT thesis_sessions_participant_unique UNIQUE (participant_id);`.catch(() => {});
    await client.sql`ALTER TABLE thesis_sessions ADD COLUMN IF NOT EXISTS assigned_seat TEXT;`.catch(() => {});
    await client.sql`ALTER TABLE thesis_sessions ADD COLUMN IF NOT EXISTS email_hash TEXT;`.catch(() => {});
    await client.sql`CREATE UNIQUE INDEX IF NOT EXISTS thesis_sessions_assigned_seat_unique ON thesis_sessions (assigned_seat) WHERE assigned_seat IS NOT NULL;`.catch(() => {});

    const sessionId = randomUUID();
    await client.sql`BEGIN`;
    const insert = await client.sql`
      INSERT INTO thesis_sessions (
        session_id,
        participant_id,
        song_id,
        status,
        playback_seconds,
        keypress_count,
        hit_count,
        negative_hit_count,
        valid,
        last_event_at,
        created_at,
        assigned_seat,
        email_hash
      )
      VALUES (
        ${sessionId},
        ${participantId},
        ${songId},
        'pending',
        0,
        0,
        0,
        0,
        FALSE,
        NOW(),
        NOW(),
        ${normalizedSeat},
        ${normalizedEmailHash}
      )
      ON CONFLICT (participant_id) DO NOTHING
      RETURNING session_id;
    `;

    if (!insert.rows.length) {
      await client.sql`ROLLBACK`;
      return response.status(409).json({ ok: false, error: 'Participant already has an active session' });
    }

    await client.sql`COMMIT`;
    return response.status(200).json({ ok: true, sessionId, assignedSeat: normalizedSeat });
  } catch (error) {
    if (client) {
      try { await client.sql`ROLLBACK`; } catch (_) {}
    }
    console.error('[api/start-session] Error:', error);

    if (error && error.code === '23505' && String(error.message || '').includes('assigned_seat')) {
      return response.status(409).json({ ok: false, error: 'Seat already taken' });
    }

    const fallbackId = randomUUID();
    return response.status(200).json({ ok: true, sessionId: fallbackId, note: 'Database unavailable; using local session id', warning: error.message });
  } finally {
    if (client) client.release();
  }
};
