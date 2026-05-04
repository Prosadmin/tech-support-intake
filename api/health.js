/**
 * api/health.js
 * Vercel Serverless Function - ヘルスチェック
 */
'use strict';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const SITE_ID = (process.env.PLEASANTER_SITE_ID || '').trim();
  const API_KEY = (process.env.PLEASANTER_API_KEY || '').trim();

  res.status(200).json({
    status:                'ok',
    node_version:          process.version,
    timestamp:             new Date().toISOString(),
    pleasanter_configured: !!(SITE_ID && API_KEY),
    site_id:               SITE_ID || '未設定',
    api_key_length:        API_KEY.length,
  });
}
