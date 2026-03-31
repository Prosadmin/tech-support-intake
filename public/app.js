/**
 * app.js
 * 技術相談・故障受付フォーム フロントエンドスクリプト
 *
 * 【構成】
 *   ブラウザ → /tables/intake（テーブルAPI）→ データ保存
 *           → Pleasanter.net upsert API  → 案件登録
 *
 * 役割：
 *   1. フォームバリデーション
 *   2. 受付番号の採番
 *   3. テーブルAPI（/tables/intake）への POST 保存
 *   4. Pleasanter.net への upsert 登録
 *   5. 送信完了／エラーの画面表示
 *   6. 二重送信防止
 *
 * 将来の拡張ポイント（AIゲートウェイ追加時）：
 *   - submitForm() 内の送信前に callAiGateway() を挿入するだけで対応可能
 */

'use strict';

// ============================================================
// 定数
// ============================================================

/** テーブルAPI エンドポイント（このサイト内のデータ保存用） */
const TABLE_API_ENDPOINT = '/tables/intake';

/**
 * Railway 中継サーバーのエンドポイント
 * ここを変更するだけで送信先を切り替えられる
 * 将来 AIゲートウェイを追加する場合もここを変更する
 */
const RELAY_API_ENDPOINT = 'https://tech-support-intake-production.up.railway.app/api/intake';

// Pleasanter の列マッピングは server.js（Railway側）で管理しています

/** チャネル識別子（フロントは常に "web"） */
const CHANNEL = 'web';

// ============================================================
// DOMContentLoaded 後に初期化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  initRadioHighlight();   // ラジオボタン選択時のスタイル切り替え
  setupFormSubmit();      // フォーム送信イベントの登録
});

// ============================================================
// ラジオボタン選択時のビジュアルフィードバック
// ============================================================
function initRadioHighlight() {
  const radioGroups = document.querySelectorAll('.radio-group');
  radioGroups.forEach((group) => {
    group.querySelectorAll('input[type="radio"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        // 同グループ内の全ラベルから is-selected を除去
        group.querySelectorAll('.radio-label').forEach((lbl) => {
          lbl.classList.remove('is-selected');
        });
        // 選択されたラジオのラベルに is-selected を付与
        const selectedLabel = radio.closest('.radio-label');
        if (selectedLabel) {
          selectedLabel.classList.add('is-selected');
        }
      });
    });
  });
}

// ============================================================
// フォーム送信イベントの登録
// ============================================================
function setupFormSubmit() {
  const form = document.getElementById('intake-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();  // デフォルトの同期送信を止める

    // バリデーション
    const data = validateForm(form);
    if (!data) return;  // バリデーションNGなら送信しない

    // 送信処理
    await submitForm(data);
  });
}

// ============================================================
// バリデーション
// ============================================================
/**
 * フォームの入力値を検証し、問題なければデータオブジェクトを返す。
 * エラーがあれば null を返し、エラーメッセージを画面に表示する。
 *
 * @param {HTMLFormElement} form
 * @returns {Object|null} 検証済みデータ or null
 */
function validateForm(form) {
  clearAllErrors();  // 前回のエラーをクリア

  const errors = [];

  // --- 必須テキスト項目 ---
  const textRequired = [
    { id: 'requester_type',  label: '依頼者区分' },
    { id: 'company_name',    label: '会社名' },
    { id: 'person_name',     label: '担当者名' },
    { id: 'email',           label: 'メールアドレス' },
    { id: 'phone',           label: '電話番号' },
    { id: 'store_name',      label: '店舗名' },
    { id: 'store_address',   label: '設置場所住所' },
    { id: 'equipment_type',  label: '機器区分' },
    { id: 'symptoms',        label: '症状' },
  ];

  const values = {};  // 収集した値を格納

  textRequired.forEach(({ id, label }) => {
    const el = document.getElementById(id);
    const val = el ? el.value.trim() : '';
    if (!val) {
      showFieldError(id, `${label}を入力・選択してください`);
      if (el) el.classList.add('is-error');
      errors.push(id);
    } else {
      values[id] = val;
    }
  });

  // --- メール形式チェック ---
  if (values.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(values.email)) {
      showFieldError('email', 'メールアドレスの形式が正しくありません');
      document.getElementById('email').classList.add('is-error');
      errors.push('email_format');
    }
  }

  // --- 必須ラジオボタン ---
  const radioRequired = [
    { name: 'request_type',    label: '受付種別' },
    { name: 'urgency',         label: '緊急度' },
    { name: 'business_impact', label: '営業影響' },
  ];

  radioRequired.forEach(({ name, label }) => {
    const selected = form.querySelector(`input[name="${name}"]:checked`);
    if (!selected) {
      showFieldError(name, `${label}を選択してください`);
      errors.push(name);
    } else {
      values[name] = selected.value;
    }
  });

  // --- 利用同意チェックボックス ---
  const agreeEl = document.getElementById('agree');
  if (!agreeEl || !agreeEl.checked) {
    showFieldError('agree', '利用規約・個人情報の取扱いへの同意が必要です');
    errors.push('agree');
  }

  // エラーがあれば最初のエラー項目にスクロールして終了
  if (errors.length > 0) {
    scrollToFirstError();
    return null;
  }

  // --- 任意項目を収集 ---
  const optionalFields = ['maker', 'model', 'error_code', 'actions_taken', 'notes'];
  optionalFields.forEach((id) => {
    const el = document.getElementById(id);
    values[id] = el ? el.value.trim() : '';
  });

  // --- 受付番号・受付日時を採番 ---
  const now      = new Date();
  const caseKey  = generateCaseKey(now);
  const receivedAt = now.toISOString();

  // --- 送信用データオブジェクトを組み立て ---
  return {
    case_key:        caseKey,
    channel:         CHANNEL,
    requester_type:  values.requester_type,
    company_name:    values.company_name,
    person_name:     values.person_name,
    email:           values.email,
    phone:           values.phone,
    request_type:    values.request_type,
    urgency:         values.urgency,
    store_name:      values.store_name,
    store_address:   values.store_address,
    equipment_type:  values.equipment_type,
    maker:           values.maker,
    model:           values.model,
    error_code:      values.error_code,
    symptoms:        values.symptoms,
    actions_taken:   values.actions_taken,
    business_impact: values.business_impact,
    notes:           values.notes,
    received_at:     receivedAt,
  };
}

// ============================================================
// 受付番号の採番（フロント側）
// ============================================================

/**
 * 受付番号を生成する
 * 形式：WEB-YYYYMMDD-HHmmss（秒まで含めて重複を防ぐ）
 *
 * @param {Date} now
 * @returns {string} 受付番号
 */
function generateCaseKey(now) {
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const dd   = String(now.getDate()).padStart(2, '0');
  const hh   = String(now.getHours()).padStart(2, '0');
  const mi   = String(now.getMinutes()).padStart(2, '0');
  const ss   = String(now.getSeconds()).padStart(2, '0');
  return `WEB-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

// ============================================================
// API 送信処理
// ============================================================
/**
 * テーブルAPI と Pleasanter.net の両方にデータを送信する。
 *
 * 処理順：
 *   1. テーブルAPI（/tables/intake）に保存
 *   2. Pleasanter.net upsert API に登録
 *   ※ どちらかが失敗してもエラーメッセージを表示する
 *
 * 将来の拡張ポイント（AIゲートウェイ追加時）：
 *   - ステップ1の前に callAiGateway(data) を呼び出して結果を data に追加する
 *
 * @param {Object} data バリデーション済みフォームデータ
 */
async function submitForm(data) {
  const btn     = document.getElementById('submit-btn');
  const btnTxt  = document.getElementById('btn-text');
  const btnLd   = document.getElementById('btn-loading');
  const errBlk  = document.getElementById('error-block');

  // ---- 送信中状態に切り替え（二重送信防止） ----
  btn.disabled = true;
  btnTxt.classList.add('hidden');
  btnLd.classList.remove('hidden');
  errBlk.classList.add('hidden');

  try {
    // ---- ステップ1: テーブルAPI に保存（このサイト内） ----
    const tableRes = await fetch(TABLE_API_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });

    if (!tableRes.ok && tableRes.status !== 201) {
      throw new Error(`テーブルAPI エラー: ${tableRes.status}`);
    }

    // ---- ステップ2: Railway 中継サーバー経由で Pleasanter に登録 ----
    // 将来 AIゲートウェイを追加する場合は RELAY_API_ENDPOINT を変更するだけでOK
    const relayRes = await fetch(RELAY_API_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });

    if (!relayRes.ok) {
      const relayJson = await relayRes.json().catch(() => ({}));
      throw new Error(`中継サーバー エラー: ${relayRes.status} / ${JSON.stringify(relayJson)}`);
    }

    // ---- 成功 ----
    showSuccessBlock(data.case_key, data.received_at);

  } catch (err) {
    console.error('[intake] 送信エラー:', err);
    showErrorBlock('送信に失敗しました。しばらく時間をおいて再度お試しください。');
    restoreButton(btn, btnTxt, btnLd);
  }
}

// Pleasanter への登録は Railway の server.js が行います

// ============================================================
// 画面表示ヘルパー
// ============================================================

/** 送信成功時：完了ブロックを表示し、フォームを隠す */
function showSuccessBlock(caseKey, receivedAt) {
  const form    = document.getElementById('intake-form');
  const success = document.getElementById('success-block');

  document.getElementById('success-case-key').textContent    = caseKey || '—';
  document.getElementById('success-received-at').textContent = formatDateTime(receivedAt) || '—';

  form.classList.add('hidden');
  success.classList.remove('hidden');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** エラー時：エラーブロックを表示する */
function showErrorBlock(message) {
  const errBlk = document.getElementById('error-block');
  const errMsg = document.getElementById('error-message');
  errMsg.textContent = message;
  errBlk.classList.remove('hidden');
  errBlk.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** 特定フィールドのエラーメッセージを表示する */
function showFieldError(fieldId, message) {
  const errEl = document.getElementById(`err-${fieldId}`);
  if (errEl) errEl.textContent = message;
}

/** すべてのフィールドエラーをクリアする */
function clearAllErrors() {
  document.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
  document.querySelectorAll('.is-error').forEach((el) => { el.classList.remove('is-error'); });
}

/** 最初のエラー項目にスクロールする */
function scrollToFirstError() {
  const firstErr = document.querySelector('.field-error:not(:empty)');
  if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** 送信ボタンを元の状態に戻す */
function restoreButton(btn, btnTxt, btnLd) {
  btn.disabled = false;
  btnTxt.classList.remove('hidden');
  btnLd.classList.add('hidden');
}

// ============================================================
// フォームリセット（「別の内容を送信する」ボタン）
// ============================================================
function resetForm() {
  const form    = document.getElementById('intake-form');
  const success = document.getElementById('success-block');
  const errBlk  = document.getElementById('error-block');

  form.reset();
  clearAllErrors();

  document.querySelectorAll('.radio-label').forEach((lbl) => {
    lbl.classList.remove('is-selected');
  });

  const btn    = document.getElementById('submit-btn');
  const btnTxt = document.getElementById('btn-text');
  const btnLd  = document.getElementById('btn-loading');
  if (btn) restoreButton(btn, btnTxt, btnLd);

  success.classList.add('hidden');
  errBlk.classList.add('hidden');
  form.classList.remove('hidden');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================
// ユーティリティ
// ============================================================

/**
 * ISO 8601 形式の日時文字列を日本語表示にフォーマットする
 * 例: "2026-03-31T10:30:00.000Z" → "2026年03月31日 10:30:00"
 */
function formatDateTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const hh   = String(d.getHours()).padStart(2, '0');
    const mi   = String(d.getMinutes()).padStart(2, '0');
    const ss   = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}年${mm}月${dd}日 ${hh}:${mi}:${ss}`;
  } catch {
    return isoString;
  }
}
