import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get comprehensive stats in one query
    const stats = await sql`
      WITH latest_feedback AS (
        SELECT DISTINCT ON (session_id)
          session_id,
          times_guessed,
          difficulty_rating
        FROM thesis_feedback
        ORDER BY session_id, id DESC
      ),
      valid_sessions AS (
        SELECT
          s.session_id,
          s.participant_id,
          s.playback_seconds,
          s.keypress_count,
          s.hit_count,
          s.anticipatory_count,
          f.times_guessed,
          f.difficulty_rating,
          s.created_at,
          CASE
            WHEN s.keypress_count > 0
            THEN ROUND((s.hit_count::numeric / s.keypress_count * 100), 1)
            ELSE 0
          END as hit_rate_pct
        FROM thesis_sessions s
        LEFT JOIN latest_feedback f ON s.session_id = f.session_id
        WHERE s.status = 'final' AND s.valid = true
      ),
      session_counts AS (
        SELECT
          status,
          COUNT(*) as count,
          COUNT(CASE WHEN valid = true THEN 1 END) as valid_count
        FROM thesis_sessions
        GROUP BY status
      ),
      meta_counts AS (
        SELECT action, COUNT(*) as count
        FROM thesis_session_meta
        GROUP BY action
      )
      SELECT
        (SELECT COUNT(DISTINCT session_id) FROM valid_sessions) as total_valid_sessions,
        (SELECT COUNT(DISTINCT participant_id) FROM valid_sessions) as unique_participants,
        (SELECT ROUND(AVG(playback_seconds)::numeric, 2) FROM valid_sessions) as avg_playback,
        (SELECT ROUND(AVG(keypress_count)::numeric, 2) FROM valid_sessions) as avg_keypresses,
        (SELECT ROUND(AVG(hit_count)::numeric, 2) FROM valid_sessions) as avg_hits,
        (SELECT ROUND(AVG(hit_rate_pct)::numeric, 1) FROM valid_sessions) as avg_hit_rate_pct,
        (SELECT ROUND(AVG(difficulty_rating)::numeric, 2) FROM valid_sessions WHERE difficulty_rating IS NOT NULL) as avg_difficulty,
        (SELECT COUNT(*) FROM valid_sessions WHERE hit_rate_pct >= 65) as high_quality_count,
        (SELECT COUNT(*) FROM valid_sessions WHERE hit_rate_pct < 35) as low_quality_count,
        (SELECT json_agg(row_to_json(t)) FROM (SELECT * FROM session_counts) t) as session_status,
        (SELECT json_agg(row_to_json(t)) FROM (SELECT * FROM meta_counts) t) as meta_actions,
        (SELECT json_agg(row_to_json(t)) FROM (
          SELECT participant_id, keypress_count, hit_count, hit_rate_pct,
                 times_guessed, difficulty_rating, created_at
          FROM valid_sessions
          ORDER BY created_at DESC
          LIMIT 10
        ) t) as recent_sessions,
        (SELECT json_agg(row_to_json(t)) FROM (
          SELECT participant_id, keypress_count, hit_count, hit_rate_pct, difficulty_rating
          FROM valid_sessions
          WHERE hit_rate_pct < 35
          ORDER BY hit_rate_pct ASC
        ) t) as confused_sessions,
        (SELECT json_agg(row_to_json(t)) FROM (
          SELECT participant_id, keypress_count, hit_count, hit_rate_pct, difficulty_rating
          FROM valid_sessions
          WHERE hit_rate_pct >= 75
          ORDER BY hit_rate_pct DESC
        ) t) as high_performers
    `;

    const result = stats[0];

    // Calculate completion rate
    const sessionStatus = result.session_status || [];
    const totalSessions = sessionStatus.reduce((sum, s) => sum + parseInt(s.count), 0);
    const completionRate = totalSessions > 0
      ? ((result.total_valid_sessions / totalSessions) * 100).toFixed(1)
      : 0;

    // Format response
    const response = {
      summary: {
        total_valid_sessions: parseInt(result.total_valid_sessions) || 0,
        unique_participants: parseInt(result.unique_participants) || 0,
        total_sessions: totalSessions,
        completion_rate: `${completionRate}%`,
        high_quality_data: parseInt(result.high_quality_count) || 0,
        confused_participants: parseInt(result.low_quality_count) || 0
      },
      averages: {
        playback_seconds: parseFloat(result.avg_playback) || 0,
        keypresses: parseFloat(result.avg_keypresses) || 0,
        hits: parseFloat(result.avg_hits) || 0,
        hit_rate: `${result.avg_hit_rate_pct || 0}%`,
        difficulty: parseFloat(result.avg_difficulty) || 0
      },
      session_breakdown: {
        by_status: result.session_status || [],
        by_action: result.meta_actions || []
      },
      recent_sessions: result.recent_sessions || [],
      data_quality: {
        high_performers: result.high_performers || [],
        confused_sessions: result.confused_sessions || []
      },
      timestamp: new Date().toISOString()
    };

    res.status(200).json(response);

  } catch (error) {
    console.error('Stats query failed:', error);
    res.status(500).json({
      error: 'Failed to fetch statistics',
      message: error.message
    });
  }
}
