const { ncalayerCall, signingRequest } = await import(
  typeof document === 'undefined' ? '../nca/client.mjs' : '/nca-client.mjs');

const SCOPE = 'local_test_workspace_only';
const SIGNATURE_SCOPE = 'test_terms_evidence_only';
const ACTION = 'record_test_terms_signature';
const DOMAIN = 'dalahold:test-terms-evidence:v1';
const PURPOSE = 'TEST only: record one personal TEST CMS signature over these exact terms and document digests. No transaction approval, role, access, corporate powers, wallet or payment is authorized.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const CATEGORIES = ['contract', 'delivery', 'quality', 'other'];
const TERM_FIELDS = ['dealId', 'version', 'scenario', 'quantity', 'amount', 'date'];
const END_MESSAGE = 'TEST-сессия завершена. Закрытие или истечение не отменяет сохранённую операцию. Если ответ потерян, потребуется защищённый readback оператора.';
const exact = (value, keys) => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(','));
const fail = (code = 'invalid_response', status = 0) => Object.assign(new Error(code), { status });
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const canonical = value => JSON.stringify(value, null, 2) + '\n';
const orderedTerms = value => Object.fromEntries(TERM_FIELDS.map(key => [key, value[key]]));
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const digest = async (bytes, cryptoImpl) => hex(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes)));
function base64(bytes) { return btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')); }
function decode(value) {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail();
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (base64(bytes) !== value) throw fail();
  return bytes;
}
function termsValid(value) {
  if (!exact(value, TERM_FIELDS) || typeof value.dealId !== 'string' || !UUID.test(value.dealId) ||
      !integer(value.version, 1) || !['grain', 'livestock'].includes(value.scenario) ||
      !integer(value.quantity, 1, 100000) || !integer(value.amount, 1, 999999999999) ||
      typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return false;
  const date = new Date(`${value.date}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.date;
}
async function termsHash(terms, cryptoImpl) {
  const text = ['dalahold.unsigned-local-draft-terms.v1', ...TERM_FIELDS.map(key => `${key}=${terms[key]}`)].map(line => line + '\n').join('');
  return digest(new TextEncoder().encode(text), cryptoImpl);
}
function manifest(documents) {
  return documents.map(({ id, category, byteLength, sha256 }) => ({ id, category, byteLength, sha256 }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
function manifestValid(value) {
  return Array.isArray(value) && value.length <= 10 && value.every((item, index) =>
    exact(item, ['id', 'category', 'byteLength', 'sha256']) && typeof item.id === 'string' && UUID.test(item.id) &&
    CATEGORIES.includes(item.category) && integer(item.byteLength, 1, 262144) && typeof item.sha256 === 'string' && HASH.test(item.sha256) &&
    (index === 0 || value[index - 1].id < item.id));
}
async function snapshotValid(value, cryptoImpl) {
  return exact(value, ['terms', 'termsFingerprint', 'documents']) && termsValid(value.terms) &&
    typeof value.termsFingerprint === 'string' && HASH.test(value.termsFingerprint) && manifestValid(value.documents) &&
    await termsHash(value.terms, cryptoImpl) === value.termsFingerprint;
}
function receiptValid(receipt, snapshot, intentHash) {
  const fields = ['id', 'intentHash', 'dealId', 'termsVersion', 'termsFingerprint', 'certificateDigest',
    'verifiedAt', 'validUntil', 'statusSource', 'scope', 'action'];
  return exact(receipt, fields) && typeof receipt.id === 'string' && UUID.test(receipt.id) &&
    typeof receipt.intentHash === 'string' && HASH.test(receipt.intentHash) &&
    (!intentHash || receipt.intentHash === intentHash) && receipt.dealId === snapshot.terms.dealId &&
    receipt.termsVersion === snapshot.terms.version && receipt.termsFingerprint === snapshot.termsFingerprint &&
    typeof receipt.certificateDigest === 'string' && HASH.test(receipt.certificateDigest) &&
    integer(receipt.verifiedAt) && integer(receipt.validUntil, receipt.verifiedAt + 1) &&
    receipt.statusSource === 'test_ocsp' && receipt.scope === SIGNATURE_SCOPE && receipt.action === ACTION;
}

export async function validateTermsIntent(intent, view, now = Date.now(), cryptoImpl = globalThis.crypto) {
  if (!exact(intent, ['id', 'text', 'bytesBase64', 'hash', 'expiresAt']) || typeof intent.id !== 'string' || !UUID.test(intent.id) ||
      typeof intent.text !== 'string' || intent.text.length > 65536 || typeof intent.hash !== 'string' || !HASH.test(intent.hash) ||
      typeof intent.bytesBase64 !== 'string' || intent.bytesBase64.length > 90000 || !integer(intent.expiresAt, now + 1)) throw fail();
  try {
    const bytes = decode(intent.bytesBase64);
    if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== intent.text) throw fail();
    const data = JSON.parse(intent.text);
    if (!exact(data, ['domain', 'purpose', 'action', 'nonce', 'sessionHash', 'issuedAt', 'expiresAt', 'statusSource', 'snapshot']) ||
        Object.keys(data).join(',') !== 'domain,purpose,action,nonce,sessionHash,issuedAt,expiresAt,statusSource,snapshot' ||
        data.domain !== DOMAIN || data.purpose !== PURPOSE || data.action !== ACTION || data.nonce !== intent.id ||
        typeof data.sessionHash !== 'string' || !HASH.test(data.sessionHash) || !integer(data.issuedAt, 0, now) ||
        data.expiresAt !== data.issuedAt + 300000 || data.expiresAt !== intent.expiresAt || data.statusSource !== 'test_ocsp' ||
        canonical(data) !== intent.text || !await snapshotValid(data.snapshot, cryptoImpl) ||
        JSON.stringify(data.snapshot) !== JSON.stringify({ terms: orderedTerms(view.terms), termsFingerprint: view.deal.termsFingerprint,
          documents: manifest(view.documents) }) || await digest(bytes, cryptoImpl) !== intent.hash) throw fail();
  } catch { throw fail(); }
  return intent;
}

export async function validateWorkspaceEvidence(value, dealId, cryptoImpl = globalThis.crypto) {
  if (value?.scope !== SCOPE || !termsValid(value.terms) || value.terms.dealId !== dealId || value.deal?.id !== dealId ||
      value.deal.version !== value.terms.version || TERM_FIELDS.slice(2).some(key => value.deal[key] !== value.terms[key]) ||
      typeof value.deal.termsFingerprint !== 'string' || !HASH.test(value.deal.termsFingerprint) ||
      await termsHash(value.terms, cryptoImpl) !== value.deal.termsFingerprint || !Array.isArray(value.documents) ||
      value.documents.length > 10 || !Array.isArray(value.signatures)) throw fail();
  const documents = value.documents.map(item => {
    if (!exact(item, ['id', 'dealId', 'termsVersion', 'category', 'byteLength', 'sha256', 'createdAt', 'scope', 'fileKind']) ||
        typeof item.id !== 'string' || !UUID.test(item.id) || item.dealId !== dealId || item.termsVersion !== value.terms.version ||
        !CATEGORIES.includes(item.category) || !integer(item.byteLength, 1, 262144) || typeof item.sha256 !== 'string' || !HASH.test(item.sha256) ||
        !integer(item.createdAt) || item.scope !== 'local_test_document_only' || item.fileKind !== 'text') throw fail();
    return { ...item };
  });
  if (!manifestValid(manifest(documents))) throw fail();
  const signatures = [];
  for (const item of value.signatures) {
    if (!await snapshotValid(item?.snapshot, cryptoImpl) || !receiptValid(item.receipt, item.snapshot) ||
        item.snapshot.terms.dealId !== dealId || typeof item.currentMatches !== 'boolean') throw fail();
    const matches = JSON.stringify(item.snapshot) === JSON.stringify({ terms: orderedTerms(value.terms),
      termsFingerprint: value.deal.termsFingerprint, documents: manifest(documents) });
    if (matches !== item.currentMatches) throw fail();
    signatures.push({ snapshot: structuredClone(item.snapshot), receipt: { ...item.receipt }, currentMatches: matches });
  }
  const offline = value.offlineEvidence;
  if (offline !== null && (offline?.schema !== 'dalahold.offline-evidence.v1' || offline.trustLevel !== 'local_test_fixture_only' ||
      offline.dealId !== dealId || !termsValid(offline.terms) || offline.terms.dealId !== dealId ||
      await termsHash(offline.terms, cryptoImpl) !== offline.termsFingerprint || !Array.isArray(offline.decisions) ||
      !Array.isArray(offline.documentMarkers))) throw fail();
  let offlineEvidence = null;
  if (offline !== null) {
    if (typeof offline.status !== 'string' || typeof offline.disclaimer !== 'string' ||
        offline.decisions.some(item => item?.source !== 'test_key_receipt' || !integer(item.sequence, 1) ||
          !UUID.test(item.decisionId || '') || !UUID.test(item.actorId || '') || typeof item.action !== 'string' ||
          typeof item.resultStatus !== 'string' || !HASH.test(item.challengeHash || '') || !HASH.test(item.signatureHash || '')) ||
        offline.documentMarkers.some(item => item?.source !== 'unsigned_metadata_only' || !UUID.test(item.id || '') ||
          !['category', 'context', 'note', 'claimedRole', 'fileKind'].every(key => typeof item[key] === 'string') || !integer(item.createdAt))) throw fail();
    offlineEvidence = { schema: offline.schema, trustLevel: offline.trustLevel, disclaimer: offline.disclaimer,
      dealId, terms: orderedTerms(offline.terms), termsFingerprint: offline.termsFingerprint, status: offline.status,
      decisions: offline.decisions.map(item => Object.fromEntries(['sequence', 'decisionId', 'actorId', 'action', 'resultStatus', 'challengeHash', 'signatureHash', 'source'].map(key => [key, item[key]]))),
      documentMarkers: offline.documentMarkers.map(item => Object.fromEntries(['id', 'category', 'context', 'note', 'claimedRole', 'fileKind', 'createdAt', 'source'].map(key => [key, item[key]]))) };
  }
  return { scope: SCOPE, deal: { id: dealId, version: value.terms.version, ...Object.fromEntries(TERM_FIELDS.slice(2).map(key => [key, value.terms[key]])),
    termsFingerprint: value.deal.termsFingerprint }, terms: orderedTerms(value.terms), documents, signatures,
    offlineEvidence };
}

export async function readTestDocument(file, consent, cryptoImpl = globalThis.crypto) {
  if (consent !== true) throw fail('consent_required');
  if (!file || typeof file.name !== 'string' || !/\.txt$/i.test(file.name) ||
      !['', 'text/plain'].includes(file.type) || !integer(file.size, 1, 262144) || typeof file.arrayBuffer !== 'function') throw fail('invalid_file');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size || !integer(bytes.length, 1, 262144)) throw fail('invalid_file');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('invalid_file'); }
  return { bytesBase64: base64(bytes), byteLength: bytes.length, sha256: await digest(bytes, cryptoImpl) };
}

export function mountTestWorkspace(document, {
  fetchImpl = globalThis.fetch, ncalayer = ncalayerCall, now = Date.now, cryptoImpl = globalThis.crypto,
  setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval,
  locationImpl = globalThis.location, BlobImpl = globalThis.Blob, URLImpl = globalThis.URL,
} = {}) {
  const $ = name => document.getElementById(`tw-${name}`);
  if (!$('workspace')) return null;
  let status = null, view = null, intent = null, cms = null, receipt = null, upload = null;
  let busy = false, terminal = false, closing = false, disposed = false, generation = 0, closeToken = null, closeAttempts = 0;
  const listeners = [], urls = new Set();
  const message = (text, error = false) => { $('result').textContent = text; $('result').classList.toggle('error', error); };
  function clearIntent() {
    intent = cms = receipt = null; $('intent').hidden = true; $('receipt').hidden = true;
    for (const name of ['exact-bytes', 'intent-hash', 'intent-expiry', 'receipt-bytes', 'receipt-note']) $(name).textContent = '';
  }
  function revokeUrls() { for (const url of urls) URLImpl.revokeObjectURL(url); urls.clear(); }
  function clearView() {
    view = null; $('fingerprint').textContent = ''; $('deal-summary').textContent = 'Черновик не выбран.';
    $('documents').replaceChildren(); $('signatures').textContent = ''; $('offline').textContent = ''; revokeUrls();
  }
  function endSession(text = END_MESSAGE, preserveToken = false) {
    ++generation; status = null; terminal = true; busy = false; clearIntent(); clearView(); upload = null;
    $('file').value = ''; $('consent').checked = false; $('deal').value = ''; $('deal').replaceChildren();
    if (!preserveToken) closeToken = null;
    $('sdk').textContent = 'TEST-сессия завершена'; $('session-expiry').textContent = 'Активной сессии нет.';
    message(text); controls();
  }
  const current = op => {
    if (disposed || terminal || op !== generation) return false;
    if (status && status.sessionExpiresAt <= now()) { endSession(); return false; }
    return true;
  };
  function controls() {
    if (disposed) return;
    if (status && status.sessionExpiresAt <= now()) { endSession(); return; }
    const blocked = busy || terminal || closing;
    for (const name of ['refresh', 'deal', 'consent', 'category']) $(name).disabled = blocked || !status;
    $('refresh').disabled ||= Boolean(cms && !receipt) || Boolean(upload);
    $('file').disabled = blocked || !view || !$('consent').checked;
    $('upload').disabled = blocked || !view || !$('consent').checked || !$('file').files?.length || Boolean(upload);
    $('upload-retry').disabled = blocked || !upload;
    const ready = status?.signing?.ready && status.signing.validUntil > now();
    $('create').disabled = blocked || !view || !ready || Boolean(cms && !receipt) || Boolean(upload);
    $('sign').disabled = blocked || !ready || !intent || intent.expiresAt <= now() || Boolean(cms) || Boolean(receipt);
    $('retry').disabled = blocked || !intent || !cms;
    $('export').disabled = blocked || !view;
    $('close').disabled = closing || !(status?.csrfToken || closeToken) || closeAttempts >= 3;
    $('close').textContent = closeToken ? 'Повторить закрытие TEST-сессии' : 'Закрыть TEST-сессию';
    $('new-session').hidden = (Boolean(status) && !terminal) || busy || closing || Boolean(closeToken);
    $('workspace').setAttribute('aria-busy', String(busy || closing));
    if (status) $('session-expiry').textContent = `TEST-сессия: ещё ${Math.ceil((status.sessionExpiresAt - now()) / 1000)} сек.`;
    if (intent) $('intent-expiry').textContent = intent.expiresAt > now() ? `Снимок действителен ещё ${Math.ceil((intent.expiresAt - now()) / 1000)} сек.`
      : 'Снимок истёк. Сохранённую CMS можно повторить для исторической квитанции; новая подпись требует нового снимка.';
  }
  async function api(path, value, token = status?.csrfToken) {
    let response;
    try { response = await fetchImpl(path, { cache: 'no-store', credentials: 'same-origin',
      ...(value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DalaHold-CSRF': token }, body: JSON.stringify(value) }) }); }
    catch { throw fail('network_error'); }
    let result; try { result = await response.json(); } catch { throw fail('invalid_response'); }
    if (!response.ok) throw fail(typeof result?.error === 'string' ? result.error : 'request_failed', response.status);
    return result;
  }
  function errorMessage(error) {
    if (error.status === 422 && error.message === 'terms_signature_rejected') cms = null;
    if (error.status === 403 && ['test_workspace_session_unavailable', 'test_workspace_csrf_required', 'session_unavailable'].includes(error.message)) { endSession(); return; }
    const descriptions = { consent_required: 'Подтверди согласие до чтения файла.', invalid_file: 'Нужен UTF-8 .txt размером от 1 байта до 256 КиБ.',
      network_error: 'Ответ локального сервера не получен.', invalid_response: 'Ответ сервера не прошёл проверку точных данных.',
      signing_cancelled_or_rejected: 'Подписание отменено или сертификат не подходит.', stale_draft: 'Версия черновика изменилась. Обнови сводку.',
      ncalayer_unavailable: 'NCALayer недоступен. Запусти его и повтори.', ncalayer_timeout: 'Время ожидания NCALayer истекло.' };
    message((descriptions[error.message] || 'Операция отклонена локальным TEST-сервисом.') +
      (cms ? ' Сохранилась точная CMS: повтори её; новая подпись заблокирована.' : '') +
      (upload ? ' Сохранился точный запрос документа: повтор использует тот же ID.' : ''), true);
  }
  async function run(fn) {
    controls(); if (busy || terminal || closing || !status) return;
    busy = true; const op = ++generation; controls();
    try { await fn(op); } catch (error) { if (current(op)) errorMessage(error); }
    finally { if (current(op)) { busy = false; controls(); } }
  }
  function renderView() {
    $('deal-summary').textContent = `${view.terms.scenario === 'grain' ? 'Зерно' : 'Животноводство'} · версия ${view.terms.version} · количество ${view.terms.quantity} · сумма в документе ${view.terms.amount} KZT · ${view.terms.date} · без согласия сторон`;
    $('fingerprint').textContent = view.deal.termsFingerprint; $('documents').replaceChildren();
    for (const item of view.documents) {
      const li = document.createElement('li'), text = document.createElement('span'), link = document.createElement('a');
      text.textContent = `${item.category} · v${item.termsVersion} · ${item.byteLength} байт · SHA-256 ${item.sha256}. `;
      link.textContent = 'Скачать .txt'; link.href = `/api/test-workspace/deals/${view.deal.id}/documents/${item.id}`;
      li.append(text, link); $('documents').append(li);
    }
    if (!view.documents.length) { const li = document.createElement('li'); li.textContent = 'Документы текущей версии не сохранены.'; $('documents').append(li); }
    $('signatures').textContent = view.signatures.length ? canonical(view.signatures.map(item => ({
      kind: 'Личная TEST CMS — историческая сохранённая запись, без авторизации',
      currentSnapshotMatches: item.currentMatches, ...item }))) : 'Личных TEST-подписей пока нет.';
    $('offline').textContent = view.offlineEvidence === null ? 'Для этого черновика отдельный офлайн-сценарий не подготовлен.'
      : canonical({ kind: 'Отдельная локальная модель тестовых ключей; не NCALayer / NCA', ...view.offlineEvidence });
  }
  async function loadView(op, id = $('deal').value) {
    if (!UUID.test(id || '')) { if (current(op)) clearView(); return; }
    const value = await api(`/api/test-workspace/deals/${id}/evidence`);
    const checked = await validateWorkspaceEvidence(value, id, cryptoImpl);
    if (!current(op) || $('deal').value !== id) return;
    view = checked; renderView();
  }
  async function submitCMS(op) {
    const pinned = intent, signed = cms;
    const result = await api('/api/test-workspace/receipts', { intentId: pinned.id, cms: signed });
    if (!current(op)) return;
    const snapshot = JSON.parse(pinned.text).snapshot;
    if (typeof result?.historical !== 'boolean' || !receiptValid(result.receipt, snapshot, pinned.hash)) throw fail();
    receipt = { ...result.receipt }; $('receipt').hidden = false;
    $('receipt-kind').textContent = result.historical ? 'Историческая TEST-квитанция' : 'Новая TEST-квитанция';
    $('receipt-note').textContent = result.historical
      ? 'Получена прежняя сохранённая квитанция. Повтор не создал новой подписи, не подтвердил текущий статус и не выдал разрешений.'
      : 'Точная личная TEST CMS проверена и записана один раз. Вторая сторона, роли, полномочия и операции этим не подтверждены.';
    $('receipt-bytes').textContent = canonical(receipt); message($('receipt-note').textContent);
    await loadView(op);
  }
  async function submitUpload(op) {
    const pending = upload;
    const result = await api(`/api/test-workspace/deals/${pending.dealId}/documents`, pending.body);
    if (!current(op)) return;
    const doc = result?.document;
    if (doc?.dealId !== pending.dealId || doc.termsVersion !== pending.body.expectedVersion || doc.category !== pending.body.category ||
        doc.byteLength !== pending.byteLength || doc.sha256 !== pending.sha256 || doc.scope !== 'local_test_document_only' ||
        doc.fileKind !== 'text' || typeof doc.id !== 'string' || !UUID.test(doc.id) || !integer(doc.createdAt)) throw fail();
    upload = null; $('file').value = ''; clearIntent(); message('Тестовый документ сохранён. Его содержимое и SHA-256 связаны с указанной версией.'); await loadView(op);
  }
  function bind(name, event, fn) { const element = $(name); element.addEventListener(event, fn); listeners.push([element, event, fn]); }
  bind('deal', 'change', () => {
    const lost = Boolean(cms); ++generation; busy = false; clearIntent(); clearView(); upload = null; $('file').value = '';
    if (lost) message('Контекст прежней CMS очищен. Если ответ был потерян, результат требует защищённого readback оператора.', true);
    return run(op => loadView(op));
  });
  for (const name of ['file', 'category', 'consent']) bind(name, 'change', () => {
    const lost = Boolean(cms); ++generation; busy = false; clearIntent(); upload = null;
    if (name === 'consent' && !$('consent').checked) $('file').value = '';
    if (lost) message('Контекст CMS очищен при изменении документов. Потерянный результат требует readback оператора.', true);
    controls();
  });
  bind('refresh', 'click', () => run(async op => { clearIntent(); clearView(); await loadView(op); message('Сводка текущей версии обновлена.'); }));
  bind('create', 'click', () => run(async op => {
    clearIntent(); const expectedView = structuredClone(view), id = view.deal.id;
    const result = await api('/api/test-workspace/intents', { dealId: id, expectedVersion: view.terms.version });
    const checked = await validateTermsIntent(result?.intent, expectedView, now(), cryptoImpl);
    if (!current(op) || $('deal').value !== id) return;
    intent = structuredClone(checked); $('intent').hidden = false; $('exact-bytes').textContent = intent.text; $('intent-hash').textContent = intent.hash;
    message('Проверь точный TEST-снимок. Подпись свидетельствует только об этих условиях и хэшах документов.');
  }));
  bind('sign', 'click', () => run(async op => {
    if (!intent || cms || !view) throw fail();
    await validateTermsIntent(intent, view, now(), cryptoImpl); if (!current(op)) return;
    message('Выбери личный TEST-сертификат в NCALayer. Пароль вводится только там.');
    const signed = await ncalayer(signingRequest(intent, status.signing.chain));
    if (!current(op)) return;
    if (typeof signed !== 'string' || signed.length > 131072) throw fail(); decode(signed);
    cms = signed; await submitCMS(op);
  }));
  bind('retry', 'click', () => run(submitCMS));
  bind('upload', 'click', () => run(async op => {
    const id = view.deal.id, version = view.terms.version, category = $('category').value;
    if (!CATEGORIES.includes(category)) throw fail('invalid_file');
    const checked = await readTestDocument($('file').files?.[0], $('consent').checked, cryptoImpl);
    if (!current(op) || $('deal').value !== id) return;
    upload = { dealId: id, byteLength: checked.byteLength, sha256: checked.sha256,
      body: { expectedVersion: version, requestId: cryptoImpl.randomUUID(), category, bytesBase64: checked.bytesBase64 } };
    clearIntent(); await submitUpload(op);
  }));
  bind('upload-retry', 'click', () => run(submitUpload));
  bind('export', 'click', () => run(async () => {
    const blob = new BlobImpl([canonical(view)], { type: 'application/json;charset=utf-8' });
    const url = URLImpl.createObjectURL(blob); urls.add(url);
    const link = document.createElement('a'); link.href = url; link.download = `dalahold-test-${view.deal.id}-v${view.terms.version}.json`;
    document.body.append(link); link.click(); link.remove(); URLImpl.revokeObjectURL(url); urls.delete(url);
    message('Экспортирована проверенная загруженная TEST-сводка. CMS, сессия и название выбранного файла в экспорт не входят.');
  }));
  bind('close', 'click', async () => {
    const token = status?.csrfToken || closeToken; if (!token || closing || closeAttempts >= 3) return;
    closeToken = token; closeAttempts++; closing = true; endSession(END_MESSAGE, true); controls();
    try {
      const result = await api('/api/test-workspace/session/close', {}, token);
      if (disposed) return;
      if (result?.closed !== true || result.scope !== SCOPE) throw fail();
      closeToken = null; message(END_MESSAGE);
    } catch {
      if (!disposed) { if (closeAttempts >= 3) closeToken = null; message(`${END_MESSAGE} Подтверждение закрытия сервера не получено.${closeToken ? ' Повтори закрытие; доступно не более трёх попыток.' : ' Повторные попытки исчерпаны; проверь закрытие через оператора.'}`, true); }
    } finally { closing = false; controls(); }
  });
  const initialized = (async () => {
    busy = true; const op = ++generation; controls();
    try {
      const received = await api('/api/test-workspace/status');
      if (received?.scope !== SCOPE || typeof received.csrfToken !== 'string' || !HASH.test(received.csrfToken) ||
          !integer(received.sessionExpiresAt, now() + 1) || typeof received.signing?.ready !== 'boolean') throw fail();
      if (received.signing.ready) {
        if (received.signing.statusSource !== 'test_ocsp' || !integer(received.signing.validUntil, now() + 1)) throw fail();
        signingRequest({ bytesBase64: 'dGVzdA==' }, received.signing.chain);
      }
      if (disposed || op !== generation) return;
      status = structuredClone(received);
      $('sdk').textContent = status.signing.ready ? 'SDK: явный TEST OCSP готов для одной личной TEST CMS.' : 'SDK не готов: документы и сводка доступны; новая TEST-подпись закрыта.';
      const result = await api('/api/deals');
      if (!current(op)) return;
      if (!Array.isArray(result?.deals)) throw fail();
      $('deal').replaceChildren();
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Выбрать сохранённый черновик'; $('deal').append(empty);
      const ids = new Set();
      for (const deal of result.deals) {
        const terms = { dealId: deal.id, version: deal.version, scenario: deal.scenario, quantity: deal.quantity, amount: deal.amount, date: deal.date };
        if (!termsValid(terms) || !HASH.test(deal.termsFingerprint || '') || ids.has(deal.id)) throw fail(); ids.add(deal.id);
        const option = document.createElement('option'); option.value = deal.id; option.textContent = `${deal.scenario === 'grain' ? 'Зерно' : 'Животноводство'} · v${deal.version} · ${deal.id.slice(0, 8)}`; $('deal').append(option);
      }
      const requested = new URLSearchParams(locationImpl?.search || '').get('dealId');
      if (requested && (!UUID.test(requested) || !ids.has(requested))) message('Запрошенный ID черновика не найден. Выбери его из списка.', true);
      else if (requested) { $('deal').value = requested; await loadView(op, requested); message('Загружен локальный TEST-кабинет выбранного черновика.'); }
      else message(ids.size ? 'Выбери сохранённый черновик. Документы и подписи относятся к точной версии.' : 'Сначала создай локальный неподписанный черновик в основном кабинете.');
    } catch (error) { if (!disposed && op === generation) errorMessage(error); }
    finally { if (!disposed && op === generation && !terminal) { busy = false; controls(); } }
  })();
  const timer = setIntervalImpl(controls, 1000);
  return { initialized, dispose() { disposed = true; ++generation; clearIntervalImpl(timer); revokeUrls(); status = view = intent = cms = receipt = upload = closeToken = null;
    for (const [element, event, fn] of listeners) element.removeEventListener(event, fn); } };
}

if (typeof document !== 'undefined') mountTestWorkspace(document);
