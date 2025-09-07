import { sql } from '@vercel/postgres';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { rows } = await sql`
      SELECT DISTINCT participant_id FROM thesis_logs;
    `;
    const usedSeatIds = rows.map(r => r.participant_id);
    return response.status(200).json(usedSeatIds);
  } catch (error) {
    console.error('Error fetching used seats:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
