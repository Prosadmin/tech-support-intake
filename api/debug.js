'use strict';

/**
 * api/debug.js
 * Pleasanter への送信内容を確認するデバッグ用エンドポイント
 * 確認後は削除すること
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const SITE_ID = (process.env.PLEASANTER_SITE_ID || '').trim();
  const API_KEY = (process.env.PLEASANTER_API_KEY || '').trim();

  // Pleasanter に送るリクエストボディを組み立てる
  const record = {
    Title:        '[TEST] テスト会社 テスト店舗',
    ClassA:       'WEB-TEST-001',
    ClassB:       'web',
    ClassC:       'テスト依頼者区分',
    ClassD:       'テスト会社',
    ClassE:       'テスト太郎',
    ClassF:       '技術相談',
    ClassG:       '低い',
    ClassH:       'テスト店舗',
    ClassI:       'その他',
    ClassJ:       'テストメーカー',
    DescriptionA: '東京都千代田区テスト1-2-3',
    DescriptionD: 'テスト症状です',
    DescriptionF: '営業継続可能',
    DateA:        '2026/05/04 17:00:00',
  };

  const requestBody = {
    ApiVersion: 1.1,
    ApiKey:     API_KEY,
    Record:     record,
  };

  // まず送信内容を返す
  const bodyStr = JSON.stringify(requestBody, null, 2);

  try {
    const plRes = await fetch(
      `https://pleasanter.net/fs/api/items/${SITE_ID}/create`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body:    JSON.stringify(requestBody),
      }
    );

    const text = await plRes.text();

    return res.status(200).json({
      sent_to:        `https://pleasanter.net/fs/api/items/${SITE_ID}/create`,
      sent_body:      requestBody,
      pleasanter_status: plRes.status,
      pleasanter_response: text,
    });

  } catch (e) {
    return res.status(500).json({
      error:     e.message,
      sent_body: requestBody,
    });
  }
};
