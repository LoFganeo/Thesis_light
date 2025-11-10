const { db } = require('@vercel/postgres');

module.exports = async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { participantId, sessionId, audioTime, currentMode, lastSwitchTime } = request.body || {};

    if (!participantId) {
      return response.status(400).json({ error: 'participantId is required' });
    }
    if (!sessionId) {
      return response.status(400).json({ error: 'sessionId is required' });
    }

    const client = await db.connect();

    // DDL operations removed - tables should already exist
    // If you need to create tables, run migrations separately

    const at = typeof audioTime === 'number' ? audioTime : null;
    const lst = typeof lastSwitchTime === 'number' ? lastSwitchTime : null;
    const delta = at != null && lst != null ? at - lst : null;
    const sid = String(sessionId);

    await client.sql`
      INSERT INTO thesis_logs (participant_id, session_id, keypress_time, current_mode, last_switch_time, rt)
      VALUES (${participantId}, ${sid}, ${at}, ${currentMode || null}, ${lst}, ${delta});
    `;

    const isHit = typeof delta === 'number' && delta >= 0 && delta <= 2.0;
    const isNegative = typeof delta === 'number' && delta < 0 && delta >= -2.0;
    const playback = typeof at === 'number' && isFinite(at) ? at : 0;

    await client.sql`
      UPDATE thesis_sessions
      SET keypress_count     = keypress_count + 1,
          hit_count          = hit_count + ${isHit ? 1 : 0},
          anticipatory_count = anticipatory_count + ${isNegative ? 1 : 0},
          playback_seconds   = GREATEST(playback_seconds, ${playback}),
          last_event_at      = NOW()
      WHERE session_id = ${sid} AND status = 'pending';
    `;

    console.log(`[api/log] Saved log for session ${sid}`);
    response.status(200).json({ message: 'Log saved successfully' });

  } catch (error) {
    console.error('[api/log] Error saving log:', error);
    response.status(500).json({ error: error.message });
  }
};
