const { db } = require('@vercel/postgres');

module.exports = async (request, response) => {
  if (!process.env.POSTGRES_URL) {
    response.setHeader('X-Thesis-Degraded', 'true');
    return response.status(200).json({ seats: [], degraded: true });
  }
  try {
    const client = await db.connect();

    const expired = await client.sql`
      DELETE FROM thesis_sessions
      WHERE status = 'pending'
        AND valid = FALSE
        AND NOW() - last_event_at > INTERVAL '5 minutes'
      RETURNING session_id;
    `;

    for (const row of expired.rows) {
      await client.sql`DELETE FROM thesis_logs WHERE session_id = ${row.session_id};`;
      await client.sql`DELETE FROM thesis_feedback WHERE session_id = ${row.session_id};`;
    }

    const { rows } = await client.sql`
      SELECT participant_id, assigned_seat
      FROM thesis_sessions
      WHERE status IN ('pending', 'final')
    `;
    const usedSeats = rows
      .map(r => r.assigned_seat && r.assigned_seat.trim().length ? r.assigned_seat : r.participant_id)
      .filter(Boolean);
    response.status(200).json({ seats: usedSeats, degraded: false });
  } catch (error) {
    console.error('[api/get-used-seats] Error fetching used seats:', error);
    response.setHeader('X-Thesis-Degraded', 'true');
    response.status(200).json({ seats: [], degraded: true, error: error.message });
  }
};
