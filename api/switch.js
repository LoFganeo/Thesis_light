const { db } = require('@vercel/postgres');

module.exports = async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  let client;
  try {
    const {
      sessionId,
      switchTime,      // audio currentTime (sec)
      difficulty,      // 'easy' | 'normal' | 'hard'
      mappingId = null,
      deltaE = null,
      entropy = null,
      distToBeat = null,
    } = request.body || {};

    if (!sessionId) {
      return response.status(400).json({ ok: false, error: 'sessionId is required' });
    }

    client = await db.connect();
    // DDL operations removed - tables should already exist

    const sid = String(sessionId);
    const st = typeof switchTime === 'number' ? switchTime : null;

    await client.sql`
      INSERT INTO thesis_switches (session_id, switch_time, difficulty, mapping_id, delta_e, entropy, dist_to_beat)
      VALUES (${sid}, ${st}, ${difficulty || null}, ${mappingId || null}, ${deltaE === null ? null : Number(deltaE)}, ${entropy === null ? null : Number(entropy)}, ${distToBeat === null ? null : Number(distToBeat)});
    `;

    await client.sql`
      UPDATE thesis_sessions
      SET playback_seconds = GREATEST(playback_seconds, ${st || 0}),
          last_event_at    = NOW()
      WHERE session_id = ${sid} AND status = 'pending';
    `;

    return response.status(200).json({ ok: true });
  } catch (error) {
    console.error('[api/switch] Error:', error);
    return response.status(500).json({ ok: false, error: error.message });
  } finally {
    if (client) client.release();
  }
};
