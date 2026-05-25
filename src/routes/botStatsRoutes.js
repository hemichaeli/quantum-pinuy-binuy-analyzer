// AI bot fetch dashboard endpoints.
// Reads aggregates from the `bot_fetches` table populated by
// src/services/aiBotLogger.js — so QUANTUM operators can see which AI
// assistants are crawling the AI-Discovery surface and how often.
//
// Endpoints:
//   GET /api/discovery/bot-stats              - summary aggregates (24h / 7d / 30d)
//   GET /api/discovery/bot-stats/recent       - last 50 raw fetches
//   GET /api/discovery/bot-stats/by-bot       - per-bot detail (paths, last_seen)

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

async function tableMissing() {
  const { rows } = await pool.query(`SELECT to_regclass('public.bot_fetches') AS t`);
  return rows[0]?.t == null;
}

router.get('/bot-stats', async (req, res) => {
  try {
    if (await tableMissing()) {
      return res.json({ ok: false, error: 'bot_fetches table not migrated yet', tip: 'restart analyzer to run migration 033' });
    }
    const [summary, top, lastSeen] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total_all_time,
          COUNT(*) FILTER (WHERE fetched_at >= NOW() - INTERVAL '24 hours') AS last_24h,
          COUNT(*) FILTER (WHERE fetched_at >= NOW() - INTERVAL '7 days')   AS last_7d,
          COUNT(*) FILTER (WHERE fetched_at >= NOW() - INTERVAL '30 days')  AS last_30d,
          COUNT(DISTINCT bot_name) AS distinct_bots,
          MIN(fetched_at) AS first_ever_fetch,
          MAX(fetched_at) AS last_ever_fetch
        FROM bot_fetches
      `),
      pool.query(`
        SELECT bot_name,
               COUNT(*) AS fetches_7d,
               COUNT(DISTINCT path) AS distinct_paths,
               MAX(fetched_at) AS last_seen
        FROM bot_fetches
        WHERE fetched_at >= NOW() - INTERVAL '7 days'
        GROUP BY bot_name
        ORDER BY fetches_7d DESC
      `),
      pool.query(`
        SELECT bot_name, MIN(fetched_at) AS first_seen, MAX(fetched_at) AS last_seen, COUNT(*) AS total
        FROM bot_fetches
        GROUP BY bot_name
        ORDER BY last_seen DESC
      `),
    ]);

    res.json({
      generated_at: new Date().toISOString(),
      summary: summary.rows[0],
      top_bots_7d: top.rows,
      bots_history: lastSeen.rows,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/bot-stats/recent', async (req, res) => {
  try {
    if (await tableMissing()) return res.json({ items: [], note: 'table not yet migrated' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const { rows } = await pool.query(`
      SELECT bot_name, path, status_code, response_bytes, ip::text AS ip, fetched_at
      FROM bot_fetches
      ORDER BY fetched_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ items: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/bot-stats/by-bot', async (req, res) => {
  try {
    if (await tableMissing()) return res.json({ bots: [] });
    const { rows } = await pool.query(`
      WITH path_counts AS (
        SELECT bot_name, path, COUNT(*) AS cnt
        FROM bot_fetches
        GROUP BY bot_name, path
      ),
      top_paths AS (
        SELECT bot_name,
               json_agg(json_build_object('path', path, 'count', cnt) ORDER BY cnt DESC) AS top_paths
        FROM (
          SELECT bot_name, path, cnt,
                 ROW_NUMBER() OVER (PARTITION BY bot_name ORDER BY cnt DESC) AS rn
          FROM path_counts
        ) ranked
        WHERE rn <= 10
        GROUP BY bot_name
      )
      SELECT b.bot_name,
             COUNT(*) AS total_fetches,
             COUNT(*) FILTER (WHERE b.fetched_at >= NOW() - INTERVAL '24 hours') AS last_24h,
             COUNT(*) FILTER (WHERE b.fetched_at >= NOW() - INTERVAL '7 days')   AS last_7d,
             MIN(b.fetched_at) AS first_seen,
             MAX(b.fetched_at) AS last_seen,
             COALESCE(tp.top_paths, '[]'::json) AS top_paths
      FROM bot_fetches b
      LEFT JOIN top_paths tp ON tp.bot_name = b.bot_name
      GROUP BY b.bot_name, tp.top_paths
      ORDER BY total_fetches DESC
    `);
    res.json({ bots: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
