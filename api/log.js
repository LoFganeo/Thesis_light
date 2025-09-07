import { sql } from '@vercel/postgres';

export default async function handler(request, response) {
  // 确保是 POST 请求
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 从请求体中解析数据
    const { participantId, audioTime, currentMode, lastSwitchTime } = request.body;

    // 简单的数据验证
    if (!participantId || audioTime === undefined || !currentMode || lastSwitchTime === undefined) {
      return response.status(400).json({ error: 'Missing required fields' });
    }

    // 将数据插入数据库
    await sql`
      INSERT INTO thesis_logs (participant_id, audio_time, current_mode, last_switch_time)
      VALUES (${participantId}, ${audioTime}, ${currentMode}, ${lastSwitchTime});
    `;

    // 返回成功响应
    return response.status(200).json({ message: 'Log saved successfully' });

  } catch (error) {
    console.error('Error saving log:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
