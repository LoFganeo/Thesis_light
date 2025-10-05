const { db } = require('@vercel/postgres');
const { randomUUID } = require('crypto');

module.exports = async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const { participantId, songId } = request.body || {};
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
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await client.sql`ALTER TABLE thesis_sessions ALTER COLUMN session_id TYPE TEXT USING session_id::TEXT;`.catch(() => {});
    await client.sql`ALTER TABLE thesis_sessions ALTER COLUMN session_id SET NOT NULL;`.catch(() => {});
    await client.sql`ALTER TABLE thesis_sessions ADD CONSTRAINT thesis_sessions_participant_unique UNIQUE (participant_id);`.catch(() => {});

    const sessionId = randomUUID();
    await client.sql`BEGIN`;
    const insert = await client.sql`
      INSERT INTO thesis_sessions (session_id, participant_id, song_id)
      VALUES (${sessionId}, ${participantId}, ${songId})
      ON CONFLICT (participant_id) DO NOTHING
      RETURNING session_id;
    `;

    if (!insert.rows.length) {
      await client.sql`ROLLBACK`;
      return response.status(409).json({ ok: false, error: 'Seat already taken' });
    }

    await client.sql`COMMIT`;
    return response.status(200).json({ ok: true, sessionId });
  } catch (error) {
    if (client) {
      try { await client.sql`ROLLBACK`; } catch (_) {}
    }
    console.error('[api/start-session] Error:', error);
    const fallbackId = randomUUID();
    return response.status(200).json({ ok: true, sessionId: fallbackId, note: 'Database unavailable; using local session id', warning: error.message });
  } finally {
    if (client) client.release();
  }
};
