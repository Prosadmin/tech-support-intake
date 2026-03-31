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
 * 動作要件：
 *   - Node.js 18 以上（ネイティブ fetch を使用）
 *   - node-fetch は不要（削除済み）
 *
 * 将来の拡張ポイント（AIゲートウェイ追加時）：
 *   - callPleasanter() の前に callAiGateway() を呼ぶ形で挿入できます
 */

'use strict';

const express = require('express');
const cors    = require('cors');
require('dotenv').config();   // .env を読み込む（Railwayでは不要だが、ローカル開発用）

const app = express();

// ============================================================
// 環境変数の取得
// ============================================================
const PORT               = process.env.PORT               || 3000;
const PLEASANTER_SITE_ID = (process.env.PLEASANTER_SITE_ID || '').trim();
const PLEASANTER_API_KEY = (process.env.PLEASANTER_API_KEY || '').trim();

// ---- 起動時ログ ----
console.log('==========================================');
console.log('  技術相談受付サーバー 起動中...');
console.log(`  Node.js バージョン : ${process.version}`);
console.log(`  PORT              : ${PORT}`);
console.log(`  PLEASANTER_SITE_ID: ${PLEASANTER_SITE_ID || '【未設定】'}`);
console.log(`  PLEASANTER_API_KEY: ${PLEASANTER_API_KEY
  ? '設定済み (' + PLEASANTER_API_KEY.length + '文字)'
  : '【未設定】'}`);
console.log('==========================================');

if (!PLEASANTER_SITE_ID || !PLEASANTER_API_KEY) {
  console.warn('[WARN] Pleasanter 環境変数が未設定です。Railway の Variables タブで設定してください。');
}

// ============================================================
// ミドルウェア設定
// ============================================================

// CORS：全オリジン許可（MVP用）
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.options('*', cors());   // プリフライトリクエストに即時応答

// JSON ボディのパース（最大 1MB）
app.use(express.json({ limit: '1mb' }));

// 静的ファイル配信（public/ フォルダ）
app.use(express.static('public'));

// ============================================================
// Pleasanter.net 列マッピング定義
// ============================================================
const PLEASANTER_COLUMNS = {
  ClassA:       'case_key',        // 受付番号（upsert の Keys にも使用）
  ClassB:       'channel',         // チャネル
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
// 受付番号の採番（インメモリ）
// ============================================================
let counterDate  = '';
let counterValue = 0;

function generateCaseKey() {
  const now   = new Date();
  const yyyy  = now.getFullYear();
  const mm    = String(now.getMonth() + 1).padStart(2, '0');
  const dd    = String(now.getDate()).padStart(2, '0');
  const today = `${yyyy}${mm}${dd}`;

  if (counterDate !== today) {
    counterDate  = today;
    counterValue = 0;
  }
  counterValue += 1;
  return `WEB-${today}-${String(counterValue).padStart(4, '0')}`;
}

// ============================================================
// サーバー側バリデーション
// ============================================================
const REQUIRED_FIELDS = [
  'requester_type', 'company_name', 'person_name',
  'email', 'phone', 'request_type', 'urgency',
  'store_name', 'store_address', 'equipment_type',
  'symptoms', 'business_impact',
];

function validateRequest(body) {
  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || String(body[field]).trim() === '') {
      return `必須項目 "${field}" が未入力です`;
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return 'メールアドレスの形式が正しくありません';
  }
  return null;
}

// ============================================================
// Pleasanter 用日時フォーマット
// ============================================================
function formatPleasanterDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return isoString;
  }
}

// ============================================================
// Pleasanter.net 登録処理
// ============================================================
async function callPleasanter(payload, caseKey, receivedAt) {
  const url = `https://pleasanter.net/fs/api/items/${PLEASANTER_SITE_ID}/upsert`;

  // Record オブジェクトを組み立てる
  const record = {};

  // Title（件名）は Pleasanter の必須フィールド
  record['Title'] = `[${caseKey}] ${payload.company_name || ''} ${payload.store_name || ''}`.trim().substring(0, 100);

  // 各列をマッピング
  for (const [col, key] of Object.entries(PLEASANTER_COLUMNS)) {
    if (col === 'DateA') {
      record[col] = formatPleasanterDate(receivedAt);
    } else if (key === 'case_key') {
      record[col] = caseKey;
    } else {
      record[col] = payload[key] != null ? String(payload[key]) : '';
    }
  }

  const requestBody = {
    ApiVersion: 1.1,
    ApiKey:     PLEASANTER_API_KEY,
    Keys:       ['ClassA'],
    Record:     record,
  };

  console.log('--- [Pleasanter] リクエスト ---');
  console.log('URL   :', url);
  console.log('Title :', record['Title']);
  console.log('ClassA:', record['ClassA']);
  console.log('Body  :', JSON.stringify(requestBody, null, 2));

  // Node.js 18 以上のネイティブ fetch を使用
  const response = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();
  console.log('--- [Pleasanter] レスポンス ---');
  console.log('Status:', response.status);
  console.log('Body  :', responseText);

  let responseBody;
  try { responseBody = JSON.parse(responseText); } catch { responseBody = { raw: responseText }; }

  if (!response.ok) {
    throw new Error(`Pleasanter HTTP エラー: ${response.status} / ${responseText}`);
  }

  // Pleasanter 独自のエラーコードチェック（Status が 200 以外 = エラー）
  if (responseBody.Status && responseBody.Status !== 200) {
    throw new Error(`Pleasanter 論理エラー: Status=${responseBody.Status}, Message=${responseBody.Message || ''}`);
  }

  return responseBody;
}

// ============================================================
// POST /api/intake
// ============================================================
app.post('/api/intake', async (req, res) => {
  const ts = new Date().toISOString();
  console.log(`\n========== [/api/intake] ${ts} ==========`);

  try {
    const body = req.body;

    // バリデーション
    const err = validateRequest(body);
    if (err) {
      console.warn('[/api/intake] バリデーションエラー:', err);
      return res.status(400).json({ result: 'error', message: err });
    }

    // 受付番号・受付日時
    const caseKey    = body.case_key    || generateCaseKey();
    const receivedAt = body.received_at || ts;
    console.log('[/api/intake] 受付番号:', caseKey);

    // 環境変数チェック
    if (!PLEASANTER_SITE_ID || !PLEASANTER_API_KEY) {
      console.error('[/api/intake] ⚠️ 環境変数が未設定 — Pleasanter 登録をスキップ');
      return res.status(200).json({
        result:      'partial',
        case_key:    caseKey,
        received_at: receivedAt,
        message:     '受付は完了しましたが、Pleasanter 環境変数が未設定のため登録できませんでした。',
      });
    }

    // Pleasanter 登録
    await callPleasanter(body, caseKey, receivedAt);

    return res.status(200).json({
      result:      'ok',
      case_key:    caseKey,
      received_at: receivedAt,
      message:     '受付が完了しました',
    });

  } catch (e) {
    console.error('[/api/intake] エラー:', e.message);
    return res.status(500).json({ result: 'error', message: e.message });
  }
});

// ============================================================
// GET /api/health
// ============================================================
app.get('/api/health', (_req, res) => {
  res.json({
    status:                'ok',
    timestamp:             new Date().toISOString(),
    node_version:          process.version,
    pleasanter_configured: !!(PLEASANTER_SITE_ID && PLEASANTER_API_KEY),
    site_id:               PLEASANTER_SITE_ID || '未設定',
    api_key_length:        PLEASANTER_API_KEY ? PLEASANTER_API_KEY.length : 0,
  });
});

// ============================================================
// GET /api/test-pleasanter （接続テスト用）
// ============================================================
app.get('/api/test-pleasanter', async (_req, res) => {
  if (!PLEASANTER_SITE_ID || !PLEASANTER_API_KEY) {
    return res.status(400).json({ result: 'error', message: '環境変数が未設定です' });
  }
  try {
    const testPayload = {
      company_name:    'テスト会社',
      person_name:     'テスト太郎',
      email:           'test@example.com',
      phone:           '03-0000-0000',
      requester_type:  'エンドユーザー',
      request_type:    '技術相談',
      urgency:         '低い',
      store_name:      'テスト店舗',
      store_address:   '東京都千代田区',
      equipment_type:  'その他',
      symptoms:        'テスト送信（自動テスト）',
      business_impact: '営業継続可能',
      channel:         'web',
    };
    const caseKey = 'TEST-' + Date.now();
    const result = await callPleasanter(testPayload, caseKey, new Date().toISOString());
    res.json({ result: 'ok', case_key: caseKey, pleasanter_response: result });
  } catch (e) {
    res.status(500).json({ result: 'error', message: e.message });
  }
});

// ============================================================
// サーバー起動
// ============================================================
app.listen(PORT, () => {
  console.log('==========================================');
  console.log('  技術相談受付サーバー 起動完了');
  console.log(`  URL             : http://localhost:${PORT}`);
  console.log(`  ヘルスチェック  : http://localhost:${PORT}/api/health`);
  console.log(`  Pleasanter テスト: http://localhost:${PORT}/api/test-pleasanter`);
  console.log('==========================================');
});
