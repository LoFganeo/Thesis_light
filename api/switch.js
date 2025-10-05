const { db } = require('@vercel/postgres');

module.exports = async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

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

    const client = await db.connect();
    await client.sql`
      CREATE TABLE IF NOT EXISTS thesis_switches (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        switch_time DOUBLE PRECISION,
        difficulty TEXT,
        mapping_id TEXT,
        delta_e DOUBLE PRECISION,
        entropy DOUBLE PRECISION,
        dist_to_beat DOUBLE PRECISION
      );
    `;

    try {
      await client.sql`ALTER TABLE thesis_switches ALTER COLUMN session_id TYPE TEXT USING session_id::TEXT;`;
    } catch (_) {}
    try {
      await client.sql`ALTER TABLE thesis_switches ALTER COLUMN session_id SET NOT NULL;`;
    } catch (_) {}

    const sid = String(sessionId);
    const st = typeof switchTime === 'number' ? switchTime : null;

    await client.sql`
      INSERT INTO thesis_switches (session_id, switch_time, difficulty, mapping_id, delta_e, entropy, dist_to_beat)
      VALUES (${sid}, ${st}, ${difficulty || null}, ${mappingId || null}, ${deltaE === null ? null : Number(deltaE)}, ${entropy === null ? null : Number(entropy)}, ${distToBeat === null ? null : Number(distToBeat)});
    `;

    return response.status(200).json({ ok: true });
  } catch (error) {
    console.error('[api/switch] Error:', error);
    return response.status(500).json({ ok: false, error: error.message });
  }
};
