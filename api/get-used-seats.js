import { createPool } from '@vercel/postgres';

export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  const pool = createPool({
    connectionString: process.env.POSTGRES_URL,
  });

  try {
    const { rows } = await pool.sql`SELECT DISTINCT participant_id FROM thesis_logs;`;
    const usedSeats = rows.map(r => r.participant_id);
    return new Response(JSON.stringify(usedSeats), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
