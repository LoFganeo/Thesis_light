const { db } = require('@vercel/postgres');
const { randomUUID } = require('crypto');

module.exports = async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const { participantId, emailHash, email } = request.body || {};
  const normalizedEmailHash = (typeof emailHash === 'string' && emailHash.trim().length) ? emailHash.trim() : null;
  const normalizedEmail = (typeof email === 'string' && email.trim().length) ? email.trim() : null;
  if (!participantId) {
    return response.status(400).json({ ok: false, error: 'participantId is required' });
  }

  // If no DB configured, still return a deterministic UUID for the session lifecycle
  if (!process.env.POSTGRES_URL) {
    const fallbackId = randomUUID();
    return response.status(200).json({ ok: true, sessionId: fallbackId, note: 'No DB configured; running in local-only mode' });
  }

  let client;
  try {
    client = await db.connect();

    // DDL operations removed - tables should already exist

    const sessionId = randomUUID();
    await client.sql`BEGIN`;
    const insert = await client.sql`
      INSERT INTO thesis_sessions (
        session_id,
        participant_id,
        status,
        playback_seconds,
        keypress_count,
        hit_count,
        anticipatory_count,
        valid,
        last_event_at,
        created_at,
        email_hash
      )
      VALUES (
        ${sessionId},
        ${participantId},
        'pending',
        0,
        0,
        0,
        0,
        FALSE,
        NOW(),
        NOW(),
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
