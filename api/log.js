import { createPool } from '@vercel/postgres';

export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pool = createPool({
    connectionString: process.env.POSTGRES_URL,
  });

  try {
    const { participantId, audioTime, currentMode, lastSwitchTime } = await request.json();
    
    if (!participantId) {
      return new Response(JSON.stringify({ error: 'participantId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await pool.sql`
      INSERT INTO thesis_logs (participant_id, audio_time, current_mode, last_switch_time)
      VALUES (${participantId}, ${audioTime}, ${currentMode}, ${lastSwitchTime});
    `;
    
    return new Response(JSON.stringify({ message: 'Log saved' }), {
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
