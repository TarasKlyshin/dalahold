import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mountPersonalPage, validatePersonalIntent } from './personal-client.mjs';

const html = readFileSync(new URL('./personal.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./personal.css', import.meta.url), 'utf8');
const client = readFileSync(new URL('./personal-client.mjs', import.meta.url), 'utf8');
const scope = 'test_personal_binding_only';
const initialTime = Date.UTC(2026, 8, 30, 12);
const intentId = '11111111-1111-4111-8111-111111111111';
const receiptId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
function intentFixture(time = initialTime, fields = {}) {
  const text = JSON.stringify({ domain: 'dalahold:test-person-binding:v1',
    purpose: 'ТЕСТОВАЯ ЛИЧНАЯ ПРИВЯЗКА. Вход, корпоративные полномочия, кошелёк и платёж не разрешаются.',
    action: 'enroll_test_person', nonce: intentId, sessionHash: '4'.repeat(64), mappingKeyId: '5'.repeat(64),
    issuedAt: time, expiresAt: time + 300_000, statusSource: 'test_ocsp', bindingId: null, expectedEpoch: null,
    previousCertificateDigest: null, newCertificateDigest: null, ...fields }, null, 2) + '\n';
  return { id: intentId, text, bytesBase64: Buffer.from(text).toString('base64'),
    hash: createHash('sha256').update(text).digest('hex'), expiresAt: time + 300_000 };
}
function statusFixture(time = initialTime) {
  return { enabled: true, ready: true, scope, statusSource: 'test_ocsp', validUntil: time + 900_000,
    chain: ['-----BEGIN CERTIFICATE-----A', '-----BEGIN CERTIFICATE-----B'],
    csrfToken: 'c'.repeat(43), sessionExpiresAt: time + 600_000 };
}
function receiptFixture(intent = intentFixture(), historical = false) {
  const data = JSON.parse(intent.text);
  return { receipt: { id: receiptId, intentHash: intent.hash, action: data.action, bindingId,
    epoch: data.expectedEpoch === null ? 0 : data.expectedEpoch + 1,
    certificateDigest: data.newCertificateDigest || '6'.repeat(64), verifiedAt: initialTime, validUntil: initialTime + 900_000,
    statusSource: 'test_ocsp', scope }, historical };
}
function response(value, status = 200, retryAfter = null) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => structuredClone(value), headers: { get: name => name === 'Retry-After' ? retryAfter : null } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// This small DOM surface uses IDs/attributes from the served HTML, so missing
// or mismatched controls fail the controller tests without a runtime dependency.
function documentFixture() {
  const elements = new Map();
  const document = { activeElement: null, getElementById: id => elements.get(id) || null };
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attributes = new Map();
    for (const attr of match[2].matchAll(/([a-z][\w-]*)(?:="([^"]*)")?/gi)) attributes.set(attr[1], attr[2] ?? '');
    const id = attributes.get('id');
    if (!id) continue;
    assert.equal(elements.has(id), false, `duplicate HTML ID: ${id}`);
    const classes = new Set((attributes.get('class') || '').split(/\s+/));
    const listeners = new Map();
    const element = { tagName: match[1].toUpperCase(), attributes, textContent: '',
      disabled: attributes.has('disabled'), hidden: attributes.has('hidden'), value: attributes.get('value') || '',
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains: name => classes.has(name) },
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
      focus() { document.activeElement = element; },
      click() { if (!this.disabled) return listeners.get('click')?.(); },
      dispatch(name) { if (!this.disabled) return listeners.get(name)?.(); },
    };
    elements.set(id, element);
    if (element.tagName === 'SELECT') {
      const block = html.slice(match.index).split('</select>')[0];
      element.value = /<option value="([^"]+)"/.exec(block)?.[1] || '';
    }
  }
  return document;
}
async function harness({ route, signer } = {}) {
  const document = documentFixture();
  const requests = [];
  let time = initialTime, tick;
  const fixture = intentFixture();
  const fetchImpl = async (path, options) => {
    requests.push({ path, options });
    const override = route?.(path, options, requests);
    if (override !== undefined) return await override;
    if (path.endsWith('/status')) return response(statusFixture());
    if (path.endsWith('/intents')) return response({ intent: fixture }, 201);
    if (path.endsWith('/receipts')) return response(receiptFixture(fixture));
    if (path.endsWith('/session/close')) return response({ closed: true, scope });
    throw new Error('unexpected API route');
  };
  const mounted = mountPersonalPage(document, { fetchImpl, ncalayer: signer || (async request => request ? 'Y21z' : true),
    now: () => time, cryptoImpl: webcrypto,
    setIntervalImpl(fn) { tick = fn; return 1; }, clearIntervalImpl() { tick = null; } });
  await mounted.initialized;
  const $ = name => document.getElementById(`personal-${name}`);
  return { document, $, requests, fixture, mounted,
    click: name => $(name).click(),
    advance(ms, update = true) { time += ms; if (update) tick?.(); },
  };
}

test('served personal HTML has semantic, labelled controls and independent workspace', () => {
  const document = documentFixture();
  assert.match(html, /<html lang="ru">/);
  assert.equal(document.getElementById('workspace'), null);
  assert.equal(document.getElementById('personal-workspace').tagName, 'MAIN');
  assert.equal(document.getElementById('personal-result').getAttribute('role'), 'status');
  assert.equal(document.getElementById('personal-result').getAttribute('aria-live'), 'polite');
  assert.equal(document.getElementById('personal-result').getAttribute('aria-atomic'), 'true');
  for (const id of html.matchAll(/\bid="([^"]+)"/g)) assert.match(id[1], /^personal-/);
  for (const heading of html.matchAll(/aria-labelledby="([^"]+)"/g)) {
    const element = document.getElementById(heading[1]);
    assert.ok(element, `missing section heading ${heading[1]}`);
    assert.equal(element.tagName, 'H2');
  }
  for (const name of ['create', 'sign', 'retry', 'connect', 'refresh', 'close']) {
    assert.equal(document.getElementById(`personal-${name}`).tagName, 'BUTTON');
    assert.match(html, new RegExp(`<button[^>]*id="personal-${name}"[^>]*type="button"[^>]*>[^<]+</button>`));
  }
  assert.match(html, /href="\/"/);
  assert.match(html, /href="\/personal\/"/);
  assert.match(html, /Пароль вводится только в окне NCALayer/);
  assert.match(html, /Физическое лицо/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /personal-skip:focus/);
  for (const name of ['action','binding-id','new-certificate']) {
    assert.match(html, new RegExp(`<label[^>]*for="personal-${name}"`));
    assert.equal(document.getElementById(`personal-${name}`).getAttribute('autocomplete'), 'off');
  }
  assert.doesNotMatch(html, /type="(?:file|password)"|download=|export|ИИН:\s*</);
  assert.doesNotMatch(client, /console\.|localStorage|sessionStorage|indexedDB|createObjectURL/);
});

test('intent text, canonical base64, digest and permitted enrollment fields must agree', async () => {
  const valid = intentFixture();
  assert.equal(await validatePersonalIntent(valid, initialTime, webcrypto), valid);
  for (const changed of [ { ...valid, text: valid.text + ' ' }, { ...valid, hash: 'f'.repeat(64) },
    { ...valid, bytesBase64: valid.bytesBase64 + '\n' }, { ...valid, expiresAt: initialTime },
    { ...valid, id: receiptId }, { ...valid, bytesBase64: 'AB==' } ]) {
    await assert.rejects(validatePersonalIntent(changed, initialTime, webcrypto), /invalid_personal_response/);
  }
  const corporate = valid.text.replace('enroll_test_person', 'replace_test_certificate');
  await assert.rejects(validatePersonalIntent({ ...valid, text: corporate,
    bytesBase64: Buffer.from(corporate).toString('base64'), hash: createHash('sha256').update(corporate).digest('hex') },
  initialTime, webcrypto), /invalid_personal_response/);
  const extraSubject = JSON.stringify({ ...JSON.parse(valid.text), iin: '000000000000' });
  await assert.rejects(validatePersonalIntent({ ...valid, text: extraSubject,
    bytesBase64: Buffer.from(extraSubject).toString('base64'), hash: createHash('sha256').update(extraSubject).digest('hex') },
  initialTime, webcrypto), /invalid_personal_response/);
});

const replacementRequest = { action: 'replace_test_certificate', bindingId, newCertificateDigest: '7'.repeat(64) };
const replacementFixture = fields => intentFixture(initialTime, { ...replacementRequest,
  expectedEpoch: 0, previousCertificateDigest: '6'.repeat(64), ...fields });
function chooseReplacement(h, request = replacementRequest) {
  h.$('action').value = request.action; h.$('action').dispatch('change');
  h.$('binding-id').value = request.bindingId; h.$('binding-id').dispatch('input');
  h.$('new-certificate').value = request.newCertificateDigest; h.$('new-certificate').dispatch('input');
}

test('replacement validation binds requested action, ID, new digest and canonical exact bytes', async () => {
  const valid = replacementFixture();
  assert.equal(await validatePersonalIntent(valid, initialTime, webcrypto, replacementRequest), valid);
  await assert.rejects(validatePersonalIntent(valid, initialTime, webcrypto), /invalid_personal_response/);
  for (const data of [{ bindingId: receiptId }, { newCertificateDigest: '8'.repeat(64) },
    { previousCertificateDigest: '7'.repeat(64) }, { expectedEpoch: -1 }, { expectedEpoch: Number.MAX_SAFE_INTEGER }])
    await assert.rejects(validatePersonalIntent(replacementFixture(data), initialTime, webcrypto, replacementRequest), /invalid_personal_response/);
  const noncanonical = { ...valid, text: JSON.stringify(JSON.parse(valid.text)) };
  noncanonical.bytesBase64 = Buffer.from(noncanonical.text).toString('base64');
  noncanonical.hash = createHash('sha256').update(noncanonical.text).digest('hex');
  await assert.rejects(validatePersonalIntent(noncanonical, initialTime, webcrypto, replacementRequest), /invalid_personal_response/);
});

test('invalid replacement fields never issue an intent or open NCALayer', async () => {
  let signatures = 0;
  const h = await harness({ signer: async () => { signatures++; return 'Y21z'; } });
  chooseReplacement(h, { ...replacementRequest, bindingId: 'bad' });
  await h.click('create'); assert.match(h.$('result').textContent, /ID|отпечаток/);
  h.$('binding-id').value = bindingId; h.$('new-certificate').value = 'not-a-hash';
  await h.click('create');
  assert.equal(h.requests.filter(r => r.path.endsWith('/intents')).length, 0);
  assert.equal(h.$('sign').disabled, true); assert.equal(signatures, 0); h.mounted.dispose();
});

test('replacement UI sends only selected target fields and renders same ID, next epoch and historical retry', async () => {
  const issued = replacementFixture(); let signedRequest;
  const h = await harness({ route(path, options, requests) {
    if (path.endsWith('/intents')) return response({ intent: issued }, 201);
    if (path.endsWith('/receipts')) return response(receiptFixture(issued,
      requests.filter(r => r.path.endsWith('/receipts')).length > 1));
  }, signer: async request => { signedRequest = request; return 'Y21z'; } });
  chooseReplacement(h);
  await h.click('create');
  const request = h.requests.find(r => r.path.endsWith('/intents'));
  assert.deepEqual(JSON.parse(request.options.body), replacementRequest);
  assert.equal(h.$('replacement-fields').hidden, false);
  assert.match(h.$('intent-summary').textContent, /0.*1/);
  await h.click('sign'); assert.equal(signedRequest.args.data, issued.bytesBase64);
  assert.equal(h.$('receipt-binding').textContent, bindingId); assert.equal(h.$('receipt-epoch').textContent, '1');
  assert.match(h.$('receipt-action').textContent, /Замена/);
  assert.match(h.$('receipt-note').textContent, /Сертификат заменён/);
  await h.click('retry'); assert.match(h.$('receipt-kind').textContent, /Историческая/);
  assert.match(h.$('receipt-note').textContent, /актуальный статус.*не подтверждён/);
  await h.click('close');
  assert.equal(h.$('binding-id').value, ''); assert.equal(h.$('new-certificate').value, '');
  assert.equal(h.$('receipt').hidden, true); h.mounted.dispose();
});

test('server substitution of replacement target or enrollment action is refused before signing', async () => {
  for (const issued of [replacementFixture({ bindingId: receiptId }), replacementFixture({ newCertificateDigest: '8'.repeat(64) }), intentFixture()]) {
    let signatures = 0;
    const h = await harness({ route: path => path.endsWith('/intents') ? response({ intent: issued },201) : undefined,
      signer: async () => { signatures++; return 'Y21z'; } });
    chooseReplacement(h); await h.click('create'); await h.click('sign');
    assert.equal(h.$('intent').hidden, true); assert.equal(signatures, 0);
    assert.match(h.$('result').textContent, /не прошёл проверку/); h.mounted.dispose();
  }
});

test('replacement receipt must match action, binding ID, candidate digest and exact next epoch', async () => {
  const issued = replacementFixture();
  for (const altered of [{ action: 'enroll_test_person' }, { bindingId: receiptId },
    { certificateDigest: '6'.repeat(64) }, { epoch: 0 }, { epoch: 2 }]) {
    const result = receiptFixture(issued); Object.assign(result.receipt, altered);
    const h = await harness({ route: path => path.endsWith('/intents') ? response({ intent: issued },201) :
      path.endsWith('/receipts') ? response(result) : undefined });
    chooseReplacement(h); await h.click('create'); await h.click('sign');
    assert.equal(h.$('receipt').hidden, true); assert.match(h.$('result').textContent, /не прошёл проверку/);
    h.mounted.dispose();
  }
});

test('editing replacement fields or switching operation invalidates old intent and CMS before another signature', async () => {
  const issued = replacementFixture();
  const h = await harness({ route: path => path.endsWith('/intents') ? response({ intent: issued },201) : undefined });
  chooseReplacement(h); await h.click('create');
  h.$('new-certificate').value = '8'.repeat(64); h.$('new-certificate').dispatch('input');
  assert.equal(h.$('intent').hidden, true); assert.equal(h.$('sign').disabled, true);
  assert.equal(h.$('retry').disabled, true);
  h.$('action').value = 'enroll_test_person'; h.$('action').dispatch('change');
  assert.equal(h.$('replacement-fields').hidden, true); assert.equal(h.$('intent').hidden, true);
  h.mounted.dispose();
});

test('closing during replacement signing clears form and ignores late CMS without submitting it', async () => {
  const signing = deferred(), issued = replacementFixture();
  const h = await harness({ signer: () => signing.promise,
    route: path => path.endsWith('/intents') ? response({ intent: issued },201) : undefined });
  chooseReplacement(h); await h.click('create'); const pending = h.click('sign');
  assert.equal(h.$('action').disabled, true); assert.equal(h.$('binding-id').disabled, true);
  await h.click('close'); signing.resolve('Y21z'); await pending;
  assert.equal(h.$('binding-id').value, ''); assert.equal(h.$('new-certificate').value, '');
  assert.equal(h.requests.filter(r => r.path.endsWith('/receipts')).length, 0);
  assert.equal(h.$('intent').hidden, true); h.mounted.dispose();
});

test('ambiguous replacement response preserves EXACT CMS, blocks re-sign and allows only exact retry until explicit reset', async () => {
  const issued = replacementFixture(); let signatures = 0, submits = 0;
  const h = await harness({ signer: async () => { signatures++; return signatures === 1 ? 'Y21z' : 'YW5vdGhlcg=='; },
    route(path) {
      if(path.endsWith('/intents')) return response({ intent: issued },201);
      if(path.endsWith('/receipts')) {
        if(++submits===1) throw new Error('lost committed response');
        return response(receiptFixture(issued,true));
      }
    } });
  chooseReplacement(h); await h.click('create'); await h.click('sign');
  assert.equal(h.$('sign').disabled, true); assert.equal(h.$('retry').disabled, false);
  await h.click('sign'); assert.equal(signatures, 1);
  await h.click('retry'); assert.match(h.$('receipt-kind').textContent, /Историческая/);
  const payloads = h.requests.filter(r=>r.path.endsWith('/receipts')).map(r=>JSON.parse(r.options.body));
  assert.deepEqual(payloads[0],payloads[1]); h.mounted.dispose();
});

test('explicit pre-commit certificate rejection permits re-signing but a malformed response retains the original CMS', async () => {
  const issued = replacementFixture();
  for(const code of ['binding_identity_rejected','organization_binding_disabled','replacement_certificate_mismatch','invalid_personal_response']) {
    const h = await harness({ route: path=>path.endsWith('/intents') ? response({intent:issued},201) :
      path.endsWith('/receipts') ? code==='invalid_personal_response' ? response({}) : response({error:code},422) : undefined });
    chooseReplacement(h); await h.click('create'); await h.click('sign');
    const ambiguous=code==='invalid_personal_response';
    assert.equal(h.$('sign').disabled, ambiguous); assert.equal(h.$('retry').disabled, !ambiguous);
    h.mounted.dispose();
  }
});

test('closing before delivery of an already committed replacement clears display but does not claim cancellation', async () => {
  const delivered=deferred(),issued=replacementFixture(); let committed=false;
  const h=await harness({route:path=>{
    if(path.endsWith('/intents')) return response({intent:issued},201);
    if(path.endsWith('/receipts')) { committed=true; return delivered.promise; }
  }});
  chooseReplacement(h); await h.click('create'); const pending=h.click('sign');
  // Let the controlled signer/API promise reach the simulated commit boundary.
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(committed,true);
  await h.click('close'); delivered.resolve(response(receiptFixture(issued))); await pending;
  assert.equal(h.$('receipt').hidden,true); assert.match(h.$('result').textContent,/не отменяет уже сохранённые/);
  assert.match(html,/Если ответ потерян/); h.mounted.dispose();
});

test('expiry before delivery of an already committed replacement warns that clearing is not cancellation', async () => {
  for (const timerTick of [false, true]) {
    const delivered = deferred(), issued = replacementFixture(); let committed = false;
    const h = await harness({ route: path => {
      if (path.endsWith('/intents')) return response({ intent: issued }, 201);
      if (path.endsWith('/receipts')) { committed = true; return delivered.promise; }
    } });
    chooseReplacement(h); await h.click('create'); const pending = h.click('sign');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(committed, true);
    h.advance(600_001, timerTick);
    delivered.resolve(response(receiptFixture(issued))); await pending;
    assert.equal(h.$('receipt').hidden, true); assert.equal(h.$('hash').textContent, '');
    assert.equal(h.$('retry').disabled, true); assert.equal(h.$('new-session').hidden, false);
    assert.match(h.$('result').textContent, /не отменяет уже сохранённые операции/);
    assert.match(h.$('result').textContent, /проверка оператором реестра/);
    h.mounted.dispose();
  }
});

test('array-valued receipt ID, binding ID and certificate digest are not accepted even for enrollment', async () => {
  for(const field of ['id','bindingId','certificateDigest']){
    const result=receiptFixture();result.receipt[field]=[result.receipt[field]];
    const h=await harness({route:path=>path.endsWith('/receipts') ? response(result) : undefined});
    await h.click('create');await h.click('sign');assert.equal(h.$('receipt').hidden,true);
    assert.match(h.$('result').textContent,/не прошёл проверку/);h.mounted.dispose();
  }
});

test('happy path uses exact server bytes, CSRF JSON writes, scoped receipt and focus', async () => {
  let signedRequest;
  const page = await harness({ signer: async request => { signedRequest = request; return 'Y21z'; } });
  assert.equal(page.$('create').disabled, false);
  assert.equal(page.$('sign').disabled, true);
  await page.click('create');
  assert.equal(page.$('exact-bytes').textContent, page.fixture.text);
  assert.equal(page.$('base64').textContent, page.fixture.bytesBase64);
  assert.equal(page.$('hash').textContent, page.fixture.hash);
  assert.equal(page.document.activeElement, page.$('exact-title'));
  await page.click('sign');
  assert.equal(signedRequest.args.data, page.fixture.bytesBase64);
  assert.deepEqual(signedRequest.args.signerParams.chain, statusFixture().chain);
  const writes = page.requests.filter(request => request.options.method === 'POST');
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(writes[0].options.body), { action: 'enroll_test_person' });
  assert.deepEqual(JSON.parse(writes[1].options.body), { intentId, cms: 'Y21z' });
  for (const write of writes) {
    assert.equal(write.options.headers['Content-Type'], 'application/json');
    assert.equal(write.options.headers['X-DalaHold-CSRF'], statusFixture().csrfToken);
    assert.equal(write.options.credentials, 'same-origin');
  }
  assert.equal(page.$('receipt').hidden, false);
  assert.equal(page.$('receipt-kind').textContent, 'Свежая TEST-квитанция');
  assert.equal(page.$('receipt-binding').textContent, bindingId);
  assert.match(page.$('receipt-scope').textContent, /test_personal_binding_only/);
  assert.equal(page.document.activeElement, page.$('receipt-kind'));
  assert.equal(page.$('sign').disabled, true);
  assert.equal(page.$('retry').disabled, false);
});

test('identical retry after an ambiguous HTTP failure retains CMS and labels the original evidence as history', async () => {
  let sends = 0;
  const page = await harness({ route(path) {
    if (!path.endsWith('/receipts')) return;
    if (++sends === 1) return Promise.reject(new Error('private network detail'));
    return response(receiptFixture(intentFixture(), true));
  } });
  await page.click('create'); await page.click('sign');
  assert.equal(page.$('receipt').hidden, true);
  assert.equal(page.$('retry').disabled, false);
  page.advance(300_001);
  assert.equal(page.$('sign').disabled, true);
  assert.equal(page.$('retry').disabled, false);
  await page.click('retry');
  assert.equal(page.$('receipt-kind').textContent, 'Историческая TEST-квитанция');
  assert.match(page.$('receipt-note').textContent, /Нового подтверждения статуса эта квитанция не создаёт/);
  const sendsBody = page.requests.filter(request => request.path.endsWith('/receipts')).map(request => request.options.body);
  assert.equal(sendsBody[0], sendsBody[1]);
});

test('NCALayer cancellation sends no receipt and permits another signature', async () => {
  const page = await harness({ signer: async () => { throw new Error('signing_cancelled_or_rejected'); } });
  await page.click('create'); await page.click('sign');
  assert.equal(page.requests.some(request => request.path.endsWith('/receipts')), false);
  assert.match(page.$('result').textContent, /Подпись не отправлена/);
  assert.equal(page.$('sign').disabled, false);
  assert.equal(page.$('retry').disabled, true);
});

test('double click cannot issue parallel intents or signing calls', async () => {
  const pendingIntent = deferred(), pendingSign = deferred();
  let signs = 0;
  const page = await harness({ route: path => path.endsWith('/intents') ? pendingIntent.promise : undefined,
    signer: async () => { ++signs; return pendingSign.promise; } });
  const firstCreate = page.click('create');
  await page.click('create');
  await Promise.resolve();
  pendingIntent.resolve(response({ intent: page.fixture }, 201)); await firstCreate;
  assert.equal(page.requests.filter(request => request.path.endsWith('/intents')).length, 1);
  const firstSign = page.click('sign'); await page.click('sign');
  assert.equal(signs, 1);
  pendingSign.resolve('Y21z'); await firstSign;
  assert.equal(page.requests.filter(request => request.path.endsWith('/receipts')).length, 1);
});

test('close during NCALayer signing immediately clears state and ignores late CMS', async () => {
  const signed = deferred();
  const page = await harness({ signer: () => signed.promise });
  await page.click('create');
  const pending = page.click('sign');
  assert.equal(page.$('close').disabled, false);
  await page.click('close');
  const closedText = page.$('result').textContent;
  signed.resolve('Y21z'); await pending;
  assert.equal(page.requests.some(request => request.path.endsWith('/receipts')), false);
  assert.equal(page.$('result').textContent, closedText);
  assert.equal(page.$('hash').textContent, '');
  assert.equal(page.$('exact-bytes').textContent, '');
  assert.equal(page.$('retry').disabled, true);
  assert.equal(page.$('new-session').hidden, false);
  assert.equal(page.document.activeElement, page.$('new-session'));
  assert.deepEqual(JSON.parse(page.requests.at(-1).options.body), {});
});

test('close during receipt HTTP aborts request and late success cannot restore receipt', async () => {
  const verified = deferred();
  const page = await harness({ route: path => path.endsWith('/receipts') ? verified.promise : undefined });
  await page.click('create');
  const pending = page.click('sign');
  await Promise.resolve();
  const request = page.requests.find(request => request.path.endsWith('/receipts'));
  assert.ok(request);
  await page.click('close');
  assert.equal(request.options.signal.aborted, true);
  verified.resolve(response(receiptFixture(page.fixture))); await pending;
  assert.equal(page.$('receipt').hidden, true);
  assert.equal(page.$('receipt-id').textContent, '');
  assert.equal(page.$('create').disabled, true);
  assert.match(page.$('result').textContent, /TEST-сессия закрыта/);
});

test('close during intent issue or connectivity check cannot restore intent or readiness', async () => {
  for (const operation of ['create', 'connect']) {
    const pendingResponse = deferred();
    const page = await harness({
      route: path => operation === 'create' && path.endsWith('/intents') ? pendingResponse.promise : undefined,
      signer: () => pendingResponse.promise,
    });
    const pending = page.click(operation);
    await Promise.resolve();
    await page.click('close');
    pendingResponse.resolve(operation === 'create' ? response({ intent: page.fixture }, 201) : true);
    await pending;
    assert.equal(page.$('intent').hidden, true);
    assert.equal(page.$('create').disabled, true);
    assert.match(page.$('connection').textContent, /новая операция не запрашивается/);
    assert.match(page.$('result').textContent, /TEST-сессия закрыта/);
  }
});

test('session expiry during signing or before late HTTP receipt clears secrets and evidence', async () => {
  for (const operation of ['signing', 'receipt']) {
    const late = deferred();
    const page = await harness({ signer: operation === 'signing' ? () => late.promise : undefined,
      route: path => operation === 'receipt' && path.endsWith('/receipts') ? late.promise : undefined });
    await page.click('create'); const pending = page.click('sign'); await Promise.resolve();
    // No timer tick: the async result must independently enforce session expiry.
    page.advance(600_001, false);
    late.resolve(operation === 'signing' ? 'Y21z' : response(receiptFixture(page.fixture)));
    await pending;
    assert.equal(page.$('receipt').hidden, true);
    assert.equal(page.$('hash').textContent, '');
    assert.equal(page.$('close').disabled, true);
    assert.equal(page.$('new-session').hidden, false);
    assert.match(page.$('result').textContent, /Срок TEST-сессии истёк/);
    assert.match(page.$('result').textContent, /не отменяет уже сохранённые операции/);
  }
});

test('failed session close allows bounded close retry and never claims server logout', async () => {
  let closes = 0;
  const page = await harness({ route(path) {
    if (path.endsWith('/session/close') && ++closes === 1) return Promise.reject(new Error('network failure'));
  } });
  await page.click('create'); await page.click('sign'); await page.click('close');
  assert.equal(page.$('receipt').hidden, true);
  assert.equal(page.$('close').disabled, false);
  assert.equal(page.$('new-session').hidden, true);
  assert.match(page.$('result').textContent, /сервер не подтвердил закрытие/);
  assert.match(page.$('result').textContent, /ещё может завершиться/);
  await page.click('close');
  assert.equal(closes, 2);
  assert.equal(page.$('close').disabled, true);
  assert.equal(page.$('new-session').hidden, false);
});

test('missing session and CSRF rejection clear state and require a new session', async () => {
  for (const code of ['personal_session_unavailable', 'personal_csrf_required']) {
    const page = await harness({ route: path => path.endsWith('/receipts') ? response({ error: code }, 401) : undefined });
    await page.click('create'); await page.click('sign');
    assert.equal(page.$('hash').textContent, '');
    assert.equal(page.$('receipt').hidden, true);
    assert.equal(page.$('retry').disabled, true);
    assert.equal(page.$('new-session').hidden, false);
    assert.equal(page.document.activeElement, page.$('result'));
    assert.match(page.$('result').textContent, /не отменяет уже сохранённые операции/);
    assert.match(page.$('result').textContent, /проверка оператором реестра/);
  }
});

test('readiness errors pause new signing but permit an identical historical retry', async () => {
  let sends = 0;
  const page = await harness({ route(path) {
    if (!path.endsWith('/receipts')) return;
    return ++sends === 1 ? response({ error: 'status_unavailable' }, 503) : response(receiptFixture(intentFixture(), true));
  } });
  await page.click('create'); await page.click('sign');
  assert.equal(page.$('create').disabled, true);
  assert.equal(page.$('sign').disabled, true);
  assert.equal(page.$('retry').disabled, false);
  await page.click('retry');
  assert.equal(page.$('receipt-kind').textContent, 'Историческая TEST-квитанция');
  await page.click('refresh');
  assert.equal(page.$('create').disabled, false);
});

test('failed readiness refresh invalidates the old chain while retaining explicit session close', async () => {
  let readyChecks = 0;
  const page = await harness({ route(path) {
    if (path.endsWith('/status') && ++readyChecks > 2) return response({ ...statusFixture(), scope: 'business_access' });
  } });
  await page.click('create');
  assert.equal(page.$('sign').disabled, false);
  await page.click('refresh');
  assert.equal(page.$('create').disabled, true);
  assert.equal(page.$('sign').disabled, true);
  assert.equal(page.$('close').disabled, false);
  assert.match(page.$('sdk').textContent, /готовность не подтверждена/);
});

test('expired readiness blocks a new signature while session close and refresh remain usable', async () => {
  const page = await harness({ route: path => path.endsWith('/status')
    ? response({ ...statusFixture(), validUntil: initialTime + 1000 }) : undefined });
  await page.click('create'); page.advance(1001);
  assert.equal(page.$('sign').disabled, true);
  assert.equal(page.$('create').disabled, true);
  assert.equal(page.$('close').disabled, false);
  assert.equal(page.$('refresh').disabled, false);
  assert.match(page.$('sdk').textContent, /готовности истёк/);
});

test('rate limit honors Retry-After while session close stays usable; unknown errors stay sanitized', async () => {
  const page = await harness({ route: path => path.endsWith('/intents')
    ? response({ error: 'personal_rate_limited' }, 429, '3') : undefined });
  await page.click('create');
  assert.equal(page.$('create').disabled, true);
  assert.equal(page.$('close').disabled, false);
  assert.match(page.$('result').textContent, /через 3 сек/);
  page.advance(3001);
  assert.equal(page.$('create').disabled, false);
  const rejected = await harness({ route: path => path.endsWith('/intents')
    ? response({ error: 'private certificate IIN 000000000000' }, 500) : undefined });
  await rejected.click('create');
  assert.doesNotMatch(rejected.$('result').textContent, /private|000000000000/);
  assert.match(rejected.$('result').textContent, /Операция не выполнена/);
});

test('altered intent and foreign receipt never enable signing or show accepted evidence', async () => {
  const changedIntent = await harness({ route: path => path.endsWith('/intents')
    ? response({ intent: { ...intentFixture(), hash: 'f'.repeat(64) } }, 201) : undefined });
  await changedIntent.click('create');
  assert.equal(changedIntent.$('sign').disabled, true);
  assert.equal(changedIntent.$('intent').hidden, true);
  const foreignReceipt = await harness({ route(path) {
    if (!path.endsWith('/receipts')) return;
    const result = receiptFixture(); result.receipt.scope = 'business_access'; return response(result);
  } });
  await foreignReceipt.click('create'); await foreignReceipt.click('sign');
  assert.equal(foreignReceipt.$('receipt').hidden, true);
  assert.match(foreignReceipt.$('result').textContent, /не прошёл проверку/);
});

test('expired intent cannot open NCALayer even between timer ticks; disposal invalidates late work', async () => {
  let calls = 0;
  const page = await harness({ signer: async () => { ++calls; return 'Y21z'; } });
  await page.click('create');
  page.advance(300_001, false); await page.click('sign');
  assert.equal(calls, 0);
  assert.equal(page.$('sign').disabled, true);
  const signed = deferred();
  const disposed = await harness({ signer: () => signed.promise });
  await disposed.click('create'); const pending = disposed.click('sign');
  disposed.mounted.dispose(); signed.resolve('Y21z'); await pending;
  assert.equal(disposed.requests.some(request => request.path.endsWith('/receipts')), false);
  assert.equal(disposed.$('hash').textContent, '');
});
