/**
 * server.js
 * 技術相談・故障受付 中継APIサーバー (Node.js + Express)
 *
 * 主な役割：
 *   1. フロントエンド（public/）の静的ファイルを配信する
 *   2. POST /api/intake でフォームデータを受け取る
 *   3. サーバー側バリデーションを行う
 *   4. 受付番号を採番する
 *   5. Pleasanter.net の upsert API に案件を登録する
 *   6. ブラウザに受付番号・受付日時を返す
 *
 * 将来の拡張ポイント（AIゲートウェイ追加時）：
 *   - callPleasanter() の前に callAiGateway() を呼ぶ形で挿入できます
 *   - AIゲートウェイのエンドポイントは .env で管理してください
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');   // HTTP クライアント（Pleasanter呼び出し用）
require('dotenv').config();              // .env を読み込む

const app = express();

// ============================================================
// 環境変数の取得
// ============================================================
const PORT               = process.env.PORT               || 3000;
const PLEASANTER_SITE_ID = process.env.PLEASANTER_SITE_ID || '';
const PLEASANTER_API_KEY = process.env.PLEASANTER_API_KEY || '';

// 起動時に必須の環境変数が設定されているか確認する
if (!PLEASANTER_SITE_ID || !PLEASANTER_API_KEY) {
  console.warn(
    '[WARN] PLEASANTER_SITE_ID または PLEASANTER_API_KEY が設定されていません。' +
    '.env ファイルを確認してください。'
  );
}

// ============================================================
// ミドルウェア設定
// ============================================================

// CORS：ローカル開発用（http://localhost:PORT からのみ許可）
// 本番環境では origin を実際のドメインに変更すること
app.use(cors({
  origin: [
    `http://localhost:${PORT}`,
    'http://127.0.0.1:' + PORT,
  ],
  methods: ['GET', 'POST'],
}));

// JSON ボディのパース（最大 1MB）
app.use(express.json({ limit: '1mb' }));

// 静的ファイル配信（public/ フォルダ）
app.use(express.static('public'));

// ============================================================
// Pleasanter.net の列マッピング定義
// ============================================================
// 実際の列名が変わった場合はここだけ修正すればOKです
//
// Pleasanter の「自由項目（ClassA 〜）」と「説明項目（DescriptionA 〜）」
// および日付項目（DateA）のマッピングを定数で管理します
//
const PLEASANTER_COLUMNS = {
  ClassA:       'CaseKey',         // 受付番号（upsert の Keys にも使用）
  ClassB:       'channel',         // チャネル (web / etc.)
  ClassC:       'requester_type',  // 依頼者区分
  ClassD:       'company_name',    // 会社名
  ClassE:       'person_name',     // 担当者名
  ClassF:       'request_type',    // 受付種別
  ClassG:       'urgency',         // 緊急度
  ClassH:       'store_name',      // 店舗名
  ClassI:       'equipment_type',  // 機器区分
  ClassJ:       'maker',           // メーカー
  DescriptionA: 'store_address',   // 設置場所住所
  DescriptionB: 'model',           // 型式
  DescriptionC: 'error_code',      // エラーコード
  DescriptionD: 'symptoms',        // 症状
  DescriptionE: 'actions_taken',   // 実施済み対応
  DescriptionF: 'business_impact', // 営業影響
  DescriptionG: 'notes',           // 補足事項
  DateA:        'received_at',     // 受付日時
};

// ============================================================
// 受付番号の採番
// ============================================================
// MVP では インメモリのカウンタを使用します
// 本番環境ではデータベースやファイルで永続化してください

/** 受付番号カウンタ（日付が変わったらリセット） */
let counterDate  = '';
let counterValue = 0;

/**
 * 受付番号を生成する
 * 形式：WEB-YYYYMMDD-0001
 *
 * @returns {string} 受付番号
 */
function generateCaseKey() {
  const now  = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const dd   = String(now.getDate()).padStart(2, '0');
  const today = `${yyyy}${mm}${dd}`;

  // 日付が変わったらカウンタをリセット
  if (counterDate !== today) {
    counterDate  = today;
    counterValue = 0;
  }

  counterValue += 1;
  const seq = String(counterValue).padStart(4, '0');

  return `WEB-${today}-${seq}`;
}

// ============================================================
// サーバー側バリデーション
// ============================================================

/** 必須フィールド一覧 */
const REQUIRED_FIELDS = [
  'requester_type',
  'company_name',
  'person_name',
  'email',
  'phone',
  'request_type',
  'urgency',
  'store_name',
  'store_address',
  'equipment_type',
  'symptoms',
  'business_impact',
];

/**
 * リクエストボディを検証する
 *
 * @param {Object} body - リクエストボディ
 * @returns {string|null} エラーメッセージ（問題なければ null）
 */
function validateRequest(body) {
  // 必須フィールドの存在チェック
  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || String(body[field]).trim() === '') {
      return `必須項目 "${field}" が未入力です`;
    }
  }

  // メール形式チェック
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(body.email)) {
    return 'メールアドレスの形式が正しくありません';
  }

  return null;  // 問題なし
}

// ============================================================
// Pleasanter.net 登録処理
// ============================================================

/**
 * Pleasanter.net の upsert API にデータを登録する
 *
 * upsert API の仕様：
 *   POST https://pleasanter.net/fs/api/items/{siteId}/upsert
 *   Body: { ApiVersion: 1.1, ApiKey: "...", Keys: ["ClassA"], Record: { ... } }
 *
 * Keys に ClassA（CaseKey）を指定しているため、
 * 同じ受付番号が存在する場合は更新、存在しない場合は新規作成されます
 *
 * @param {Object} payload - 送信するデータ
 * @param {string} caseKey - 受付番号
 * @param {string} receivedAt - 受付日時 (ISO 8601 形式)
 * @returns {Promise<Object>} Pleasanter からのレスポンス
 */
async function callPleasanter(payload, caseKey, receivedAt) {
  const url = `https://pleasanter.net/fs/api/items/${PLEASANTER_SITE_ID}/upsert`;

  // ---- Pleasanter に送る Record オブジェクトを組み立てる ----
  // PLEASANTER_COLUMNS の定義に従って動的にマッピングする
  const record = {};
  for (const [pleasanterCol, payloadKey] of Object.entries(PLEASANTER_COLUMNS)) {
    if (pleasanterCol === 'DateA') {
      // 日付は receivedAt を使用
      record[pleasanterCol] = receivedAt;
    } else if (pleasanterCol === 'ClassA') {
      // 受付番号は caseKey を使用
      record[pleasanterCol] = caseKey;
    } else {
      record[pleasanterCol] = payload[payloadKey] || '';
    }
  }

  const requestBody = {
    ApiVersion: 1.1,
    ApiKey:     PLEASANTER_API_KEY,
    Keys:       ['ClassA'],  // upsert のキー項目（受付番号）
    Record:     record,
  };

  console.log('[Pleasanter] POST', url);
  console.log('[Pleasanter] Record:', JSON.stringify(record, null, 2));

  const response = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(requestBody),
    timeout: 15000,  // 15秒タイムアウト
  });

  const responseBody = await response.json();
  console.log('[Pleasanter] Response status:', response.status);
  console.log('[Pleasanter] Response body:', JSON.stringify(responseBody, null, 2));

  if (!response.ok) {
    throw new Error(
      `Pleasanter API エラー: status=${response.status}, message=${JSON.stringify(responseBody)}`
    );
  }

  return responseBody;
}

// ============================================================
// エンドポイント: POST /api/intake
// ============================================================

/**
 * フォーム受付エンドポイント
 *
 * 将来の拡張ポイント（AIゲートウェイ追加時）：
 *   1. validateRequest() と callPleasanter() の間に
 *      const aiResult = await callAiGateway(body) を挿入する
 *   2. aiResult の内容を body に追加・加工してから Pleasanter に登録する
 *   3. callAiGateway() は別関数として定義し、エンドポイントを .env で管理する
 */
app.post('/api/intake', async (req, res) => {
  console.log('[/api/intake] 受信:', new Date().toISOString());

  try {
    const body = req.body;

    // ---- 1. サーバー側バリデーション ----
    const validationError = validateRequest(body);
    if (validationError) {
      console.warn('[/api/intake] バリデーションエラー:', validationError);
      return res.status(400).json({
        result:  'error',
        message: validationError,
      });
    }

    // ---- 2. 受付番号・受付日時を採番 ----
    const caseKey    = generateCaseKey();
    const receivedAt = new Date().toISOString().replace('Z', '');  // 例: 2026-03-31T10:30:00.000

    console.log('[/api/intake] 受付番号:', caseKey);

    // ---- 3. Pleasanter.net に登録 ----
    // 環境変数が未設定の場合はスキップ（開発時のフォールバック）
    if (PLEASANTER_SITE_ID && PLEASANTER_API_KEY) {
      await callPleasanter(body, caseKey, receivedAt);
    } else {
      console.warn(
        '[/api/intake] Pleasanter の環境変数が未設定のため登録をスキップします。' +
        '（.env を確認してください）'
      );
    }

    // ---- 4. ブラウザに成功レスポンスを返す ----
    return res.status(200).json({
      result:      'ok',
      case_key:    caseKey,
      received_at: receivedAt,
      message:     '受付が完了しました',
    });

  } catch (err) {
    // ---- 5. 例外発生時のエラーハンドリング ----
    console.error('[/api/intake] エラー:', err.message);
    console.error(err.stack);

    return res.status(500).json({
      result:  'error',
      message: 'サーバーエラーが発生しました。管理者にお問い合わせください。',
    });
  }
});

// ============================================================
// ヘルスチェック（動作確認用）
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    pleasanter_configured: !!(PLEASANTER_SITE_ID && PLEASANTER_API_KEY),
  });
});

// ============================================================
// サーバー起動
// ============================================================
app.listen(PORT, () => {
  console.log('==========================================');
  console.log(`  技術相談受付サーバー 起動完了`);
  console.log(`  URL: http://localhost:${PORT}`);
  console.log(`  ヘルスチェック: http://localhost:${PORT}/api/health`);
  console.log('==========================================');
  console.log(`  Pleasanter siteId : ${PLEASANTER_SITE_ID || '未設定'}`);
  console.log(`  Pleasanter APIKey : ${PLEASANTER_API_KEY ? '設定済み' : '未設定'}`);
  console.log('==========================================');
});
