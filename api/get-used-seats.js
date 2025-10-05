const { db } = require('@vercel/postgres');

module.exports = async (request, response) => {
  if (!process.env.POSTGRES_URL) {
    response.setHeader('X-Thesis-Degraded', 'true');
    return response.status(200).json({ seats: [], degraded: true });
  }
  try {
    const client = await db.connect();
    const { rows } = await client.sql`SELECT DISTINCT participant_id FROM thesis_sessions;`;
    const usedSeats = rows.map(r => r.participant_id);
    response.status(200).json({ seats: usedSeats, degraded: false });
  } catch (error) {
    console.error('[api/get-used-seats] Error fetching used seats:', error);
    response.setHeader('X-Thesis-Degraded', 'true');
    response.status(200).json({ seats: [], degraded: true, error: error.message });
  }
};
