'use strict';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const REQUIRED = [
  'requester_type', 'company_name', 'person_name',
  'email', 'phone', 'request_type', 'urgency',
  'store_name', 'store_address', 'equipment_type',
  'symptoms', 'business_impact',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ result: 'error', message: 'Method Not Allowed' });

  const body = req.body || {};

  for (const f of REQUIRED) {
    if (!body[f] || !String(body[f]).trim()) {
      return res.status(400).json({ result: 'error', message: `${f} は必須です` });
    }
  }

  const SITE_ID = (process.env.PLEASANTER_SITE_ID || '').trim();
  const API_KEY = (process.env.PLEASANTER_API_KEY || '').trim();

  if (!SITE_ID || !API_KEY) {
    return res.status(500).json({ result: 'error', message: 'サーバー環境変数が未設定です' });
  }

  const now      = new Date();
  const yyyymmdd = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  const caseKey    = body.case_key    || `WEB-${yyyymmdd}-${Date.now().toString().slice(-6)}`;
  const receivedAt = body.received_at || now.toISOString();

  const titleValue = `[${caseKey}] ${body.company_name||''} ${body.store_name||''}`.trim().slice(0, 100);

  // Pleasanter API：Title はトップレベル、各フィールドも Record の外に並べる
  const requestBody = {
    ApiVersion:   1.1,
    ApiKey:       API_KEY,
    Title:        titleValue,
    ClassA:       caseKey,
    ClassB:       body.channel         || 'web',
    ClassC:       body.requester_type  || '',
    ClassD:       body.company_name    || '',
    ClassE:       body.person_name     || '',
    ClassF:       body.request_type    || '',
    ClassG:       body.urgency         || '',
    ClassH:       body.store_name      || '',
    ClassI:       body.equipment_type  || '',
    ClassJ:       body.maker           || '',
    DescriptionA: body.store_address   || '',
    DescriptionB: body.model           || '',
    DescriptionC: body.error_code      || '',
    DescriptionD: body.symptoms        || '',
    DescriptionE: body.actions_taken   || '',
    DescriptionF: body.business_impact || '',
    DescriptionG: body.notes           || '',
    DateA:        fmtDate(receivedAt),
  };

  console.log('[intake] caseKey:', caseKey);
  console.log('[intake] requestBody:', JSON.stringify(requestBody));

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
    console.log('[intake] Pleasanter status:', plRes.status);
    console.log('[intake] Pleasanter response:', text);

    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!plRes.ok) {
      return res.status(502).json({ result: 'error', message: `Pleasanter HTTP ${plRes.status}: ${text}` });
    }
    if (json.StatusCode && json.StatusCode !== 200) {
      return res.status(502).json({ result: 'error', message: `Pleasanter エラー: ${json.Message || text}` });
    }

    return res.status(200).json({
      result:      'ok',
      case_key:    caseKey,
      received_at: receivedAt,
      message:     '受付が完了しました',
    });

  } catch (e) {
    console.error('[intake] fetch error:', e.message);
    return res.status(500).json({ result: 'error', message: e.message });
  }
};
