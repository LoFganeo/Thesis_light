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
    // DDL operations removed - tables should already exist

    const diffNum = Number(difficultyRating);
    const timesNum = Number(timesGuessed);

    // Check for duplicate submission
    const existing = await client.sql`
      SELECT id FROM thesis_feedback WHERE session_id = ${String(sessionId)} LIMIT 1;
    `;

    if (existing.rows.length > 0) {
      console.log(`[api/feedback] Duplicate submission for session ${sessionId}, updating existing record`);
      await client.sql`
        UPDATE thesis_feedback
        SET participant_id = ${participantId || null},
            times_guessed = ${Number.isFinite(timesNum) ? timesNum : null},
            difficulty_rating = ${Number.isFinite(diffNum) ? diffNum : null},
            comments = ${comments || null}
        WHERE session_id = ${String(sessionId)};
      `;
    } else {
      await client.sql`
        INSERT INTO thesis_feedback (participant_id, session_id, times_guessed, difficulty_rating, comments, created_at)
        VALUES (${participantId || null}, ${String(sessionId)}, ${Number.isFinite(timesNum) ? timesNum : null}, ${Number.isFinite(diffNum) ? diffNum : null}, ${comments || null}, NOW());
      `;
    }

    response.status(200).json({ ok: true, message: 'Feedback submitted successfully' });
  } catch (error) {
    console.error('[api/feedback] Error:', error);
    response.status(500).json({ ok: false, error: error.message });
  }
};
