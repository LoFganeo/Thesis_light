const { db } = require('@vercel/postgres');

module.exports = async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }
  const { action = 'complete', sessionId, sentCount, droppedCount, hadCountdown, stats = {} } = request.body || {};
  if (!sessionId) {
    return response.status(400).json({ ok: false, error: 'sessionId is required' });
  }
  if (!process.env.POSTGRES_URL) {
    return response.status(200).json({ ok: true, note: 'No DB configured; finish-session noop' });
  }
  const sid = String(sessionId);
  const sentNum = Number(sentCount) || 0;
  const droppedNum = Number(droppedCount) || 0;
  const countdownFlag = hadCountdown === true || hadCountdown === 'true';

  let client;
  try {
    client = await db.connect();
    await client.sql`BEGIN`;

    await client.sql`
      CREATE TABLE IF NOT EXISTS thesis_session_meta (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT UNIQUE,
        action TEXT,
        sent_count INTEGER,
        dropped_count INTEGER,
        had_countdown BOOLEAN,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    await client.sql`ALTER TABLE thesis_session_meta DROP COLUMN IF EXISTS had_preview;`;

    const sessionRes = await client.sql`
      SELECT * FROM thesis_sessions WHERE session_id = ${sid} FOR UPDATE;
    `;

    if (!sessionRes.rows.length) {
      await client.sql`ROLLBACK`;
      return response.status(404).json({ ok: false, error: 'Session not found' });
    }

    const session = sessionRes.rows[0];

    const mergedStats = {
      playbackSeconds: Math.max(Number(session.playback_seconds) || 0, Number(stats.playbackSeconds) || 0),
      keypressCount: Math.max(Number(session.keypress_count) || 0, Number(stats.keypressCount) || 0),
      hitCount: Math.max(Number(session.hit_count) || 0, Number(stats.hitCount) || 0),
      negativeHitCount: Math.max(Number(session.negative_hit_count) || 0, Number(stats.negativeHitCount) || 0)
    };

    const meetsPlayback = mergedStats.playbackSeconds >= 30;
    const meetsKeypress = mergedStats.keypressCount >= 5;
    const meetsHits = mergedStats.hitCount >= 2;
    const zeroHitButPressed = mergedStats.keypressCount >= 5 && mergedStats.hitCount === 0;
    const allNegativeHits = mergedStats.hitCount === 0 && mergedStats.negativeHitCount > 0;
    const meetsAll = meetsPlayback && meetsKeypress && meetsHits && !zeroHitButPressed && !allNegativeHits;
    const thresholds = { meetsPlayback, meetsKeypress, meetsHits, zeroHitButPressed, allNegativeHits };

    await client.sql`
      INSERT INTO thesis_session_meta (session_id, action, sent_count, dropped_count, had_countdown)
      VALUES (${sid}, ${action}, ${sentNum}, ${droppedNum}, ${countdownFlag})
      ON CONFLICT (session_id)
      DO UPDATE SET
        action = EXCLUDED.action,
        sent_count = EXCLUDED.sent_count,
        dropped_count = EXCLUDED.dropped_count,
        had_countdown = EXCLUDED.had_countdown,
        created_at = NOW();
    `;

    if (meetsAll) {
      await client.sql`
        UPDATE thesis_sessions
        SET status = 'final',
            valid = TRUE,
            playback_seconds = ${mergedStats.playbackSeconds},
            keypress_count = ${mergedStats.keypressCount},
            hit_count = ${mergedStats.hitCount},
            negative_hit_count = ${mergedStats.negativeHitCount},
            last_event_at = NOW()
        WHERE session_id = ${sid};
      `;

      await client.sql`COMMIT`;
      return response.status(200).json({ ok: true, status: 'final', stats: mergedStats, thresholds });
    }

    await client.sql`DELETE FROM thesis_feedback WHERE session_id = ${sid};`;
    await client.sql`DELETE FROM thesis_logs WHERE session_id = ${sid};`;
    await client.sql`DELETE FROM thesis_sessions WHERE session_id = ${sid};`;

    await client.sql`COMMIT`;
    return response.status(200).json({ ok: false, status: 'released', stats: mergedStats, thresholds });
  } catch (error) {
    if (client) {
      try { await client.sql`ROLLBACK`; } catch (_) {}
    }
    console.error('[api/finish-session] Error:', error);
    return response.status(500).json({ ok: false, error: error.message });
  } finally {
    if (client) client.release();
  }
};
