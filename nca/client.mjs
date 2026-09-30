const socketUrl = 'wss://127.0.0.1:13579/';

export function signingRequest(challenge, chain) {
  if (!Array.isArray(chain) || chain.length !== 2 ||
      !chain.every((item) => typeof item === 'string' && item.startsWith('-----BEGIN CERTIFICATE-----')) ||
      typeof challenge?.bytesBase64 !== 'string' || !challenge.bytesBase64) throw new Error('invalid_request');
  return { module: 'kz.gov.pki.knca.basics', method: 'sign', args: {
    allowedStorages: ['PKCS12'], format: 'cms', data: challenge.bytesBase64,
    signingParams: { decode: true, encapsulate: false, digested: false },
    signerParams: { extKeyUsageOids: ['1.3.6.1.5.5.7.3.4'], chain }, locale: 'ru',
  } };
}

export function signatureFromResponse(response) {
  if (response?.status !== true) throw new Error('signing_cancelled_or_rejected');
  // Basics EmptyResponse (dialog dismissed) is wrapped as status:true, body:{}.
  // It is cancellation, never a successful signing result.
  if (response.body && typeof response.body === 'object' && !Array.isArray(response.body) &&
      Object.keys(response.body).length === 0) throw new Error('signing_cancelled_or_rejected');
  const result = response.body?.result;
  const value = result && typeof result === 'object' && !Array.isArray(result)
    ? result.signatures : result;
  const signatures = Array.isArray(value) ? value : [value];
  if (signatures.length !== 1 || typeof signatures[0] !== 'string' ||
      !signatures[0] || signatures[0].length > 131072) throw new Error('invalid_ncalayer_response');
  // Installed Basics wraps CMS in one PEM block. Normalize only its transport;
  // the server still validates the original CMS bytes, certificate and status.
  const pem = /^-----BEGIN CMS-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CMS-----(?:\r?\n)?$/.exec(signatures[0]);
  const base64 = pem ? pem[1].replace(/[\r\n]/g, '') : signatures[0];
  if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) ||
      btoa(atob(base64)) !== base64) throw new Error('invalid_ncalayer_response');
  return base64;
}

export function ncalayerCall(request, { WebSocketClass = globalThis.WebSocket, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClass(socketUrl);
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('ncalayer_timeout')), timeout);
    socket.onopen = () => {
      if (finished) return;
      if (!request) done(null, true);
      else socket.send(JSON.stringify(request));
    };
    socket.onerror = () => done(new Error('ncalayer_unavailable'));
    socket.onclose = () => done(new Error('ncalayer_disconnected'));
    socket.onmessage = ({ data }) => {
      if (finished) return;
      try {
        if (typeof data !== 'string' || data.length > 160_000) throw new Error('invalid_ncalayer_response');
        const response = JSON.parse(data);
        // NCALayer sends its protocol version independently of the method response.
        if (response?.result?.version && !Object.hasOwn(response, 'status')) return;
        done(null, signatureFromResponse(response));
      } catch (error) { done(error); }
    };
  });
}

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const events = [];
  let ready = null;
  let challenge = null;
  let cms = null; // memory only: never localStorage, export or console
  let logUrl = null;
  let busy = false;
  let currentOperation = 0;
  const messages = {
    ncalayer_unavailable: 'NCALayer недоступен. Запусти приложение на этом Mac и проверь соединение ещё раз.',
    ncalayer_disconnected: 'Соединение с NCALayer закрылось. Подпись не отправлена на сервер.',
    ncalayer_timeout: 'Время ожидания NCALayer истекло. Создай новое распоряжение и повтори.',
    signing_cancelled_or_rejected: 'Подписание отменено или сертификат не подходит. Можно выбрать тестовый сертификат и повторить.',
    invalid_ncalayer_response: 'NCALayer вернул неподдерживаемый ответ. Проверка не выполнена.',
    invalid_signature_request: 'Сервер отклонил формат запроса подписи. Обнови страницу, создай новое распоряжение и повтори. Криптографическая проверка ещё не выполнялась.',
    signature_rejected: 'Подпись отклонена: данные, назначение сертификата или тестовая цепочка не прошли проверку.',
    challenge_expired: 'Распоряжение истекло. Создай новое и подпиши его.',
    status_unavailable: 'Сервер не может подтвердить статус сертификата: источник отсутствует, устарел или не прошёл проверку. Обнови страницу после восстановления проверки.',
    crl_pair_mismatch: 'Базовый CRL и delta-CRL из SDK несовместимы. Нужна согласованная пара от НУЦ; до этого подписание на стенде закрыто.',
    verifier_unavailable: 'Проверка SDK недоступна. Повтори после восстановления сервера.',
    verifier_busy: 'Сервер уже выполняет проверку. Повтори через несколько секунд.',
    replay_conflict: 'Этот запрос уже погашен другой подписью. Нового результата не создано.',
    status_source_changed: 'Режим проверки статуса сменился. Создай и подпиши новое распоряжение.',
    network_error: 'Локальный сервер недоступен. При повторной отправке результат будет получен только один раз.',
  };
  function log(code) {
    events.push({ code, at: new Date().toISOString() });
    if (events.length > 100) events.shift();
  }
  function message(text, failed = false) {
    $('result').textContent = text;
    $('result').classList.toggle('error', failed);
  }
  function controls() {
    const fresh = challenge && challenge.expiresAt > Date.now();
    $('create').disabled = busy || !ready;
    $('connect').disabled = busy;
    $('export').disabled = busy;
    $('sign').disabled = busy || !ready || !fresh;
    $('retry').disabled = busy || !cms;
    if (challenge) $('expiry').textContent = fresh
      ? `Действует ещё ${Math.ceil((challenge.expiresAt - Date.now()) / 1000)} сек.`
      : 'Срок истёк. Создай новое распоряжение.';
    $('workspace').setAttribute('aria-busy', String(busy));
  }
  async function api(path, value) {
    let response;
    try {
      response = await fetch(path, value === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
      });
    } catch { throw new Error('network_error'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error === 'status_unavailable' && result.reason === 'crl_pair'
      ? 'crl_pair_mismatch' : result.error || 'verifier_unavailable');
    return result;
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    const operation = ++currentOperation;
    controls();
    try { await fn(operation); }
    catch (error) {
      log(messages[error.message] ? error.message : 'request_failed');
      if (['status_unavailable', 'crl_pair_mismatch'].includes(error.message)) {
        ready = null;
        $('sdk').textContent = error.message === 'crl_pair_mismatch'
          ? 'SDK: несовместимые base/delta CRL'
          : 'SDK: статус сертификата не подтверждён';
      }
      if (['ncalayer_unavailable', 'ncalayer_disconnected', 'ncalayer_timeout'].includes(error.message)) {
        $('connection').textContent = 'NCALayer: соединение недоступно';
      }
      message(messages[error.message] || 'Проверка не выполнена. Создай новое распоряжение и повтори.', true);
    } finally {
      if (operation === currentOperation) { busy = false; controls(); }
    }
  }
  async function submit(operation) {
    message('Сервер проверяет точные байты, сертификат и выбранный источник статуса…');
    const result = await api('/api/verify', { challengeId: challenge.id, cms });
    if (operation !== currentOperation) return;
    log(result.replay ? 'historical_receipt' : 'test_signature_verified');
    message(result.replay
      ? 'Получена сохранённая тестовая квитанция. Повторного погашения запроса нет; новая проверка статуса не выполнялась.'
      : 'Тестовая подпись проверена. Распоряжение погашено один раз. Доступ к кошельку и платёж этим тестом не разрешаются.');
    $('receipt').hidden = false;
    $('receiptId').textContent = result.receipt.id;
    $('receiptHash').textContent = result.receipt.challengeHash;
    $('receiptScope').textContent = result.receipt.statusSource === 'test_ocsp'
      ? 'Тестовый OCSP НУЦ · проверка тестовой подписи'
      : 'Локальные тестовые CRL · проверка тестовой подписи';
    $('sign').hidden = true;
  }
  $('connect').addEventListener('click', () => action(async () => {
    message('Проверяем локальное соединение с NCALayer…');
    await ncalayerCall(null, { timeout: 7000 });
    $('connection').textContent = 'NCALayer: соединение доступно';
    log('ncalayer_connected');
    message(ready
      ? 'Соединение доступно. Создай распоряжение и выбери комплектный тестовый сертификат.'
      : 'Соединение с NCALayer доступно, но статус сертификата через SDK не подтверждён. Создание и подписание распоряжения закрыты.', !ready);
  }));
  $('create').addEventListener('click', () => action(async (operation) => {
    cms = null;
    challenge = null;
    $('receipt').hidden = true;
    $('instruction').hidden = true;
    ready = await api('/api/status');
    const result = await api('/api/challenges', {});
    if (operation !== currentOperation) return;
    challenge = result.challenge;
    $('exactBytes').textContent = challenge.text;
    $('hash').textContent = challenge.hash;
    $('instruction').hidden = false;
    $('sign').hidden = false;
    log('challenge_issued');
    message('Проверь текст ниже. Кнопка откроет NCALayer и отправит полученную подпись на сервер.');
  }));
  $('sign').addEventListener('click', () => action(async (operation) => {
    cms = null;
    message('Выбери тестовый контейнер для подписи в NCALayer. Пароль вводится только в его окне.');
    const signed = await ncalayerCall(signingRequest(challenge, ready.chain));
    if (operation !== currentOperation) return;
    cms = signed;
    log('cms_received');
    await submit(operation);
  }));
  $('retry').addEventListener('click', () => action(submit));
  $('export').addEventListener('click', () => action(async () => {
    const serverLog = await api('/api/events');
    const text = JSON.stringify({ scope: 'test_signature_only', browser: events,
      server: serverLog.events }, null, 2);
    $('logBytes').textContent = text;
    $('logPreview').hidden = false;
    $('logPreview').open = true;
    if (logUrl) URL.revokeObjectURL(logUrl);
    logUrl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    // A separate user click preserves download activation. The visible text
    // remains usable even if the embedded browser does not support downloads.
    $('logDownload').href = logUrl;
  }));
  setInterval(controls, 1000);
  action(async () => {
    ready = await api('/api/status');
    $('sdk').textContent = ready.statusSource === 'test_ocsp'
      ? 'SDK: тестовая цепочка готова · OCSP проверяется после получения подписи'
      : `SDK готов · тестовые CRL до ${new Date(ready.validUntil).toLocaleString('ru-RU')}`;
    message(ready.statusSource === 'test_ocsp'
      ? 'Тестовый OCSP-режим. Статус конкретного сертификата пока не проверен. Проверь NCALayer и создай распоряжение.'
      : 'Сервер готов. Проверь NCALayer и создай тестовое распоряжение.');
  });
}
