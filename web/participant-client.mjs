// Isolated local TEST participant cabinet. A personal TEST certificate never grants business or payment authority.
export const PARTICIPANT_SCOPE = 'local_test_participant_statements_only';
export const SIGNED_PARTICIPANT_SCOPE = 'local_personal_test_signed_deal_only';
export const PARTICIPANT_API = '/api/participants/v1';
const SOURCE = 'unsigned_test_participant_statement';
const SIGNED_SOURCE = 'personal_test_nca_statement';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ROLES = ['seller', 'buyer'];
const STATES = ['draft', 'offered', 'agreed', 'handed_over', 'accepted', 'disputed'];
const CATEGORIES = ['contract', 'delivery', 'quality', 'other'];
export const ACTION_LABELS = Object.freeze({
  offer: 'Заявить TEST-предложение (без ЭЦП)',
  agree: 'Заявить TEST-согласие (без ЭЦП)',
  handover: 'Заявить TEST-передачу (без ЭЦП)',
  accept: 'Заявить TEST-приёмку (без ЭЦП)',
  dispute: 'Заявить TEST-спор (без ЭЦП)',
});
const SIGNED_ACTION_LABELS = Object.freeze({
  offer: 'TEST-предложение · личный TEST-сертификат',
  agree: 'TEST-согласие · личный TEST-сертификат',
  handover: 'TEST-передача · личный TEST-сертификат',
  accept: 'TEST-приёмка · личный TEST-сертификат',
  dispute: 'TEST-спор · личный TEST-сертификат',
});
const ROLE_LABELS = { seller: 'Продавец', buyer: 'Покупатель' };
const STATE_LABELS = { draft: 'Черновик', offered: 'TEST-предложение', agreed: 'TEST-согласие',
  handed_over: 'TEST-передача', accepted: 'TEST-приёмка · завершено', disputed: 'TEST-спор · завершено' };
const CATEGORY_LABELS = { contract: 'Условия / договор', delivery: 'Передача / доставка', quality: 'Качество', other: 'Другое' };
const ERRORS = {
  invalid_request: 'Проверьте поля: нужны целые числа и корректная дата.',
  invalid_response: 'Ответ локального сервера не прошёл проверку данных.',
  consent_required: 'До чтения файла подтвердите согласие.',
  statement_consent_required: 'Проверьте точные условия и подтвердите TEST-заявление.',
  invalid_file: 'Нужен обычный UTF-8 .txt от 1 байта до 256 КиБ, без управляющих символов.',
  invalid_participant: 'Укажите технический UUID приглашённого TEST-участника.',
  pending_write: 'Новый запрос заблокирован: сначала повторите прежний точный запрос.',
  registration_recovery_required: 'Результат создания TEST-участника неизвестен. Повтор создания заблокирован; потерянный код не восстанавливается. Закройте сессию или перезагрузите страницу.',
  session_ended: 'Сессия завершена. Перезагрузите страницу для нового входа.',
  session_required: 'Сначала дождитесь локальной сессии и войдите в TEST-кабинет.',
  unauthorized: 'Код TEST-доступа не принят или сессия завершена.',
  forbidden: 'Эта операция недоступна вашей роли в выбранной TEST-сделке.',
  stale_deal: 'Версия TEST-сделки изменилась. Загружены актуальные данные; проверьте их перед новым заявлением.',
  stale_draft: 'Версия TEST-черновика изменилась. Загружены актуальные данные.',
  snapshot_mismatch: 'Снимок изменился. Загружены актуальные условия; требуется новая проверка перед заявлением.',
  state_conflict: 'TEST-состояние уже изменилось. Загружены актуальные данные.',
  idempotency_conflict: 'ID запроса уже относится к другим точным данным. Операция отклонена.',
  store_corrupt: 'Локальное хранилище не подтвердило целостность. Продолжение записи недоступно.',
  invitation_expired: 'TEST-приглашение истекло. Попросите создателя выпустить новое.',
  invitation_unavailable: 'TEST-приглашение недоступно или адресовано другому ID.',
  document_limit: 'Лимит TEST-документов этой версии достигнут.',
  storage_limit: 'Лимит локального TEST-хранилища достигнут.',
  not_found: 'TEST-запись не найдена или недоступна этому участнику.',
  logout_ack_required: 'Перед выходом подтвердите предупреждение о неизвестном результате.',
  signature_required: 'В этом режиме заявление требует личной TEST-подписи. Сначала подготовьте точное намерение.',
  signing_unavailable: 'Личное TEST-подписание сейчас недоступно. Проверьте локальное приложение подписи и TEST-сервис.',
  signing_cancelled_or_rejected: 'Подписание отменено или TEST-сертификат не подходит. Новая подпись не отправлена.',
  invalid_signature_intent: 'Точные байты TEST-намерения не прошли проверку. Подписание закрыто.',
  signature_consent_required: 'Просмотрите точные байты намерения и подтвердите отдельное согласие на TEST-подпись.',
  intent_expired: 'TEST-намерение истекло. Подготовьте новое и заново проверьте его перед подписью.',
  binding_required: 'Сначала привяжите личный TEST-сертификат к своему локальному TEST-участнику.',
  signer_bindings_required: 'Для TEST-заявления обе стороны должны привязать свои личные TEST-сертификаты.',
  signature_rejected: 'Сервер отклонил TEST-подпись: байты, сертификат или статус не прошли проверку.',
  status_unavailable: 'Сервер не подтвердил актуальный статус личного TEST-сертификата.',
  anchor_unavailable: 'Администратор не настроил отдельный кошелёк для TEST-memo в Solana devnet.',
  signature_binding_required: 'Для TEST-заявления обе стороны должны привязать разные личные TEST-сертификаты.',
  signature_snapshot_stale: 'TEST-снимок изменился. Загружены текущие условия; нужно новое намерение и новое согласие.',
  signature_state_conflict: 'TEST-состояние изменилось. Проверьте текущие данные перед новым намерением.',
  signature_intent_expired: 'TEST-намерение истекло. Подготовьте новое; уже сохранённая операция этим не отменяется.',
  signature_organization_disabled: 'В этом режиме разрешён только личный TEST-сертификат. Полномочия организации не поддерживаются.',
  signature_identity_mismatch: 'Личный TEST-сертификат не соответствует привязке этой стороны.',
  signature_anchor_unavailable: 'Администратор не настроил отдельный кошелёк для TEST-memo в Solana devnet.',
};
const fail = (code, status = 0, ambiguous = false) => Object.assign(new Error(code), { code, status, ambiguous });
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const token = value => typeof value === 'string' && value.length >= 1 && value.length <= 512 && !/[\p{Cc}\s]/u.test(value);
const select = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const canonical = value => JSON.stringify(value, null, 2);
const clone = value => structuredClone(value);

export function validateTerms(value) {
  if (!record(value) || !['grain', 'livestock'].includes(value.scenario) ||
      !integer(value.quantity, 1, 100000) || !integer(value.amount, 1, 999999999999) ||
      typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw fail('invalid_request');
  const parsed = new Date(`${value.date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.date) throw fail('invalid_request');
  return select(value, ['scenario', 'quantity', 'amount', 'date']);
}
function validateParticipant(value) {
  if (!record(value) || !uuid(value.id) || typeof value.label !== 'string' || !/^TEST participant \d{3}$/.test(value.label)) throw fail('invalid_response');
  return select(value, ['id', 'label']);
}
function validateDocument(value, dealId) {
  if (!record(value) || !uuid(value.id) || value.dealId !== dealId || !integer(value.termsVersion, 1) ||
      !CATEGORIES.includes(value.category) || !integer(value.byteLength, 1, 262144) || !hash(value.sha256) ||
      !integer(value.createdAt) || value.scope !== 'local_test_document_only' || value.fileKind !== 'text') throw fail('invalid_response');
  return select(value, ['id', 'dealId', 'termsVersion', 'category', 'byteLength', 'sha256', 'createdAt', 'scope', 'fileKind']);
}
function validateAuthorization(value) {
  const fields = ['receiptId', 'intentHash', 'certificateDigest', 'bindingId', 'authEpoch', 'statusSource'];
  if (!record(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',') ||
      !uuid(value.receiptId) || !hash(value.intentHash) || !hash(value.certificateDigest) || !uuid(value.bindingId) ||
      value.authEpoch !== 0 || value.statusSource !== 'test_ocsp') throw fail('invalid_response');
  return select(value, fields);
}
function validateEvent(value, dealId, scope = PARTICIPANT_SCOPE) {
  if (!record(value) || !uuid(value.id) || value.dealId !== dealId || !uuid(value.actorId) ||
      !ROLES.includes(value.role) || !Object.hasOwn(ACTION_LABELS, value.action) ||
      !integer(value.termsVersion, 1) || !integer(value.stateRevision, 1) || !integer(value.createdAt) ||
      !STATES.includes(value.stateFrom) || !STATES.includes(value.stateTo) || !hash(value.snapshotHash) ||
      !hash(value.termsFingerprint) || !hash(value.documentManifestHash) || value.source !== (scope === SIGNED_PARTICIPANT_SCOPE ? SIGNED_SOURCE : SOURCE) ||
      value.scope !== scope) throw fail('invalid_response');
  const checked = select(value, ['id', 'dealId', 'action', 'actorId', 'role', 'termsVersion', 'stateRevision', 'snapshotHash',
    'termsFingerprint', 'documentManifestHash', 'createdAt', 'stateFrom', 'stateTo', 'source', 'scope']);
  if (scope === SIGNED_PARTICIPANT_SCOPE) checked.authorization = validateAuthorization(value.authorization);
  return checked;
}
export function validateDeal(value, expectedScope) {
  try {
    if (!record(value) || !uuid(value.id) || !uuid(value.creatorId) || !integer(value.version, 1) ||
        !STATES.includes(value.state) || !integer(value.stateRevision) || !hash(value.termsFingerprint) ||
        !ROLES.includes(value.role) || !hash(value.snapshotHash) || ![PARTICIPANT_SCOPE, SIGNED_PARTICIPANT_SCOPE].includes(value.scope) ||
        (expectedScope && value.scope !== expectedScope) ||
        !Array.isArray(value.participants) || value.participants.length < 1 || value.participants.length > 2 ||
        !Array.isArray(value.documents) || value.documents.length > 10 || !Array.isArray(value.events) || value.events.length > 5) throw fail('invalid_response');
    const participants = value.participants.map(item => {
      if (!ROLES.includes(item?.role)) throw fail('invalid_response');
      return { ...validateParticipant(item), role: item.role };
    });
    if (new Set(participants.map(item => item.id)).size !== participants.length ||
        new Set(participants.map(item => item.role)).size !== participants.length ||
        !participants.some(item => item.id === value.creatorId) || !participants.some(item => item.role === value.role)) throw fail('invalid_response');
    const documents = value.documents.map(item => validateDocument(item, value.id));
    if (documents.some(item => item.termsVersion !== value.version) || new Set(documents.map(item => item.id)).size !== documents.length) throw fail('invalid_response');
    const events = value.events.map(item => validateEvent(item, value.id, value.scope));
    if (events.some((item, index) => item.stateRevision !== index + 1 || item.termsVersion > value.version ||
        !participants.some(party => party.id === item.actorId && party.role === item.role)) || events.length !== value.stateRevision) throw fail('invalid_response');
    if (value.scope === SIGNED_PARTICIPANT_SCOPE) {
      const transitions = { offer: ['seller', 'draft', 'offered'], agree: ['buyer', 'offered', 'agreed'],
        handover: ['seller', 'agreed', 'handed_over'], accept: ['buyer', 'handed_over', 'accepted'], dispute: [null, 'agreed', 'handed_over', 'disputed'] };
      let currentState = 'draft';
      for (const event of events) {
        const transition = transitions[event.action];
        if (event.stateFrom !== currentState || !transition.slice(1, -1).includes(currentState) || event.stateTo !== transition.at(-1) ||
            (transition[0] && event.role !== transition[0]) || event.termsVersion !== value.version ||
            event.termsFingerprint !== value.termsFingerprint || event.snapshotHash !== value.snapshotHash) throw fail('invalid_response');
        currentState = event.stateTo;
      }
      if (currentState !== value.state || (currentState !== 'draft' && participants.length !== 2)) throw fail('invalid_response');
    }
    const result = { ...select(value, ['id', 'creatorId', 'version']), ...validateTerms(value),
      ...select(value, ['state', 'stateRevision', 'termsFingerprint', 'role', 'scope', 'snapshotHash']), participants, documents, events };
    if (Object.hasOwn(value, 'documentHistory')) {
      if (!Array.isArray(value.documentHistory) || value.documentHistory.length > 1024) throw fail('invalid_response');
      result.documentHistory = value.documentHistory.map(item => validateDocument(item, value.id));
      if (result.documentHistory.some(item => item.termsVersion > value.version) ||
          new Set(result.documentHistory.map(item => item.id)).size !== result.documentHistory.length) throw fail('invalid_response');
    }
    return result;
  } catch { throw fail('invalid_response'); }
}
export function availableActions(deal) {
  if (!deal || !ROLES.includes(deal.role)) return [];
  if (deal.state === 'draft') return deal.role === 'seller' && deal.participants?.length === 2 ? ['offer'] : [];
  if (deal.state === 'offered') return deal.role === 'buyer' ? ['agree'] : [];
  if (deal.state === 'agreed') return deal.role === 'seller' ? ['handover', 'dispute'] : ['dispute'];
  if (deal.state === 'handed_over') return deal.role === 'buyer' ? ['accept', 'dispute'] : ['dispute'];
  return [];
}
export function buildCreateDeal(value, requestId) {
  if (!uuid(requestId) || !ROLES.includes(value?.creatorRole)) throw fail('invalid_request');
  return { requestId, creatorRole: value.creatorRole, ...validateTerms(value) };
}
export function buildVersion(deal, value, requestId) {
  if (!uuid(requestId) || !deal || deal.state !== 'draft' || deal.role !== 'seller' || !integer(deal.version, 1)) throw fail('forbidden');
  return { requestId, expectedVersion: deal.version, ...validateTerms(value) };
}
export function buildStatement(deal, action, requestId, consent) {
  if (consent !== true) throw fail('statement_consent_required');
  if (!uuid(requestId) || !availableActions(deal).includes(action) || !integer(deal.version, 1) ||
      !integer(deal.stateRevision) || !hash(deal.snapshotHash)) throw fail('forbidden');
  return { requestId, action, expectedVersion: deal.version, expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash };
}
export function statementPreview(deal, action) {
  if (!deal) return '';
  return canonical({ source: deal.scope === SIGNED_PARTICIPANT_SCOPE ? SIGNED_SOURCE : SOURCE, scope: deal.scope, action, role: deal.role, dealId: deal.id,
    terms: { version: deal.version, ...validateTerms(deal) }, state: deal.state, stateRevision: deal.stateRevision,
    participants: deal.participants, documents: [...deal.documents].sort((a, b) => a.id.localeCompare(b.id)),
    termsFingerprint: deal.termsFingerprint, snapshotHash: deal.snapshotHash });
}
export async function readParticipantDocument(file, consent) {
  if (consent !== true) throw fail('consent_required');
  if (!file || typeof file.name !== 'string' || !/\.txt$/i.test(file.name) || !['', 'text/plain'].includes(file.type) ||
      !integer(file.size, 1, 262144) || typeof file.arrayBuffer !== 'function') throw fail('invalid_file');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size || !integer(bytes.length, 1, 262144)) throw fail('invalid_file');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail('invalid_file'); }
  if (/[\p{Cc}]/u.test(text.replace(/[\t\r\n]/g, '')) || text.replace(/^\ufeff/, '').startsWith('%PDF-')) throw fail('invalid_file');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { contentBase64: btoa(binary) };
}
export function exportParticipantDeal(deal) {
  const checked = validateDeal(deal);
  return canonical({ schema: 'dalahold.local-test-participant-export.v1', scope: checked.scope,
    disclaimer: checked.scope === SIGNED_PARTICIPANT_SCOPE
      ? 'Личные TEST-подписи фиксируют только эту локальную TEST-последовательность. Реальный вход, организация, деловые полномочия, юридический договор и платёж не подтверждены.'
      : 'Локальные неподписанные TEST-заявления. Личность, полномочия, ЭЦП и платёж не подтверждены.', deal: checked }) + '\n';
}

export function createParticipantController({ fetchImpl = globalThis.fetch, now = Date.now,
  randomUUID = () => globalThis.crypto.randomUUID(), onChange = () => {}, onSecret = () => {},
  cryptoImpl = globalThis.crypto, signingModuleLoader = () => import(typeof document === 'undefined' ? './participant-signing-client.mjs' : './signing-client.mjs'),
  signingOptions = {} } = {}) {
  let session = null, deal = null, deals = [], pending = null, busy = false, ended = false, disposed = false, generation = 0;
  let scope = PARTICIPANT_SCOPE, signingModule = null, signingReady = null, binding = null, signatureIntent = null, signatureContext = null, signatureReceipt = null;
  let message = 'Подключение к локальному TEST-сервису…', issue = false;
  const state = () => ({ authenticated: Boolean(session?.authenticated), participant: session?.participant ? clone(session.participant) : null,
    expiresAt: session?.expiresAt ?? null, sessionReady: Boolean(session), scope,
    deal: deal ? clone(deal) : null, deals: clone(deals), busy, ended, message, issue,
    pending: pending ? { kind: pending.kind, ambiguous: pending.ambiguous, dealId: pending.dealId ?? null } : null,
    ...(scope === SIGNED_PARTICIPANT_SCOPE ? { signing: {
      ready: Boolean(signingReady?.ready && signingReady.validUntil > now()), statusSource: 'test_ocsp', anchorEnabled: signingReady?.anchorEnabled === true,
      binding: binding ? clone(binding) : null,
      intent: signatureIntent ? { ...select(signatureIntent, ['id', 'text', 'hash', 'expiresAt']), action: signatureContext.action } : null,
      intentFresh: Boolean(signatureIntent && signatureIntent.expiresAt > now()),
      receipt: signatureReceipt ? clone(signatureReceipt) : null,
    } } : {}) });
  const emit = () => { if (!disposed) onChange(state()); };
  const tell = (text, error = false) => { message = text; issue = error; emit(); };
  function clearLocal(text) {
    ++generation; session = null; deal = null; deals = []; pending = null; busy = false; ended = true;
    signingReady = binding = signatureIntent = signatureContext = signatureReceipt = null;
    onSecret(null); tell(text);
  }
  function expire() {
    if (session && session.expiresAt <= now()) {
      const uncertain = Boolean(pending);
      clearLocal('TEST-сессия истекла. Данные и коды очищены. ' + (uncertain
        ? 'Результат прежнего запроса мог сохраниться на сервере; истечение его не отменяет. '
        : '') + 'Перезагрузите страницу и войдите снова.');
      return true;
    }
    return false;
  }
  function active(op) { return !disposed && op === generation && !expire(); }
  function validateSession(value, authenticated = value?.authenticated) {
    if (!record(value) || typeof authenticated !== 'boolean' || value.authenticated !== authenticated || typeof value.csrfToken !== 'string' ||
        !hash(value.csrfToken) || !integer(value.expiresAt, now() + 1)) throw fail('invalid_response');
    if (![PARTICIPANT_SCOPE, SIGNED_PARTICIPANT_SCOPE].includes(value.scope) ||
        (session && value.scope !== scope) ||
        (value.scope === SIGNED_PARTICIPANT_SCOPE && (value.signing?.enabled !== true || value.signing.statusSource !== 'test_ocsp'))) throw fail('invalid_response');
    return { authenticated, csrfToken: value.csrfToken, expiresAt: value.expiresAt, scope: value.scope,
      ...(authenticated ? { participant: validateParticipant(value.participant) } : {}) };
  }
  async function request(path, options = {}) {
    let response;
    try { response = await fetchImpl(PARTICIPANT_API + path, { cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', ...options }); }
    catch { throw fail('network_error', 0, options.method === 'POST'); }
    let value;
    try { value = await response.json(); } catch { throw fail('invalid_response', response.status, options.method === 'POST'); }
    if (!response.ok) {
      const code = typeof value?.error?.code === 'string' ? value.error.code : 'request_failed';
      throw fail(code, response.status, options.method === 'POST' && response.status >= 500);
    }
    return value;
  }
  const sessionError = error => error.status === 401 || ['session_expired', 'session_unavailable', 'csrf_required', 'csrf_rejected'].includes(error.code);
  function requireSession(authenticated = true, retry = false) {
    expire();
    if (disposed || ended) throw fail('session_ended');
    if (!session || (authenticated && !session.authenticated)) throw fail('session_required');
    if (busy || (pending && !retry)) throw fail('pending_write');
  }
  function clearPreparedSignature() { signatureIntent = signatureContext = null; }
  function sameSignatureContext(context) {
    return session?.authenticated && context?.actorId === session.participant.id && scope === SIGNED_PARTICIPANT_SCOPE &&
      JSON.stringify(context.binding) === JSON.stringify(binding) &&
      (!context.deal || (deal?.id === context.deal.id && deal.version === context.deal.version &&
        deal.stateRevision === context.deal.stateRevision && deal.snapshotHash === context.deal.snapshotHash));
  }
  const putDeal = checked => {
    deal = checked; deals = [checked, ...deals.filter(item => item.id !== checked.id)];
    if (signatureContext?.deal && pending?.kind !== 'signature' && !sameSignatureContext(signatureContext)) clearPreparedSignature();
  };
  async function readBinding(op) {
    const value = await request('/identity');
    if (value?.scope !== SIGNED_PARTICIPANT_SCOPE) throw fail('invalid_response');
    const checked = value.binding === null ? null : signingModule.validateBinding(value.binding);
    if (active(op)) {
      binding = checked;
      if (signatureContext && pending?.kind !== 'signature' && !sameSignatureContext(signatureContext)) clearPreparedSignature();
    }
  }
  async function loadSigning(op) {
    if (scope !== SIGNED_PARTICIPANT_SCOPE || !session?.authenticated) return;
    const module = signingModule || await signingModuleLoader();
    if (!active(op)) return;
    signingModule = module;
    const value = await request('/signing');
    const checked = signingModule.validateReadiness(value, now());
    if (!active(op)) return;
    signingReady = checked;
    await readBinding(op);
  }
  async function list(op) {
    const result = await request('/deals');
    if (!Array.isArray(result?.deals) || result.deals.length > 100) throw fail('invalid_response');
    const checked = result.deals.map(item => validateDeal(item, scope));
    if (new Set(checked.map(item => item.id)).size !== checked.length ||
        checked.some(item => !item.participants.some(party => party.id === session?.participant?.id && party.role === item.role))) throw fail('invalid_response');
    if (active(op)) deals = checked;
  }
  async function detail(op, id) {
    const result = await request(`/deals/${id}`), checked = validateDeal(result?.deal, scope);
    if (checked.id !== id || !checked.participants.some(party => party.id === session?.participant?.id && party.role === checked.role)) throw fail('invalid_response');
    if (active(op)) putDeal(checked);
  }
  function report(error) {
    tell(ERRORS[error?.code || error?.message] || 'Локальная TEST-операция не завершена. Проверьте соединение и повторите допустимое действие.', true);
  }
  async function read(fn, success) {
    requireSession(true, true); busy = true; const op = ++generation; emit();
    try { await fn(op); if (active(op) && success) tell(success); }
    catch (error) { if (active(op)) { if (sessionError(error)) clearLocal('Сервер завершил TEST-сессию. Данные и коды очищены. Перезагрузите страницу для входа.'); else report(error); } }
    finally { if (active(op)) { busy = false; emit(); } }
  }
  async function applySuccess(pinned, value, op) {
    switch (pinned.kind) {
      case 'register': {
        const next = validateSession(value, true);
        if (!hash(value.accessCode)) throw fail('invalid_response');
        session = next; scope = next.scope; pending = null; onSecret({ kind: 'access', value: value.accessCode });
        tell('Локальный TEST-участник создан. Сохраните приватный код; он показан один раз.');
        await list(op); await loadSigning(op); break;
      }
      case 'login':
        session = validateSession(value, true); scope = session.scope; pending = null;
        tell('TEST-вход выполнен. Роли и данные доступны только в ваших локальных сделках.');
        await list(op); await loadSigning(op); break;
      case 'create':
      case 'version': {
        const checked = validateDeal(value?.deal, scope);
        if ((pinned.dealId && checked.id !== pinned.dealId) || !checked.participants.some(party => party.id === session.participant.id && party.role === checked.role)) throw fail('invalid_response');
        pending = null; putDeal(checked);
        const historical = value.historical === true || value.deal.historical === true;
        if (historical) await detail(op, checked.id);
        if (active(op)) tell(historical ? 'Подтверждён прежний запрос. Загружено текущее состояние TEST-сделки; новая версия не создавалась.'
          : value.deal.unchanged === true ? 'Условия уже совпадают. Новая TEST-версия не создавалась.'
          : pinned.kind === 'create' ? 'TEST-черновик сохранён. Добавьте вторую сторону адресным приглашением.'
          : 'Новая TEST-версия сохранена. Проверьте текущие документы и снимок.'); break;
      }
      case 'invite':
        if (!hash(value?.code) || !integer(value.expiresAt, now() + 1)) throw fail('invalid_response');
        pending = null; onSecret({ kind: 'invitation', value: value.code, expiresAt: value.expiresAt });
        tell('Адресное TEST-приглашение создано. Передайте код указанному участнику приватно.'); break;
      case 'claim':
        if (!uuid(value?.dealId) || typeof value.historical !== 'boolean') throw fail('invalid_response');
        pending = null; await detail(op, value.dealId); await list(op);
        if (active(op)) tell(value.historical ? 'Подтверждён прежний вход по этому TEST-приглашению; новое членство не создано.' : 'TEST-приглашение принято. Роль назначена сервером в этой сделке.'); break;
      case 'document':
        validateDocument(value?.document, pinned.dealId); pending = null; await detail(op, pinned.dealId);
        if (active(op)) tell('TEST-текст сохранён. SHA-256 снимка обновлён; проверьте его перед заявлением.'); break;
      case 'event': {
        const event = validateEvent(value?.event, pinned.dealId, scope), checked = validateDeal(value?.deal, scope);
        if (typeof value.historical !== 'boolean' || checked.id !== pinned.dealId ||
            event.action !== pinned.payload.action || event.snapshotHash !== pinned.payload.snapshotHash ||
            !checked.events.some(item => item.id === event.id) ||
            !checked.participants.some(party => party.id === session.participant.id && party.role === checked.role)) throw fail('invalid_response');
        pending = null; putDeal(checked);
        tell(value.historical ? 'Получена прежняя запись неподписанного TEST-заявления. Новое заявление не создано.'
          : 'Неподписанное TEST-заявление записано в локальный журнал. Это не ЭЦП и не денежная операция.'); break;
      }
      case 'signature-intent': {
        if (value?.scope !== SIGNED_PARTICIPANT_SCOPE || !sameSignatureContext(pinned.signatureContext)) throw fail('invalid_signature_intent');
        const checked = await signingModule.validateIntent(value.intent, pinned.signatureContext, now(), cryptoImpl);
        if (!active(op)) return;
        if (!sameSignatureContext(pinned.signatureContext)) throw fail('invalid_signature_intent');
        pending = null; signatureIntent = checked; signatureContext = pinned.signatureContext;
        tell('Точное TEST-намерение подготовлено. Просмотрите все байты и подтвердите новое согласие; подпись требует отдельного нажатия.'); break;
      }
      case 'signature': {
        if (value?.scope !== SIGNED_PARTICIPANT_SCOPE || !signatureIntent || !signatureContext) throw fail('invalid_response');
        const checkedReceipt = signingModule.validateReceipt(value.receipt, signatureIntent, signatureContext);
        if (typeof value.historical !== 'boolean') throw fail('invalid_response');
        let checkedDeal = null;
        if (signatureContext.deal) {
          checkedDeal = validateDeal(value.deal, scope);
          if (checkedDeal.id !== signatureContext.deal.id || !checkedDeal.participants.some(party => party.id === session.participant.id && party.role === checkedDeal.role)) throw fail('invalid_response');
          if (Object.hasOwn(ACTION_LABELS, signatureContext.action)) {
            const checkedEvent = validateEvent(value.event, checkedDeal.id, scope);
            const expectedAuthorization = { receiptId: checkedReceipt.id, intentHash: checkedReceipt.intentHash,
              certificateDigest: checkedReceipt.certificateDigest, bindingId: checkedReceipt.bindingId, authEpoch: checkedReceipt.authEpoch, statusSource: checkedReceipt.statusSource };
            if (checkedEvent.id !== checkedReceipt.eventId || checkedEvent.authorization.receiptId !== checkedReceipt.id ||
                JSON.stringify(checkedEvent.authorization) !== JSON.stringify(expectedAuthorization) || checkedEvent.action !== signatureContext.action ||
                checkedEvent.actorId !== signatureContext.actorId || checkedEvent.role !== signatureContext.deal.role ||
                checkedEvent.termsVersion !== signatureContext.deal.version || checkedEvent.stateRevision !== signatureContext.deal.stateRevision + 1 ||
                checkedEvent.snapshotHash !== signatureContext.deal.snapshotHash || checkedEvent.termsFingerprint !== signatureContext.deal.termsFingerprint ||
                !checkedDeal.events.some(item => JSON.stringify(item) === JSON.stringify(checkedEvent))) throw fail('invalid_response');
          }
        }
        pending = null; signatureReceipt = checkedReceipt; clearPreparedSignature();
        if (checkedDeal) putDeal(checkedDeal);
        if (checkedReceipt.action === 'enroll_test_participant') await readBinding(op);
        if (active(op)) tell(value.historical ? 'Получена сохранённая личная TEST-квитанция. Новая подпись и новое заявление не создавались.'
          : checkedReceipt.action === 'enroll_test_participant' ? 'Личная TEST-привязка сохранена. Реальный вход, организация и деловые полномочия этим не подтверждены.'
          : checkedReceipt.action === 'anchor_test_memo' ? 'Личное TEST-намерение для memo подтверждено. Квитанция подписи сама по себе не подтверждает публикацию в devnet.'
          : 'Личное TEST-заявление сохранено после проверки точных байтов, сертификата и TEST-OCSP. Это не юридический договор и не платёж.'); break;
      }
      case 'logout':
        if (value?.closed !== true) throw fail('invalid_response');
        pending = null; tell('TEST-сессия закрыта. Данные и коды очищены. Сохранённые записи сервера не отменены.'); break;
      default: throw fail('invalid_response');
    }
  }
  async function sendPinned(pinned) {
    busy = true; const op = ++generation; emit();
    try {
      const value = await request(pinned.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DalaHold-CSRF': pinned.csrfToken }, body: pinned.body });
      if (active(op)) await applySuccess(pinned, value, op);
    } catch (error) {
      if (!active(op)) return;
      // A valid success followed by a failed read must not replay the confirmed write.
      if (pending !== pinned) {
        if (sessionError(error)) clearLocal('Запись подтверждена, но сервер завершил TEST-сессию при чтении данных. Окно и коды очищены; перезагрузите страницу для входа.');
        else report(error);
        return;
      }
      if (error.ambiguous || error.code === 'invalid_response') {
        pending.ambiguous = true;
        const notes = {
          register: ERRORS.registration_recovery_required,
          invite: 'Результат выпуска приглашения неизвестен. Повторный выпуск выдаст новый код и отменит предыдущий. Новые записи пока заблокированы.',
          login: 'Результат TEST-входа неизвестен. Повтор использует тот же код; после смены серверной сессии может потребоваться перезагрузка и новый вход.',
          claim: 'Результат принятия приглашения неизвестен. Повтор использует тот же код и может вернуть прежнее сохранённое членство.',
          logout: 'Окно очищено, сервер пока не подтвердил выход. Можно повторить прежний запрос закрытия.',
        };
        tell(notes[pinned.kind] || 'Ответ на запись не подтверждён. Операция могла сохраниться. Новые записи заблокированы; повтор отправит тот же точный запрос и прежний ID. Не создавайте замену.', true);
      } else if (sessionError(error)) {
        clearLocal('Сервер не подтвердил TEST-сессию. Данные и коды очищены. Прежний запрос мог сохраниться; перезагрузите страницу и войдите своим кодом.');
      } else {
        pending = null;
        if (error.status === 409 && pinned.dealId && session?.authenticated) {
          try { await detail(op, pinned.dealId); } catch (readError) {
            if (active(op) && sessionError(readError)) clearLocal('Сервер завершил TEST-сессию при обновлении данных. Данные, коды и намерение очищены. Перезагрузите страницу для входа.');
            else if (active(op)) report(readError);
          }
        }
        if (active(op)) report(error);
      }
    } finally { if (active(op)) { busy = false; emit(); } }
  }
  function write(kind, path, payload, dealId, authenticated = true, context) {
    requireSession(authenticated);
    if (scope === SIGNED_PARTICIPANT_SCOPE) clearPreparedSignature();
    pending = { kind, path, payload: clone(payload), body: JSON.stringify(payload), csrfToken: session.csrfToken, dealId, ambiguous: false,
      ...(context ? { signatureContext: clone(context) } : {}) };
    return sendPinned(pending);
  }
  const controller = {
    getState: state, report, tick: () => { expire(); emit(); },
    async bootstrap() {
      if (busy || pending || ended || disposed) throw fail('session_ended');
      busy = true; const op = ++generation; emit();
      try {
        const value = await request('/session'), next = validateSession(value);
        if (!active(op)) return;
        session = next; scope = next.scope;
        if (session.authenticated) await list(op);
        await loadSigning(op);
        if (active(op)) tell(session.authenticated ? 'Активная локальная TEST-сессия. Выберите свою сделку или создайте черновик.' : 'Локальная TEST-сессия готова. Войдите своим кодом или создайте TEST-участника.');
      } catch (error) { if (active(op)) report(error); }
      finally { if (active(op)) { busy = false; emit(); } }
    },
    register() { return write('register', '/participants', {}, undefined, false); },
    login(accessCode) {
      if (!token(accessCode)) throw fail('unauthorized');
      return write('login', '/session/login', { accessCode }, undefined, false);
    },
    refreshList() { return read(op => list(op), 'Список ваших TEST-сделок обновлён.'); },
    loadDeal(id) {
      if (!uuid(id)) throw fail('invalid_request');
      onSecret(null);
      return read(op => detail(op, id), 'Загружены актуальные условия выбранной TEST-сделки.');
    },
    createDeal(value) { return write('create', '/deals', buildCreateDeal(value, randomUUID())); },
    reviseDeal(value) {
      requireSession(); const pinned = deal;
      return write('version', `/deals/${pinned?.id}/versions`, buildVersion(pinned, value, randomUUID()), pinned.id);
    },
    inviteParticipant(participantId) {
      requireSession();
      if (!uuid(participantId) || participantId === session.participant.id) throw fail('invalid_participant');
      if (!deal || deal.state !== 'draft' || deal.creatorId !== session.participant.id || deal.participants.length !== 1) throw fail('forbidden');
      return write('invite', `/deals/${deal.id}/invitations`, { expectedVersion: deal.version, participantId }, deal.id);
    },
    claimInvitation(code) {
      if (!token(code)) throw fail('invalid_request');
      onSecret(null);
      return write('claim', '/invitations/claims', { code });
    },
    async uploadDocument(file, category, consent) {
      requireSession();
      if (!deal || deal.state !== 'draft' || !CATEGORIES.includes(category)) throw fail('forbidden');
      const pinnedDeal = deal, op = generation;
      const { contentBase64 } = await readParticipantDocument(file, consent);
      if (!active(op) || deal?.snapshotHash !== pinnedDeal.snapshotHash) throw fail('session_ended');
      return write('document', `/deals/${pinnedDeal.id}/documents`,
        { requestId: randomUUID(), expectedVersion: pinnedDeal.version, category, contentBase64 }, pinnedDeal.id);
    },
    statement(action, consent) {
      requireSession(); const pinned = deal;
      if (scope === SIGNED_PARTICIPANT_SCOPE) throw fail('signature_required');
      return write('event', `/deals/${pinned?.id}/events`, buildStatement(pinned, action, randomUUID(), consent), pinned.id);
    },
    refreshSigning() {
      if (scope !== SIGNED_PARTICIPANT_SCOPE) throw fail('forbidden');
      return read(op => loadSigning(op), 'Личный TEST-статус и привязка обновлены. Статус конкретного сертификата проверяется при получении подписи.');
    },
    prepareSignature(action) {
      requireSession();
      if (scope !== SIGNED_PARTICIPANT_SCOPE || !signingModule || !signingReady?.ready || signingReady.validUntil <= now()) throw fail('signing_unavailable');
      let payload = {}, path = '/identity-intents', pinnedDeal = null;
      if (action !== 'enroll_test_participant') {
        if (!binding) throw fail('binding_required');
        pinnedDeal = deal;
        if (action === 'anchor_test_memo') {
          if (!signingReady.anchorEnabled) throw fail('anchor_unavailable');
          if (!deal || deal.state !== 'accepted') throw fail('forbidden');
          payload = { expectedVersion: deal.version, expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash };
          path = `/deals/${deal.id}/anchor-intents`;
        } else {
          payload = buildStatement(deal, action, randomUUID(), true);
          path = `/deals/${deal.id}/signature-intents`;
        }
      }
      const context = { actorId: session.participant.id, action, binding: binding ? clone(binding) : null,
        deal: pinnedDeal ? clone(pinnedDeal) : null, request: Object.hasOwn(ACTION_LABELS, action) ? clone(payload) : null };
      return write('signature-intent', path, payload, pinnedDeal?.id, true, context);
    },
    async signPrepared(consent) {
      requireSession();
      if (consent !== true) throw fail('signature_consent_required');
      if (!signatureIntent || !signatureContext || !sameSignatureContext(signatureContext)) throw fail('invalid_signature_intent');
      if (signatureIntent.expiresAt <= now()) throw fail('intent_expired');
      if (!signingReady?.ready || signingReady.validUntil <= now()) throw fail('signing_unavailable');
      const intent = signatureIntent, context = signatureContext, csrfToken = session.csrfToken;
      busy = true; const op = ++generation; emit();
      try {
        await signingModule.validateIntent(intent, context, now(), cryptoImpl);
        if (!active(op)) return;
        if (!sameSignatureContext(context)) throw fail('invalid_signature_intent');
        const cms = await signingModule.signIntent(intent, signingReady.chain, { ...signingOptions, assertCurrent() {
          if (!active(op)) throw fail('session_ended');
          if (!sameSignatureContext(context) || signatureIntent !== intent) throw fail('invalid_signature_intent');
          if (intent.expiresAt <= now()) throw fail('intent_expired');
          if (!signingReady?.ready || signingReady.validUntil <= now()) throw fail('signing_unavailable');
        } });
        if (!active(op)) return;
        if (!sameSignatureContext(context) || signatureIntent !== intent) throw fail('invalid_signature_intent');
        if (intent.expiresAt <= now()) throw fail('intent_expired');
        const payload = { intentId: intent.id, cms };
        pending = { kind: 'signature', path: '/signature-receipts', payload, body: JSON.stringify(payload), csrfToken,
          dealId: context.deal?.id, ambiguous: false };
        busy = false;
        await sendPinned(pending);
      } catch (error) { if (active(op)) report(error); }
      finally { if (active(op)) { busy = false; emit(); } }
    },
    clearSignatureIntent() { requireSession(); clearPreparedSignature(); tell('Неподписанное TEST-намерение очищено из окна.'); },
    retry() {
      if (!pending || busy || disposed) throw fail('pending_write');
      if (pending.kind === 'register') throw fail('registration_recovery_required');
      if (pending.kind !== 'logout') requireSession(false, true);
      return sendPinned(pending);
    },
    logout(acknowledgePending = false) {
      expire();
      if (busy || !session || disposed) throw fail('session_required');
      if (pending && acknowledgePending !== true) throw fail('logout_ack_required');
      const csrfToken = session.csrfToken;
      clearLocal('Локальные данные и коды очищены. Ожидаем подтверждение закрытия TEST-сессии; выход не отменяет сохранённые операции.');
      pending = { kind: 'logout', path: '/session/logout', payload: {}, body: '{}', csrfToken, ambiguous: false };
      return sendPinned(pending);
    },
    exportDeal() { requireSession(); if (!deal) throw fail('invalid_request'); return exportParticipantDeal(deal); },
    dispose() { ++generation; session = deal = pending = null; signingReady = binding = signatureIntent = signatureContext = signatureReceipt = null; deals = []; disposed = true; onSecret(null); },
  };
  return controller;
}

export function mountParticipantCabinet(document, { fetchImpl = globalThis.fetch, now = Date.now,
  randomUUID, setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval,
  locationImpl = globalThis.location, BlobImpl = globalThis.Blob, URLImpl = globalThis.URL,
  cryptoImpl = globalThis.crypto, signingModuleLoader, signingOptions } = {}) {
  const $ = name => document.getElementById(`pp-${name}`);
  if (!$('app')) return null;
  const listeners = [], urls = new Set();
  let current, controller, newMode = true, lastDealId = null, detailKey = '', listKey = '', actionKey = '', signatureKey = '', listButtons = [];
  const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  const listen = (node, event, callback) => { node.addEventListener(event, callback); listeners.push(() => node.removeEventListener(event, callback)); };
  const safe = callback => async event => { event?.preventDefault(); try { await callback(event); } catch (error) { controller.report(error); } };
  function clearSecret(kind) {
    const input = $(kind === 'access' ? 'new-access-code' : 'new-invite-code');
    input.value = ''; input.type = 'password'; $(kind === 'access' ? 'access-secret' : 'invite-secret').hidden = true;
    const reveal = $(kind === 'access' ? 'reveal-access' : 'reveal-invite');
    reveal.setAttribute('aria-pressed', 'false'); reveal.textContent = kind === 'access' ? 'Показать код доступа' : 'Показать код приглашения';
    if (kind === 'invitation') $('invite-expiry').textContent = '';
  }
  function clearSecrets() {
    clearSecret('access'); clearSecret('invitation');
    for (const name of ['access-code', 'claim-code']) $(name).value = '';
  }
  function secret(value) {
    if (!value) { clearSecrets(); return; }
    const isAccess = value.kind === 'access', input = $(isAccess ? 'new-access-code' : 'new-invite-code');
    clearSecret(value.kind); input.value = value.value; $(isAccess ? 'access-secret' : 'invite-secret').hidden = false;
    if (!isAccess) $('invite-expiry').textContent = `Действует до ${new Date(value.expiresAt).toLocaleString('ru-RU')}.`;
    input.focus();
  }
  const termsFromForm = prefix => ({ scenario: $(`${prefix}-scenario`).value, quantity: Number($(`${prefix}-quantity`).value),
    amount: Number($(`${prefix}-amount`).value), date: $(`${prefix}-date`).value });
  const emptyList = (node, text) => { const li = element('li', text); li.className = 'empty'; node.append(li); };
  function renderDocuments(node, documents, dealId) {
    node.replaceChildren();
    for (const item of documents) {
      const li = element('li'), title = element('strong', CATEGORY_LABELS[item.category]), meta = element('p', `Версия ${item.termsVersion} · ${item.byteLength} байт · ${new Date(item.createdAt).toLocaleString('ru-RU')}`);
      const digest = element('code', `SHA-256 ${item.sha256}`); digest.className = 'identifier';
      const link = element('a', 'Скачать приватный TEST-текст .txt'); link.href = `${PARTICIPANT_API}/deals/${dealId}/documents/${item.id}`;
      link.setAttribute('download', 'TEST-document.txt'); li.append(title, meta, digest, link); node.append(li);
    }
    if (!documents.length) emptyList(node, 'TEST-документов этой версии пока нет.');
  }
  function renderDetail(value) {
    const signed = value.scope === SIGNED_PARTICIPANT_SCOPE, labels = signed ? SIGNED_ACTION_LABELS : ACTION_LABELS;
    $('detail-heading').textContent = `${value.scenario === 'grain' ? 'Зерно' : 'Животноводство'} / TEST-сделка`;
    $('role').textContent = `Моя роль здесь: ${ROLE_LABELS[value.role]}`;
    $('state').textContent = STATE_LABELS[value.state]; $('deal-id').textContent = value.id;
    $('version').textContent = `Версия ${value.version} · ревизия состояния ${value.stateRevision}`;
    $('fingerprint').textContent = value.termsFingerprint; $('snapshot-hash').textContent = value.snapshotHash;
    $('terms').replaceChildren();
    for (const [label, text] of [['Сценарий', value.scenario === 'grain' ? 'Зерно' : 'Животноводство'], ['Количество', value.quantity.toLocaleString('ru-RU')], ['Сумма в TEST-условиях', `${value.amount.toLocaleString('ru-RU')} KZT`], ['Дата условий', value.date]]) {
      const group = element('div'); group.append(element('dt', label), element('dd', text)); $('terms').append(group);
    }
    for (const name of ['scenario', 'quantity', 'amount', 'date']) $(`edit-${name}`).value = String(value[name]);
    $('members').replaceChildren();
    for (const role of ROLES) {
      const member = value.participants.find(item => item.role === role), li = element('li');
      li.append(element('strong', ROLE_LABELS[role]));
      if (member) { li.append(element('p', `${member.label}${member.id === current.participant?.id ? ' · это мой TEST-участник' : ''}`)); const code = element('code', member.id); code.className = 'identifier'; li.append(code); }
      else li.append(element('p', 'Роль свободна. Нужен отдельный TEST-участник.'));
      $('members').append(li);
    }
    renderDocuments($('documents'), value.documents, value.id);
    $('document-count').textContent = `${value.documents.length} / 10`;
    const archived = (value.documentHistory || []).filter(item => item.termsVersion !== value.version);
    $('document-history').hidden = !archived.length; renderDocuments($('archived-documents'), archived, value.id);
    $('events').replaceChildren();
    for (const event of value.events) {
      const li = element('li'); li.append(element('h3', labels[event.action]));
      li.append(element('p', `${ROLE_LABELS[event.role]} · версия ${event.termsVersion} · ${new Date(event.createdAt).toLocaleString('ru-RU')}`));
      li.append(element('p', `${STATE_LABELS[event.stateFrom]} → ${STATE_LABELS[event.stateTo]} · ${signed ? 'личная TEST-подпись' : 'неподписанное TEST-заявление'}`));
      const detail = element('details'), summary = element('summary', 'Точная локальная запись и источник'); detail.append(summary, element('pre', canonical(event))); li.append(detail); $('events').append(li);
    }
    if (!value.events.length) emptyList($('events'), signed ? 'Личных TEST-заявлений пока нет.' : 'Неподписанных TEST-заявлений пока нет.');
    $('statement-consent').checked = false; $('document-consent').checked = false; $('file').value = '';
    $('invite-id').value = '';
  }
  function render(state) {
    current = state;
    const signed = state.scope === SIGNED_PARTICIPANT_SCOPE;
    if (signed) {
      $('mode-label').textContent = 'Кабинет участника / личные TEST-подписи';
      $('scope-note').textContent = 'Только локальная модель личных TEST-сертификатов. Код доступа открывает локального TEST-участника, а личная TEST-подпись фиксирует точные байты намерения. Реальный вход, организация, деловые полномочия, юридический договор и платёж не подтверждаются. Не вводите реальные имена, ИИН, БИН и конфиденциальные документы.';
      $('source-line').textContent = 'Источник: локальный сервер DalaHold · личные TEST-сертификаты · TEST-OCSP';
      $('declaration-heading').textContent = 'Намерение личного TEST-заявления';
      $('journal-note').textContent = 'Личные TEST-квитанции подтверждают только локальную последовательность и точные байты. Экспорт содержит загруженную сделку и разрешённые метаданные подписи, без CMS, личных данных, кодов или сессии. Деловые полномочия, юридический договор и платёж не подтверждены.';
      $('footer-note').textContent = `DalaHold / isolated personal TEST signatures / ${state.scope}`;
    }
    $('signing').hidden = !signed || !state.authenticated || state.ended;
    $('statement-consent-row').hidden = signed;
    $('statement-consent').required = !signed;
    if ((state.deal?.id || null) !== lastDealId) { clearSecrets(); newMode = !state.deal; lastDealId = state.deal?.id || null; }
    $('app').setAttribute('aria-busy', String(state.busy));
    $('status').textContent = state.message; $('status').classList.toggle('error', state.issue);
    $('auth').hidden = state.authenticated || state.ended;
    $('ended').hidden = !state.ended;
    $('navigation').hidden = !state.authenticated; $('claim-form').hidden = !state.authenticated;
    $('participant-label').textContent = state.participant?.label || (state.ended ? 'Активного TEST-доступа нет.' : 'Вход по локальному TEST-коду');
    $('participant-id-block').hidden = !state.participant; $('participant-id').textContent = state.participant?.id || '';
    $('expiry').textContent = state.expiresAt ? `Сессия до ${new Date(state.expiresAt).toLocaleTimeString('ru-RU')} · осталось ${Math.max(0, Math.ceil((state.expiresAt - now()) / 60000))} мин.` : 'Для нового входа нужна перезагрузка страницы.';
    $('logout').hidden = !state.sessionReady;
    $('logout-warning').hidden = !state.pending || !state.sessionReady;
    $('pending').hidden = !state.pending?.ambiguous;
    const pendingNotes = {
      register: 'Сервер мог создать TEST-участника, а код доступа получить не удалось. Повтор создания заблокирован. Закройте сессию или перезагрузите страницу; потерянный код не восстанавливается.',
      invite: 'Сервер мог выпустить приглашение. Повторный выпуск создаст новый код и отменит прежний. Адресат и версия запроса сохранятся.',
      login: 'Сервер мог открыть новую сессию. Повтор использует тот же код доступа; если прежняя CSRF-сессия уже заменена, потребуется перезагрузка.',
      claim: 'Приглашение могло быть принято. Повтор использует тот же код и подтверждает уже сохранённое членство, если оно существует.',
      logout: 'Окно очищено, сервер пока не подтвердил выход. Повтор отправит только прежний запрос закрытия. Новые записи заблокированы.',
      signature: 'TEST-подпись могла сохраниться на сервере. Повтор отправит прежний CMS и ID намерения с тем же CSRF, не открывая приложение подписи. Не подписывайте замену.',
      'signature-intent': 'Сервер мог подготовить TEST-намерение. Повтор отправит прежние точные данные; приложение подписи ещё не открывалось.',
    };
    $('pending-note').textContent = pendingNotes[state.pending?.kind] || 'Операция могла сохраниться на сервере. Новые записи заблокированы. Повтор отправит прежний точный запрос с тем же ID, без нового заявления.';
    const retryLabels = { invite: 'Повторно выпустить приглашение', login: 'Повторить TEST-вход', claim: 'Повторить принятие приглашения', logout: 'Повторить закрытие TEST-сессии', signature: 'Повторить прежний CMS (без новой подписи)' };
    $('retry').textContent = retryLabels[state.pending?.kind] || 'Повторить точный запрос';
    $('retry').hidden = state.pending?.kind === 'register';
    $('pending-reload').hidden = state.pending?.kind !== 'register';
    const blocked = state.busy || Boolean(state.pending) || state.ended, anonymousBlocked = blocked || !state.sessionReady;
    for (const name of ['login', 'register', 'access-code']) $(name).disabled = anonymousBlocked;
    for (const name of ['new', 'create-submit', 'create-role', 'create-scenario', 'create-quantity', 'create-amount', 'create-date',
      'claim', 'claim-code', 'edit-submit', 'edit-scenario', 'edit-quantity', 'edit-amount', 'edit-date', 'invite', 'invite-id', 'category', 'document-consent', 'action', 'statement-consent']) $(name).disabled = blocked || !state.authenticated;
    $('logout').disabled = state.busy || (Boolean(state.pending) && !$('logout-ack').checked);
    $('retry').disabled = state.busy || !state.pending?.ambiguous;
    for (const name of ['refresh-list', 'refresh-detail']) $(name).disabled = state.busy || state.ended || !state.authenticated;
    $('file').disabled = blocked || !state.authenticated || !$('document-consent').checked;
    $('upload').disabled = blocked || !state.authenticated || !$('document-consent').checked || !$('file').files?.length;
    $('statement').disabled = blocked || !state.authenticated || (signed ? !state.signing?.ready || !state.signing.binding : !$('statement-consent').checked);
    $('export').disabled = blocked || !state.deal || !state.authenticated;
    $('enroll').disabled = blocked || !signed || !state.authenticated || !state.signing?.ready || Boolean(state.signing.binding);
    $('refresh-signing').disabled = state.busy || !signed || !state.authenticated || state.ended;
    $('signing-status').textContent = signed && state.authenticated ? state.signing?.ready
      ? 'TEST-цепочка готова. Статус выбранного сертификата будет проверен через TEST-OCSP после получения подписи.'
      : 'TEST-подписание закрыто: готовность цепочки и источника статуса не подтверждена.' : '';
    const identity = state.signing?.binding;
    $('binding-text').textContent = signed && state.authenticated ? identity ? 'Личная TEST-привязка сохранена. Эпоха привязки: 0. Это не подтверждённый реальный аккаунт и не полномочия организации.' : 'Личный TEST-сертификат ещё не привязан к этому локальному участнику.' : '';
    $('binding-metadata').hidden = !identity;
    $('binding-id').textContent = identity?.bindingId || ''; $('binding-digest').textContent = identity?.certificateDigest || '';
    const intent = state.signing?.intent;
    if (signatureKey !== (intent?.id || '')) { signatureKey = intent?.id || ''; $('signature-consent').checked = false; }
    if (state.busy || blocked || !state.signing?.intentFresh) $('signature-consent').checked = false;
    $('signature-preview').hidden = !signed || !intent;
    $('intent-bytes').textContent = intent?.text || ''; $('intent-hash').textContent = intent?.hash || '';
    $('intent-expiry').textContent = intent ? state.signing.intentFresh ? `TEST-намерение действует до ${new Date(intent.expiresAt).toLocaleTimeString('ru-RU')}.` : 'TEST-намерение истекло; новая подпись закрыта. Точный повтор уже отправленного CMS доступен через предупреждение.' : '';
    $('signature-consent').disabled = blocked || !intent || !state.signing?.intentFresh;
    $('signature-submit').disabled = blocked || !intent || !state.signing?.intentFresh || !state.signing?.ready || !$('signature-consent').checked;
    $('clear-intent').disabled = blocked || !intent;
    $('signature-receipt').hidden = !state.signing?.receipt;
    $('receipt-metadata').textContent = state.signing?.receipt ? canonical(state.signing.receipt) : '';
    $('anchor-panel').hidden = !signed || state.deal?.state !== 'accepted';
    $('anchor').disabled = blocked || !state.signing?.ready || !state.signing?.binding || !state.signing?.anchorEnabled;
    $('anchor-help').textContent = state.signing?.anchorEnabled
      ? 'Отдельное намерение разрешает только показанные точные байты TEST-memo для настроенного кошелька devnet. Платёж реальных средств и юридический договор не разрешаются.'
      : 'Администратор не настроил отдельный кошелёк для TEST-memo в Solana devnet. Публикация недоступна; реальный платёж и юридический договор не разрешаются.';
    const nextListKey = canonical(state.deals.map(item => select(item, ['id', 'scenario', 'version', 'state', 'role', 'date'])));
    if (listKey !== nextListKey) {
      listKey = nextListKey; listButtons = []; $('deals').replaceChildren();
      for (const item of state.deals) {
        const li = element('li'), button = element('button'); button.type = 'button';
        button.append(element('strong', `${item.scenario === 'grain' ? 'Зерно' : 'Животноводство'} · ${item.id.slice(0, 8)}`));
        button.append(element('span', `${ROLE_LABELS[item.role]} · ${STATE_LABELS[item.state]} · v${item.version}`));
        button.addEventListener('click', safe(async () => { newMode = false; clearSecrets(); await controller.loadDeal(item.id); $('detail-heading').focus(); }));
        listButtons.push({ button, id: item.id }); li.append(button); $('deals').append(li);
      }
      if (!state.deals.length) emptyList($('deals'), 'У вас пока нет TEST-сделок.');
    }
    for (const item of listButtons) { item.button.disabled = state.busy || Boolean(state.pending) || state.ended; item.button.setAttribute('aria-current', String(!newMode && item.id === state.deal?.id)); }
    $('create').hidden = !state.authenticated || !newMode;
    $('detail').hidden = !state.authenticated || newMode || !state.deal;
    if (!state.deal) { detailKey = actionKey = ''; $('terms').replaceChildren(); $('members').replaceChildren(); $('documents').replaceChildren(); $('archived-documents').replaceChildren(); $('events').replaceChildren(); $('action').replaceChildren(); $('declaration').textContent = ''; $('detail-heading').textContent = 'TEST-сделка'; for (const name of ['deal-id', 'fingerprint', 'snapshot-hash', 'version', 'role', 'state', 'document-count']) $(name).textContent = ''; }
    if (state.deal) {
      const value = state.deal, key = `${value.id}:${value.version}:${value.stateRevision}:${value.snapshotHash}`;
      if (key !== detailKey) { detailKey = key; renderDetail(value); }
      const editable = value.state === 'draft';
      $('edit-form').hidden = !editable || value.role !== 'seller'; $('immutable-note').hidden = editable;
      $('invite-form').hidden = !editable || value.creatorId !== state.participant?.id || value.participants.length !== 1;
      $('document-form').hidden = !editable;
      const actions = availableActions(value); $('action-form').hidden = !actions.length;
      $('action-note').textContent = actions.length ? 'Роль и доступные переходы определены сервером для этой сделки.'
        : editable ? 'Для TEST-предложения нужны два отдельных участника. Предложение заявляет продавец.'
        : ['accepted', 'disputed'].includes(value.state) ? 'TEST-состояние завершено. Новые заявления недоступны.' : 'Следующее заявление ожидается от другой роли.';
      if (key !== actionKey) { actionKey = key; $('action').replaceChildren(); for (const action of actions) { const option = element('option', (signed ? SIGNED_ACTION_LABELS : ACTION_LABELS)[action]); option.value = action; $('action').append(option); } $('action').value = actions[0] || ''; $('statement-consent').checked = false; }
      $('declaration').textContent = actions.length ? statementPreview(value, $('action').value) : '';
      $('statement').textContent = signed ? 'Подготовить точное личное TEST-намерение' : ACTION_LABELS[$('action').value] || 'Записать TEST-заявление (без ЭЦП)';
      // Rendering a changed snapshot clears consent before enabling its action.
      if (!signed) $('statement').disabled ||= !$('statement-consent').checked;
      $('file').disabled ||= !$('document-consent').checked;
      $('upload').disabled ||= !$('document-consent').checked || !$('file').files?.length;
    }
    if (state.ended) { for (const name of ['create-quantity', 'create-amount', 'create-date', 'edit-quantity', 'edit-amount', 'edit-date', 'invite-id']) $(name).value = ''; $('file').value = ''; $('document-consent').checked = $('statement-consent').checked = false; }
  }
  controller = createParticipantController({ fetchImpl, now, cryptoImpl, ...(randomUUID ? { randomUUID } : {}),
    ...(signingModuleLoader ? { signingModuleLoader } : {}), ...(signingOptions ? { signingOptions } : {}), onChange: render, onSecret: secret });
  listen($('register'), 'click', safe(() => controller.register()));
  listen($('login-form'), 'submit', safe(() => { const value = $('access-code').value; $('access-code').value = ''; return controller.login(value); }));
  listen($('logout'), 'click', safe(() => controller.logout($('logout-ack').checked)));
  listen($('logout-ack'), 'change', () => render(controller.getState()));
  listen($('retry'), 'click', safe(() => controller.retry()));
  listen($('reload'), 'click', () => { clearSecrets(); locationImpl.reload(); });
  listen($('pending-reload'), 'click', () => { controller.dispose(); clearSecrets(); locationImpl.reload(); });
  listen($('refresh-list'), 'click', safe(() => controller.refreshList()));
  listen($('refresh-detail'), 'click', safe(() => controller.loadDeal(current.deal.id)));
  listen($('new'), 'click', () => { newMode = true; clearSecrets(); if (current.signing?.intent) controller.clearSignatureIntent(); render(controller.getState()); $('create-heading').focus(); });
  listen($('create-form'), 'submit', safe(() => controller.createDeal({ creatorRole: $('create-role').value, ...termsFromForm('create') })));
  listen($('edit-form'), 'submit', safe(() => controller.reviseDeal(termsFromForm('edit'))));
  listen($('invite-form'), 'submit', safe(() => controller.inviteParticipant($('invite-id').value)));
  listen($('claim-form'), 'submit', safe(() => { const value = $('claim-code').value; $('claim-code').value = ''; return controller.claimInvitation(value); }));
  listen($('document-consent'), 'change', () => { if (!$('document-consent').checked) $('file').value = ''; render(controller.getState()); });
  listen($('file'), 'change', () => render(controller.getState()));
  listen($('document-form'), 'submit', safe(async () => { const file = $('file').files?.[0]; await controller.uploadDocument(file, $('category').value, $('document-consent').checked); $('file').value = ''; $('document-consent').checked = false; render(controller.getState()); }));
  listen($('action'), 'change', () => { $('statement-consent').checked = false; if (current.signing?.intent) controller.clearSignatureIntent(); render(controller.getState()); });
  listen($('statement-consent'), 'change', () => render(controller.getState()));
  const prepareSignature = async action => { await controller.prepareSignature(action); if (controller.getState().signing?.intent) $('intent-heading').focus(); };
  listen($('action-form'), 'submit', safe(() => current.scope === SIGNED_PARTICIPANT_SCOPE ? prepareSignature($('action').value) : controller.statement($('action').value, $('statement-consent').checked)));
  listen($('enroll'), 'click', safe(() => prepareSignature('enroll_test_participant')));
  listen($('refresh-signing'), 'click', safe(() => controller.refreshSigning()));
  listen($('signature-consent'), 'change', () => render(controller.getState()));
  listen($('signature-form'), 'submit', safe(() => controller.signPrepared($('signature-consent').checked)));
  listen($('clear-intent'), 'click', safe(() => controller.clearSignatureIntent()));
  listen($('anchor'), 'click', safe(() => prepareSignature('anchor_test_memo')));
  for (const kind of ['access', 'invite']) {
    listen($(`hide-${kind}`), 'click', () => clearSecret(kind === 'access' ? 'access' : 'invitation'));
    listen($(`reveal-${kind}`), 'click', () => { const input = $(kind === 'access' ? 'new-access-code' : 'new-invite-code'), reveal = $(`reveal-${kind}`), show = input.type === 'password'; input.type = show ? 'text' : 'password'; reveal.setAttribute('aria-pressed', String(show)); reveal.textContent = `${show ? 'Скрыть' : 'Показать'} код ${kind === 'access' ? 'доступа' : 'приглашения'}`; });
  }
  listen($('export'), 'click', safe(() => {
    const text = controller.exportDeal(), url = URLImpl.createObjectURL(new BlobImpl([text], { type: 'application/json;charset=utf-8' }));
    urls.add(url); const link = element('a'); link.href = url; link.download = `DalaHold-TEST-${current.deal.id}.json`; document.body.append(link); link.click(); link.remove();
  }));
  const timer = setIntervalImpl(() => controller.tick(), 1000);
  const initialized = controller.bootstrap();
  return { initialized, controller, dispose() { clearIntervalImpl(timer); for (const remove of listeners) remove(); controller.dispose(); for (const url of urls) URLImpl.revokeObjectURL(url); urls.clear(); } };
}

if (typeof document !== 'undefined') mountParticipantCabinet(document);
