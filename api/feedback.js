const { db } = require('@vercel/postgres');

module.exports = async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { participantId, sessionId, timesGuessed, difficultyRating, comments } = request.body || {};

    if (!sessionId) {
      return response.status(400).json({ ok: false, error: 'sessionId is required' });
    }

    const client = await db.connect();
    // Ensure table exists + new column if missing
    await client.sql`
      CREATE TABLE IF NOT EXISTS thesis_feedback (
        id BIGSERIAL PRIMARY KEY,
        participant_id TEXT,
        session_id TEXT NOT NULL,
        times_guessed INTEGER,
        difficulty_rating INTEGER,
        comments TEXT
      );
    `;
    try {
      await client.sql`ALTER TABLE thesis_feedback ALTER COLUMN session_id TYPE TEXT USING session_id::TEXT;`;
    } catch (_) {}
    try {
      await client.sql`ALTER TABLE thesis_feedback ALTER COLUMN session_id SET NOT NULL;`;
    } catch (_) {}
    await client.sql`ALTER TABLE thesis_feedback ADD COLUMN IF NOT EXISTS difficulty_rating INTEGER;`;
    const diffNum = Number(difficultyRating);
    const timesNum = Number(timesGuessed);
    await client.sql`
      INSERT INTO thesis_feedback (participant_id, session_id, times_guessed, difficulty_rating, comments)
      VALUES (${participantId || null}, ${String(sessionId)}, ${Number.isFinite(timesNum) ? timesNum : null}, ${Number.isFinite(diffNum) ? diffNum : null}, ${comments || null});
    `;
    response.status(200).json({ ok: true });
  } catch (error) {
    console.error('[api/feedback] Error:', error);
    response.status(500).json({ ok: false, error: error.message });
  }
};
