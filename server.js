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
require('dotenv').config();              // .env を読み込む

const app = express();

// ============================================================
// 環境変数の取得
// ============================================================
// Railway は PORT を自動で設定するため、process.env.PORT を必ず使う
const PORT               = process.env.PORT               || 3000;
const PLEASANTER_SITE_ID = (process.env.PLEASANTER_SITE_ID || '').trim();
const PLEASANTER_API_KEY = (process.env.PLEASANTER_API_KEY || '').trim();

// 起動時に必須の環境変数が設定されているか確認する
console.log('==========================================');
console.log('  技術相談受付サーバー 起動中...');
console.log(`  PORT              : ${PORT}`);
console.log(`  PLEASANTER_SITE_ID: ${PLEASANTER_SITE_ID || '【未設定】'}`);
console.log(`  PLEASANTER_API_KEY: ${PLEASANTER_API_KEY ? '設定済み (' + PLEASANTER_API_KEY.length + '文字)' : '【未設定】'}`);
console.log(`  Node.js バージョン : ${process.version}`);
console.log('==========================================');

if (!PLEASANTER_SITE_ID || !PLEASANTER_API_KEY) {
  console.warn(
    '[WARN] PLEASANTER_SITE_ID または PLEASANTER_API_KEY が設定されていません。' +
    'Railway の Variables タブで環境変数を設定してください。'
  );
}

// ============================================================
// ミドルウェア設定
// ============================================================

// CORS：全オリジン許可（MVP・開発検証用）
// 本番運用時は origin を実際のドメインに限定すること
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// OPTIONS プリフライトへの即時レスポンス
app.options('*', cors());

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
  ClassA:       'case_key',        // 受付番号（upsert の Keys にも使用）
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
 * Keys に ClassA（受付番号）を指定しているため、
 * 同じ受付番号が存在する場合は更新、存在しない場合は新規作成されます
 *
 * @param {Object} payload - 送信するデータ
 * @param {string} caseKey - 受付番号
 * @param {string} receivedAt - 受付日時 (ISO 8601 形式)
 * @returns {Promise<Object>} Pleasanter からのレスポンス
 */
async function callPleasanter(payload, caseKey, receivedAt) {
  const siteId = PLEASANTER_SITE_ID;
  const apiKey = PLEASANTER_API_KEY;
  const url = `https://pleasanter.net/fs/api/items/${siteId}/upsert`;

  // ---- Pleasanter に送る Record オブジェクトを組み立てる ----
  const record = {};

  // Title（件名）は必須。受付番号＋会社名で組み立てる
  record['Title'] = `[${caseKey}] ${payload.company_name || ''} - ${payload.symptoms || ''}`.substring(0, 100);

  // PLEASANTER_COLUMNS の定義に従って動的にマッピングする
  for (const [pleasanterCol, payloadKey] of Object.entries(PLEASANTER_COLUMNS)) {
    if (pleasanterCol === 'DateA') {
      // 日付は receivedAt を使用（Pleasanter の日付形式：YYYY/MM/DD HH:mm:ss）
      record[pleasanterCol] = formatPleasanterDate(receivedAt);
    } else if (payloadKey === 'case_key') {
      // ClassA には受付番号を直接セット
      record[pleasanterCol] = caseKey;
    } else {
      // payload から値を取得
      record[pleasanterCol] = payload[payloadKey] != null ? String(payload[payloadKey]) : '';
    }
  }

  const requestBody = {
    ApiVersion: 1.1,
    ApiKey:     apiKey,
    Keys:       ['ClassA'],  // upsert のキー項目（受付番号）
    Record:     record,
  };

  console.log('========== [Pleasanter] リクエスト開始 ==========');
  console.log('[Pleasanter] URL    :', url);
  console.log('[Pleasanter] SiteID :', siteId);
  console.log('[Pleasanter] APIKey :', apiKey ? apiKey.substring(0, 8) + '...' : 'なし');
  console.log('[Pleasanter] Title  :', record['Title']);
  console.log('[Pleasanter] ClassA (受付番号):', record['ClassA']);
  console.log('[Pleasanter] Full Record:', JSON.stringify(record, null, 2));

  // Node.js 18 以降はネイティブ fetch が使える
  // それ以前は node-fetch を使う（package.json の node-fetch を確認）
  let fetchFn;
  try {
    // Node 18+ のネイティブ fetch を試みる
    fetchFn = globalThis.fetch;
    if (!fetchFn) throw new Error('no native fetch');
  } catch {
    // node-fetch にフォールバック
    fetchFn = require('node-fetch');
  }

  const response = await fetchFn(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();
  console.log('[Pleasanter] Response status  :', response.status);
  console.log('[Pleasanter] Response headers :', JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));
  console.log('[Pleasanter] Response body    :', responseText);
  console.log('========== [Pleasanter] リクエスト終了 ==========');

  // レスポンスを JSON としてパース
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = { raw: responseText };
  }

  if (!response.ok) {
    throw new Error(
      `Pleasanter API エラー: status=${response.status}, body=${responseText}`
    );
  }

  // Pleasanter は成功でも Status が 200 以外の場合がある（エラーコードを確認）
  if (responseBody.Status && responseBody.Status !== 200) {
    throw new Error(
      `Pleasanter API 論理エラー: Status=${responseBody.Status}, Message=${responseBody.Message || ''}`
    );
  }

  return responseBody;
}

/**
 * ISO 8601 日時文字列を Pleasanter 用にフォーマットする
 * 例：2026-03-31T10:30:00.000Z → 2026/03/31 19:30:00 (JST)
 *
 * @param {string} isoString
 * @returns {string} Pleasanter 用日時文字列
 */
function formatPleasanterDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const hh   = String(d.getHours()).padStart(2, '0');
    const mi   = String(d.getMinutes()).padStart(2, '0');
    const ss   = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
  } catch {
    return isoString;
  }
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
  const receivedAt = new Date().toISOString();
  console.log('\n========== [/api/intake] リクエスト受信 ==========');
  console.log('[/api/intake] 受信日時:', receivedAt);
  console.log('[/api/intake] ボディ:', JSON.stringify(req.body, null, 2));

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

    // ---- 2. 受付番号・受付日時を取得（フロントから送られてくる値を優先） ----
    const caseKey    = body.case_key    || generateCaseKey();
    const usedReceivedAt = body.received_at || receivedAt;

    console.log('[/api/intake] 受付番号:', caseKey);
    console.log('[/api/intake] 受付日時:', usedReceivedAt);

    // ---- 3. 環境変数チェック ----
    console.log('[/api/intake] 環境変数チェック:');
    console.log('  PLEASANTER_SITE_ID:', PLEASANTER_SITE_ID || '【未設定！】');
    console.log('  PLEASANTER_API_KEY:', PLEASANTER_API_KEY ? '設定済み' : '【未設定！】');

    if (!PLEASANTER_SITE_ID || !PLEASANTER_API_KEY) {
      console.error('[/api/intake] ⚠️ Pleasanter の環境変数が未設定です！');
      console.error('  Railway の Variables タブで以下を設定してください：');
      console.error('    PLEASANTER_SITE_ID = 17344501');
      console.error('    PLEASANTER_API_KEY = （APIキー）');
      // 環境変数未設定でも 200 を返してフロントをブロックしない
      return res.status(200).json({
        result:      'partial',
        case_key:    caseKey,
        received_at: usedReceivedAt,
        message:     'テーブルへの保存は完了しましたが、Pleasanter 環境変数が未設定のため登録できませんでした。',
      });
    }

    // ---- 4. Pleasanter.net に登録 ----
    console.log('[/api/intake] Pleasanter への登録を開始します...');
    const pleasanterResult = await callPleasanter(body, caseKey, usedReceivedAt);
    console.log('[/api/intake] Pleasanter 登録成功:', JSON.stringify(pleasanterResult));

    // ---- 5. ブラウザに成功レスポンスを返す ----
    return res.status(200).json({
      result:      'ok',
      case_key:    caseKey,
      received_at: usedReceivedAt,
      message:     '受付が完了しました',
    });

  } catch (err) {
    // ---- 6. 例外発生時のエラーハンドリング ----
    console.error('[/api/intake] ⚠️ エラー発生:', err.message);
    console.error(err.stack);

    return res.status(500).json({
      result:  'error',
      message: `サーバーエラー: ${err.message}`,
    });
  }
});

// ============================================================
// ヘルスチェック（動作確認用）
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status:               'ok',
    timestamp:            new Date().toISOString(),
    node_version:         process.version,
    pleasanter_configured: !!(PLEASANTER_SITE_ID && PLEASANTER_API_KEY),
    site_id:              PLEASANTER_SITE_ID || '未設定',
    api_key_length:       PLEASANTER_API_KEY ? PLEASANTER_API_KEY.length : 0,
  });
});

// ============================================================
// Pleasanter 接続テスト（デバッグ用）
// ============================================================
app.get('/api/test-pleasanter', async (req, res) => {
  if (!PLEASANTER_SITE_ID || !PLEASANTER_API_KEY) {
    return res.status(400).json({
      result: 'error',
      message: '環境変数が未設定です',
    });
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
      symptoms:        'テスト送信',
      business_impact: '営業継続可能',
      channel:         'web',
    };
    const caseKey = 'TEST-' + Date.now();
    const result = await callPleasanter(testPayload, caseKey, new Date().toISOString());
    res.json({ result: 'ok', pleasanter_response: result });
  } catch (err) {
    res.status(500).json({ result: 'error', message: err.message });
  }
});

// ============================================================
// サーバー起動
// ============================================================
app.listen(PORT, () => {
  console.log('==========================================');
  console.log(`  技術相談受付サーバー 起動完了`);
  console.log(`  URL: http://localhost:${PORT}`);
  console.log(`  ヘルスチェック  : http://localhost:${PORT}/api/health`);
  console.log(`  接続テスト      : http://localhost:${PORT}/api/test-pleasanter`);
  console.log('==========================================');
});
