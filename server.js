'use strict';

// ---- 依存モジュール（node-fetch は使わない。Node 18 のネイティブ fetch を使用）----
const express = require('express');
const cors    = require('cors');

// .env 読み込み（ローカル開発用。Railway 本番では環境変数が直接設定される）
// 注意：Railway 上では .env ファイルは存在しないため dotenv は何もしない
if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (e) { /* dotenv がなくても続行 */ }
}

const app = express();

// ---- 環境変数 ----
const PORT               = process.env.PORT               || 3000;
const PLEASANTER_SITE_ID = (process.env.PLEASANTER_SITE_ID || '').trim();
const PLEASANTER_API_KEY = (process.env.PLEASANTER_API_KEY || '').trim();

// Railway が設定する PORT を確認（必ず process.env.PORT を使うこと）
console.log('=== 起動情報 ===');
console.log('Node        :', process.version);
console.log('process.env.PORT :', process.env.PORT || '(未設定 → 3000 使用)');
console.log('PORT (使用) :', PORT);
console.log('SiteID      :', PLEASANTER_SITE_ID || '未設定');
console.log('APIKey      :', PLEASANTER_API_KEY ? `設定済み(${PLEASANTER_API_KEY.length}文字)` : '未設定');

// ---- ミドルウェア ----
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.options('*', cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ---- ヘルスチェック ----
app.get('/api/health', (_req, res) => {
  res.json({
    status:                'ok',
    node_version:          process.version,
    timestamp:             new Date().toISOString(),
    pleasanter_configured: !!(PLEASANTER_SITE_ID && PLEASANTER_API_KEY),
    site_id:               PLEASANTER_SITE_ID || '未設定',
    api_key_length:        PLEASANTER_API_KEY.length,
  });
});

// ---- Pleasanter create ----
async function callPleasanter(payload, caseKey, receivedAt) {
  const url = `https://pleasanter.net/fs/api/items/${PLEASANTER_SITE_ID}/create`;

  // 日付フォーマット（YYYY/MM/DD HH:mm:ss）
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  const titleValue = `[${caseKey}] ${payload.company_name||''} ${payload.store_name||''}`.trim().slice(0,100);

  // Pleasanter 外部受付テーブルのフィールドマッピング
  // 表示名(エディタ)  → APIフィールド名
  // タイトル         → Title
  // 受付番号(分類A)   → ClassA
  // チャネル(分類B)   → ClassB
  // 依頼者区分(分類C) → ClassC
  // 会社名(分類D)     → ClassD
  // 担当者名(分類E)   → ClassE
  // 受付種別(分類F)   → ClassF
  // 緊急度(分類G)     → ClassG
  // 店舗名(分類H)     → ClassH
  // 機器区分(分類I)   → ClassI
  // メーカー(分類J)   → ClassJ
  // 設置場所住所(説明A)→ DescriptionA
  const record = {
    Title:        titleValue,
    ClassA:       caseKey,
    ClassB:       payload.channel         || 'web',
    ClassC:       payload.requester_type  || '',
    ClassD:       payload.company_name    || '',
    ClassE:       payload.person_name     || '',
    ClassF:       payload.request_type    || '',
    ClassG:       payload.urgency         || '',
    ClassH:       payload.store_name      || '',
    ClassI:       payload.equipment_type  || '',
    ClassJ:       payload.maker           || '',
    DescriptionA: payload.store_address   || '',
    DescriptionB: payload.model           || '',
    DescriptionC: payload.error_code      || '',
    DescriptionD: payload.symptoms        || '',
    DescriptionE: payload.actions_taken   || '',
    DescriptionF: payload.business_impact || '',
    DescriptionG: payload.notes           || '',
    DateA:        fmtDate(receivedAt),
  };

  const body = JSON.stringify({
    ApiVersion: 1.1,
    ApiKey:     PLEASANTER_API_KEY,
    Record:     record,
  });

  console.log('[Pleasanter] POST', url);
  console.log('[Pleasanter] Title:', record.Title);
  console.log('[Pleasanter] Body:', body);

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body,
  });

  const text = await res.text();
  console.log('[Pleasanter] Status:', res.status);
  console.log('[Pleasanter] Response:', text);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);

  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (json.Status && json.Status !== 200) {
    throw new Error(`Pleasanter エラー Status=${json.Status} Message=${json.Message||''}`);
  }
  return json;
}

// ---- POST /api/intake ----
app.post('/api/intake', async (req, res) => {
  console.log('\n=== /api/intake 受信 ===', new Date().toISOString());

  const body = req.body || {};

  // 必須チェック
  const required = ['requester_type','company_name','person_name','email','phone',
                    'request_type','urgency','store_name','store_address',
                    'equipment_type','symptoms','business_impact'];
  for (const f of required) {
    if (!body[f] || !String(body[f]).trim()) {
      return res.status(400).json({ result:'error', message:`${f} は必須です` });
    }
  }

  const caseKey    = body.case_key    || `WEB-${Date.now()}`;
  const receivedAt = body.received_at || new Date().toISOString();

  if (!PLEASANTER_SITE_ID || !PLEASANTER_API_KEY) {
    console.warn('⚠️ 環境変数未設定 — Pleasanter 登録スキップ');
    return res.status(200).json({
      result: 'partial', case_key: caseKey, received_at: receivedAt,
      message: '環境変数が未設定のため Pleasanter に登録できませんでした',
    });
  }

  try {
    await callPleasanter(body, caseKey, receivedAt);
    return res.status(200).json({
      result: 'ok', case_key: caseKey, received_at: receivedAt,
      message: '受付が完了しました',
    });
  } catch (e) {
    console.error('Pleasanter エラー:', e.message);
    return res.status(500).json({ result: 'error', message: e.message });
  }
});

// ---- GET /api/test-pleasanter ----
app.get('/api/test-pleasanter', async (_req, res) => {
  if (!PLEASANTER_SITE_ID || !PLEASANTER_API_KEY) {
    return res.status(400).json({ result:'error', message:'環境変数が未設定です' });
  }
  try {
    const caseKey = 'TEST-' + Date.now();
    const r = await callPleasanter({
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
      symptoms:        'APIテスト送信',
      business_impact: '営業継続可能',
      channel:         'web',
    }, caseKey, new Date().toISOString());
    res.json({ result:'ok', case_key: caseKey, pleasanter_response: r });
  } catch (e) {
    res.status(500).json({ result:'error', message: e.message });
  }
});

// ---- 起動 ----
app.listen(PORT, () => {
  console.log(`\n✅ サーバー起動完了 → http://localhost:${PORT}`);
  console.log(`   /api/health          → ヘルスチェック`);
  console.log(`   /api/test-pleasanter → Pleasanter 接続テスト`);
});
