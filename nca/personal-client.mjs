import { ncalayerCall, signingRequest } from './client.mjs';

const scope = 'test_personal_binding_only';
const action = 'enroll_test_person';
const intentPurpose = 'ТЕСТОВАЯ ЛИЧНАЯ ПРИВЯЗКА. Вход, корпоративные полномочия, кошелёк и платёж не разрешаются.';
const intentKeys = 'action,bindingId,domain,expectedEpoch,expiresAt,issuedAt,mappingKeyId,newCertificateDigest,nonce,previousCertificateDigest,purpose,sessionHash,statusSource';
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const messages = {
  ncalayer_unavailable: 'NCALayer недоступен. Запусти его на этом компьютере и проверь соединение снова.',
  ncalayer_disconnected: 'Соединение с NCALayer закрылось. Подпись не отправлена; можно повторить подписание.',
  ncalayer_timeout: 'Время ожидания NCALayer истекло. Проверь срок намерения и повтори подписание.',
  signing_cancelled_or_rejected: 'Подписание отменено или сертификат не подходит. Подпись не отправлена. Можно повторить с TEST-контейнером физического лица.',
  invalid_ncalayer_response: 'Ответ NCALayer не содержит поддерживаемую подпись. Проверка не выполнена.',
  invalid_request: 'Запрос подписи не прошёл локальную проверку. Обнови готовность и создай новое намерение.',
  invalid_personal_response: 'Ответ локального сервера не прошёл проверку. Создай новое намерение после обновления готовности.',
  personal_session_unavailable: 'TEST-сессия недоступна или истекла. Данные страницы очищены; начни новую сессию.',
  personal_csrf_required: 'Сервер отклонил защитный токен TEST-сессии. Данные страницы очищены; начни новую сессию.',
  personal_rate_limited: 'Достигнут лимит запросов TEST-сессии. Подожди и повтори действие.',
  personal_test_unavailable: 'Личная TEST-привязка сейчас недоступна. Обнови готовность после включения локального режима.',
  binding_state_unavailable: 'Реестр TEST-привязок недоступен. Сохранение остановлено; обнови готовность после восстановления реестра.',
  verifier_busy: 'Сервер уже выполняет проверку. Подожди немного и повтори отправку подписи.',
  status_unavailable: 'TEST OCSP-статус сертификата не подтверждён. Обнови готовность после восстановления проверки.',
  binding_identity_rejected: 'Подпись отклонена: точные байты, назначение, TEST-цепочка или статус сертификата физического лица не прошли проверку.',
  organization_binding_disabled: 'Этот сертификат не относится к разрешённому TEST-профилю физического лица. Корпоративная привязка недоступна.',
  binding_replay_conflict: 'Намерение уже использовано другой подписью. Эта отправка не создала новую квитанцию.',
  certificate_rebind_required: 'Для этого лица уже привязан другой сертификат. Замена сертификата на этой странице недоступна.',
  binding_storage_limit: 'Лимит локального реестра достигнут. Новая привязка не сохранена.',
  binding_intent_expired: 'Намерение истекло. Создай новое намерение и подпиши его.',
  network_error: 'Локальный сервер недоступен. Сохранённую в памяти подпись можно отправить повторно; совпадающий результат вернётся как историческая квитанция.',
};

function failure(code, retryAfter = 0) {
  const error = new Error(Object.hasOwn(messages, code) ? code : 'request_failed');
  error.retryAfter = retryAfter;
  return error;
}

export async function validatePersonalIntent(intent, now = Date.now(), cryptoImpl = globalThis.crypto) {
  if (!intent || !idPattern.test(intent.id || '') || typeof intent.text !== 'string' ||
      intent.text.length > 65_536 || typeof intent.bytesBase64 !== 'string' || intent.bytesBase64.length > 90_000 ||
      !hashPattern.test(intent.hash || '') || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= now ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(intent.bytesBase64)) {
    throw failure('invalid_personal_response');
  }
  try {
    const binary = atob(intent.bytesBase64);
    if (!binary || btoa(binary) !== intent.bytesBase64) throw new Error();
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== intent.text) throw new Error();
    const intentData = JSON.parse(intent.text);
    if (!intentData || Array.isArray(intentData) || Object.keys(intentData).sort().join(',') !== intentKeys ||
        intentData.action !== action || intentData.domain !== 'dalahold:test-person-binding:v1' ||
        intentData.purpose !== intentPurpose || !hashPattern.test(intentData.sessionHash || '') ||
        !hashPattern.test(intentData.mappingKeyId || '') || !Number.isSafeInteger(intentData.issuedAt) ||
        intentData.expiresAt !== intentData.issuedAt + 300_000 ||
        intentData.statusSource !== 'test_ocsp' || intentData.nonce !== intent.id ||
        intentData.expiresAt !== intent.expiresAt || intentData.bindingId !== null ||
        intentData.expectedEpoch !== null || intentData.previousCertificateDigest !== null ||
        intentData.newCertificateDigest !== null) throw new Error();
    const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
    if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== intent.hash) throw new Error();
  } catch { throw failure('invalid_personal_response'); }
  return intent;
}

function validateStatus(value, now) {
  if (value?.enabled !== true || value.ready !== true || value.scope !== scope || value.statusSource !== 'test_ocsp' ||
      typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.csrfToken) ||
      !Number.isSafeInteger(value.sessionExpiresAt) || value.sessionExpiresAt <= now ||
      !Number.isSafeInteger(value.validUntil) || value.validUntil <= now) throw failure('invalid_personal_response');
  signingRequest({ bytesBase64: 'dGVzdA==' }, value.chain);
  return value;
}

function validateReceipt(value, intent) {
  const receipt = value?.receipt;
  if (typeof value?.historical !== 'boolean' || receipt?.scope !== scope || receipt.action !== action ||
      receipt.statusSource !== 'test_ocsp' || receipt.intentHash !== intent.hash ||
      !idPattern.test(receipt.id || '') || !idPattern.test(receipt.bindingId || '') ||
      !hashPattern.test(receipt.certificateDigest || '') || !Number.isSafeInteger(receipt.epoch) || receipt.epoch < 0 ||
      !Number.isSafeInteger(receipt.verifiedAt) || !Number.isSafeInteger(receipt.validUntil) ||
      receipt.validUntil <= receipt.verifiedAt) throw failure('invalid_personal_response');
  return receipt;
}

export function mountPersonalPage(document, {
  fetchImpl = globalThis.fetch, ncalayer = ncalayerCall, now = Date.now,
  cryptoImpl = globalThis.crypto, setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
} = {}) {
  const $ = name => document.getElementById(`personal-${name}`);
  const workspace = $('workspace');
  if (!workspace) return null;
  let ready = null, intent = null, cms = null, receipt = null;
  let busy = false, terminal = false, closing = false, disposed = false;
  let generation = 0, controller = null, closeToken = null, cooldownUntil = 0;
  const listeners = [];
  const formatDate = value => new Date(value).toLocaleString('ru-RU');
  const current = operation => {
    if (disposed || operation !== generation || terminal) return false;
    if (ready && ready.sessionExpiresAt <= now()) {
      endSession('Срок TEST-сессии истёк. Данные страницы очищены; начни новую сессию.');
      return false;
    }
    return true;
  };
  function message(text, failed = false) {
    $('result').textContent = text;
    $('result').classList.toggle('error', failed);
  }
  function clearEvidence() {
    intent = null; cms = null; receipt = null;
    $('intent').hidden = true; $('receipt').hidden = true;
    for (const name of ['exact-bytes', 'base64', 'hash', 'intent-expiry', 'receipt-note', 'receipt-id',
      'receipt-hash', 'receipt-binding', 'receipt-epoch', 'receipt-certificate', 'receipt-verified',
      'receipt-until', 'receipt-source', 'receipt-scope']) $(name).textContent = '';
    $('receipt-kind').textContent = 'Тестовая квитанция';
  }
  function endSession(text, { preserveCloseToken = false } = {}) {
    ++generation; controller?.abort(); controller = null;
    ready = null; busy = false; terminal = true; cooldownUntil = 0;
    if (!preserveCloseToken) closeToken = null;
    clearEvidence();
    $('sdk').textContent = 'Личная TEST-привязка: сессия завершена';
    $('session-expiry').textContent = 'Активной TEST-сессии на странице нет.';
    $('connection').textContent = 'NCALayer: новая операция не запрашивается';
    message(text);
    controls();
  }
  function controls() {
    if (disposed) return;
    if (ready && ready.sessionExpiresAt <= now()) {
      endSession('Срок TEST-сессии истёк. Данные страницы очищены; начни новую сессию.');
      return;
    }
    if (ready?.chain && ready.validUntil <= now()) {
      ready = { ...ready, chain: null };
      $('sdk').textContent = 'Срок подтверждённой готовности истёк. Обнови готовность перед новой подписью.';
    }
    const blocked = busy || terminal || closing || cooldownUntil > now();
    const fresh = intent && intent.expiresAt > now();
    $('refresh').disabled = blocked;
    $('connect').disabled = blocked;
    $('create').disabled = blocked || !ready?.chain;
    $('sign').disabled = blocked || !ready?.chain || !fresh || Boolean(receipt);
    // Identical history retry is intentionally usable after intent/status expiry.
    $('retry').disabled = blocked || !cms || !intent;
    $('close').disabled = closing || !(ready?.csrfToken || closeToken);
    $('close').textContent = closeToken && !closing ? 'Повторить закрытие TEST-сессии' : 'Закрыть TEST-сессию';
    $('new-session').hidden = !terminal || closing || Boolean(closeToken);
    workspace.setAttribute('aria-busy', String(busy || closing));
    if (ready) $('session-expiry').textContent = `TEST-сессия до ${formatDate(ready.sessionExpiresAt)} · ещё ${Math.ceil((ready.sessionExpiresAt - now()) / 1000)} сек.`;
    if (intent) $('intent-expiry').textContent = fresh
      ? `Намерение до ${formatDate(intent.expiresAt)} · ещё ${Math.ceil((intent.expiresAt - now()) / 1000)} сек.`
      : 'Срок намерения истёк. Для новой подписи создай новое; повторная отправка сохранённой подписи может получить историческую квитанцию.';
  }
  async function api(path, { value, token = ready?.csrfToken, signal } = {}) {
    let response;
    try {
      response = await fetchImpl(path, value === undefined
        ? { cache: 'no-store', credentials: 'same-origin', signal }
        : { method: 'POST', cache: 'no-store', credentials: 'same-origin', signal,
          headers: { 'Content-Type': 'application/json', 'X-DalaHold-CSRF': token }, body: JSON.stringify(value) });
    } catch { throw failure('network_error'); }
    let result;
    try { result = await response.json(); } catch { throw failure('invalid_personal_response'); }
    if (!response.ok) {
      const seconds = Number(response.headers?.get('Retry-After'));
      throw failure(result?.error, Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : 0);
    }
    return result;
  }
  function handleError(error) {
    const code = error.message;
    if (['personal_session_unavailable', 'personal_csrf_required'].includes(code)) {
      endSession(messages[code]);
      $('result').focus();
      return;
    }
    if (['personal_test_unavailable', 'binding_state_unavailable', 'status_unavailable'].includes(code)) {
      if (ready) ready = { ...ready, chain: null };
      $('sdk').textContent = 'Личная TEST-привязка: готовность не подтверждена';
    }
    if (!ready?.chain) {
      $('sdk').textContent = 'Личная TEST-привязка: готовность не подтверждена';
      if (!ready) $('session-expiry').textContent = 'Срок TEST-сессии не получен. Обнови готовность.';
    }
    if (['ncalayer_unavailable', 'ncalayer_disconnected', 'ncalayer_timeout'].includes(code)) {
      $('connection').textContent = 'NCALayer: соединение недоступно';
    }
    if (error.retryAfter) cooldownUntil = now() + error.retryAfter * 1000;
    message((messages[code] || 'Операция не выполнена. Обнови готовность и повтори.') +
      (error.retryAfter ? ` Повтор возможен через ${error.retryAfter} сек.` : ''), true);
  }
  async function run(fn) {
    controls();
    if (busy || terminal || closing || cooldownUntil > now()) return;
    busy = true; controller = new AbortController();
    const operation = ++generation, signal = controller.signal;
    controls();
    try { await fn(operation, signal); }
    catch (error) { if (current(operation)) handleError(error); }
    finally { if (current(operation)) { busy = false; controller = null; controls(); } }
  }
  async function loadStatus(operation, signal) {
    // A failed refresh must not leave the previously accepted chain usable.
    if (ready) ready = { ...ready, chain: null };
    $('sdk').textContent = 'Проверяем готовность личной TEST-привязки…';
    const value = await api('/api/personal-test/status', { signal });
    if (!current(operation)) return false;
    ready = validateStatus(value, now());
    $('sdk').textContent = 'TEST-цепочка готова. OCSP-статус конкретного сертификата проверяется после получения подписи.';
    return true;
  }
  async function submit(operation, signal) {
    const submittedIntent = intent, submittedCms = cms;
    message('Сервер проверяет точные байты, TEST-сертификат физического лица и OCSP-статус…');
    const result = await api('/api/personal-test/receipts', {
      value: { intentId: submittedIntent.id, cms: submittedCms }, signal,
    });
    if (!current(operation)) return;
    receipt = validateReceipt(result, submittedIntent);
    $('receipt-kind').textContent = result.historical ? 'Историческая TEST-квитанция' : 'Свежая TEST-квитанция';
    $('receipt-note').textContent = result.historical
      ? 'Получен сохранённый результат первоначальной проверки. Нового подтверждения статуса эта квитанция не создаёт; актуальный статус сертификата этим повтором не подтверждён.'
      : 'Тестовая привязка сохранена. Сертификат и его TEST OCSP-статус проверены при этой операции.';
    const fields = { id: receipt.id, hash: receipt.intentHash, binding: receipt.bindingId, epoch: receipt.epoch,
      certificate: receipt.certificateDigest, verified: formatDate(receipt.verifiedAt), until: formatDate(receipt.validUntil),
      source: 'Тестовый OCSP НУЦ · test_ocsp', scope: 'Только личная TEST-привязка · test_personal_binding_only' };
    for (const [name, value] of Object.entries(fields)) $(`receipt-${name}`).textContent = String(value);
    $('receipt').hidden = false;
    message(result.historical ? 'Историческая TEST-квитанция получена. Повтор не создаёт новую привязку.' : 'Свежая TEST-квитанция получена. Вход и бизнес-доступ не предоставлены.');
    $('receipt-kind').focus();
  }
  function on(name, handler) {
    const element = $(name);
    const listener = () => { if (!element.disabled && !disposed) return handler(); };
    element.addEventListener('click', listener);
    listeners.push([element, listener]);
  }
  on('refresh', () => run(async (operation, signal) => {
    message('Проверяем готовность TEST-сессии…');
    if (await loadStatus(operation, signal)) message('TEST-сессия готова. Проверь NCALayer и создай намерение.');
  }));
  on('connect', () => run(async operation => {
    message('Проверяем локальное соединение с NCALayer…');
    await ncalayer(null, { timeout: 7000 });
    if (!current(operation)) return;
    $('connection').textContent = 'NCALayer: соединение доступно';
    message('NCALayer доступен. Соединение само по себе не подтверждает сертификат или TEST-привязку.');
  }));
  on('create', () => run(async (operation, signal) => {
    clearEvidence();
    message('Создаём точное намерение для личной TEST-привязки…');
    if (!await loadStatus(operation, signal)) return;
    const result = await api('/api/personal-test/intents', { value: { action }, signal });
    if (!current(operation)) return;
    const validated = await validatePersonalIntent(result.intent, now(), cryptoImpl);
    if (!current(operation)) return;
    if (validated.expiresAt <= now()) throw failure('binding_intent_expired');
    intent = validated;
    $('exact-bytes').textContent = intent.text; $('base64').textContent = intent.bytesBase64; $('hash').textContent = intent.hash;
    $('intent').hidden = false;
    message('Проверь точные данные намерения. Затем подпиши их TEST-контейнером физического лица.');
    $('exact-title').focus();
  }));
  on('sign', () => run(async (operation, signal) => {
    cms = null;
    if (!intent || intent.expiresAt <= now()) throw failure('binding_intent_expired');
    message('Выбери TEST-контейнер физического лица для подписи в NCALayer. Пароль вводится только в его окне.');
    const signed = await ncalayer(signingRequest(intent, ready.chain));
    if (!current(operation)) return;
    controls();
    if (!current(operation)) return;
    if (intent.expiresAt <= now()) throw failure('binding_intent_expired');
    cms = signed;
    await submit(operation, signal);
  }));
  on('retry', () => run(submit));
  on('close', async () => {
    if (closing) return;
    const token = closeToken || ready?.csrfToken;
    if (!token) return;
    closeToken = token; closing = true;
    endSession('Данные страницы очищены. Закрываем серверную TEST-сессию…', { preserveCloseToken: true });
    const closingGeneration = generation;
    try {
      const result = await api('/api/personal-test/session/close', { value: {}, token });
      if (disposed || generation !== closingGeneration) return;
      if (result.closed !== true || result.scope !== scope) throw failure('invalid_personal_response');
      closeToken = null;
      message('TEST-сессия закрыта. Данные страницы очищены; поздние ответы не возобновят эту сессию.');
    } catch (error) {
      if (disposed || generation !== closingGeneration) return;
      if (error.message === 'personal_session_unavailable') {
        closeToken = null; message('Серверная TEST-сессия уже недоступна. Данные страницы очищены.');
      } else message('Данные страницы очищены, но сервер не подтвердил закрытие TEST-сессии. Повтори закрытие. Ожидающая серверная проверка ещё может завершиться.', true);
    } finally {
      if (!disposed && generation === closingGeneration) {
        closing = false; controls();
        (closeToken ? $('close') : $('new-session')).focus();
      }
    }
  });
  const interval = setIntervalImpl(controls, 1000);
  const initialized = run(async (operation, signal) => {
    if (await loadStatus(operation, signal)) message('TEST-сессия готова. Проверь NCALayer и создай тестовое намерение.');
  });
  return { initialized, dispose() {
    if (disposed) return;
    endSession('Страница закрыта. Локальные данные очищены.');
    disposed = true; clearIntervalImpl(interval);
    for (const [element, listener] of listeners) element.removeEventListener('click', listener);
  } };
}

if (typeof document !== 'undefined' && document.getElementById('personal-workspace')) mountPersonalPage(document);
