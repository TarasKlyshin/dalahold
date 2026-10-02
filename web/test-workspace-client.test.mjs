import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mountTestWorkspace, readTestDocument, validateTermsIntent, validateWorkspaceEvidence } from './test-workspace-client.mjs';
import { fingerprintDraftTerms } from './terms.mjs';

const html = readFileSync(new URL('./test-workspace.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./test-workspace.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./test-workspace-client.mjs', import.meta.url), 'utf8');
const TIME = Date.UTC(2026, 9, 2, 12);
const DEAL = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const INTENT = '33333333-3333-4333-8333-333333333333';
const RECEIPT = '44444444-4444-4444-8444-444444444444';
const DOCUMENT = '55555555-5555-4555-8555-555555555555';
const SCOPE = 'local_test_workspace_only';
const TERMS = { dealId: DEAL, version: 1, scenario: 'grain', quantity: 12, amount: 800000, date: '2026-10-10' };
const hash = value => createHash('sha256').update(value).digest('hex');
function evidence(terms = TERMS, documents = []) {
  const { dealId, ...fields } = terms;
  return { scope: SCOPE, deal: { id: dealId, ...fields, termsFingerprint: fingerprintDraftTerms(terms) },
    terms: { ...terms }, documents, signatures: [], offlineEvidence: null };
}
function intent(view = evidence(), overrides = {}) {
  const text = JSON.stringify({ domain: 'dalahold:test-terms-evidence:v1',
    purpose: 'TEST only: record one personal TEST CMS signature over these exact terms and document digests. No transaction approval, role, access, corporate powers, wallet or payment is authorized.',
    action: 'record_test_terms_signature', nonce: INTENT, sessionHash: 'a'.repeat(64), issuedAt: TIME, expiresAt: TIME + 300000,
    statusSource: 'test_ocsp', snapshot: { terms: view.terms, termsFingerprint: view.deal.termsFingerprint,
      documents: view.documents.map(({ id, category, byteLength, sha256 }) => ({ id, category, byteLength, sha256 })).sort((a, b) => a.id.localeCompare(b.id)) }, ...overrides }, null, 2) + '\n';
  return { id: INTENT, text, bytesBase64: Buffer.from(text).toString('base64'), hash: hash(text), expiresAt: TIME + 300000 };
}
function status(ready = true) {
  return { scope: SCOPE, csrfToken: 'c'.repeat(64), sessionExpiresAt: TIME + 900000,
    signing: ready ? { ready: true, chain: ['-----BEGIN CERTIFICATE-----A', '-----BEGIN CERTIFICATE-----B'],
      validUntil: TIME + 900000, statusSource: 'test_ocsp' } : { ready: false, error: 'verifier_unavailable' } };
}
function receipt(issued = intent(), historical = false) {
  const { snapshot } = JSON.parse(issued.text);
  return { historical, receipt: { id: RECEIPT, intentHash: issued.hash, dealId: snapshot.terms.dealId,
    termsVersion: snapshot.terms.version, termsFingerprint: snapshot.termsFingerprint, certificateDigest: 'd'.repeat(64),
    verifiedAt: TIME, validUntil: TIME + 600000, statusSource: 'test_ocsp', scope: 'test_terms_evidence_only', action: 'record_test_terms_signature' } };
}
const response = (value, statusCode = 200) => ({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, json: async () => structuredClone(value) });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function documentFixture() {
  const elements = new Map();
  const document = { getElementById: id => elements.get(id) || null, body: null };
  const make = (tagName, attributes = new Map()) => {
    const listeners = new Map(), classes = new Set();
    return { tagName: tagName.toUpperCase(), attributes, value: attributes.get('value') || '', textContent: '',
      disabled: attributes.has('disabled'), hidden: attributes.has('hidden'), checked: false, files: [], children: [],
      setAttribute(name, value) { attributes.set(name, value); }, getAttribute(name) { return attributes.get(name) ?? null; },
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
      replaceChildren(...items) { this.children = [...items]; }, append(...items) { this.children.push(...items); },
      addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
      click() { if (!this.disabled) return listeners.get('click')?.(); },
      dispatch(name) { if (!this.disabled) return listeners.get(name)?.(); },
      force(name) { return listeners.get(name)?.(); }, remove() {}, focus() {} };
  };
  document.createElement = tag => make(tag); document.body = make('body');
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attributes = new Map(); for (const attr of match[2].matchAll(/([a-z][\w-]*)(?:="([^"]*)")?/gi)) attributes.set(attr[1], attr[2] ?? '');
    const id = attributes.get('id'); if (!id) continue;
    assert.equal(elements.has(id), false, `duplicate id ${id}`); elements.set(id, make(match[1], attributes));
  }
  document.getElementById('tw-category').value = 'contract';
  return document;
}
async function harness({ route, signer, search = `?dealId=${DEAL}`, ready = true, fixture = evidence() } = {}) {
  const document = documentFixture(), requests = [], signed = []; let time = TIME, tick;
  const issued = intent(fixture);
  const fetchImpl = async (path, options) => {
    const request = { path, options, body: options.body ? JSON.parse(options.body) : undefined }; requests.push(request);
    const override = route?.(request, requests); if (override !== undefined) return await override;
    if (path.endsWith('/status')) return response(status(ready));
    if (path === '/api/deals') return response({ deals: [fixture.deal] });
    if (path.endsWith('/evidence')) return response(fixture);
    if (path.endsWith('/intents')) return response({ intent: issued }, 201);
    if (path.endsWith('/receipts')) return response(receipt(issued));
    if (path.endsWith('/session/close')) return response({ closed: true, scope: SCOPE });
    if (path.endsWith('/documents')) return response({ document: { id: DOCUMENT, dealId: DEAL, termsVersion: request.body.expectedVersion,
      category: request.body.category, byteLength: Buffer.from(request.body.bytesBase64, 'base64').length,
      sha256: hash(Buffer.from(request.body.bytesBase64, 'base64')), createdAt: TIME, scope: 'local_test_document_only', fileKind: 'text' } }, 201);
    throw new Error(`unexpected route ${path}`);
  };
  const exported = [], urls = [];
  const mounted = mountTestWorkspace(document, { fetchImpl, cryptoImpl: webcrypto, now: () => time,
    ncalayer: async request => { signed.push(request); return signer ? signer(request) : 'Y21z'; },
    locationImpl: { search }, setIntervalImpl(fn) { tick = fn; return 1; }, clearIntervalImpl() { tick = null; },
    BlobImpl: class { constructor(parts) { exported.push(parts.join('')); } }, URLImpl: { createObjectURL() { return 'blob:fixture'; }, revokeObjectURL(url) { urls.push(url); } } });
  await mounted.initialized;
  const $ = name => document.getElementById(`tw-${name}`);
  return { $, document, mounted, requests, signed, issued, exported, urls, click: name => $(name).click(),
    advance(ms) { time += ms; tick?.(); }, chooseFile(text = 'Тестовые условия', name = 'secret-filename.txt', type = 'text/plain') {
      $('consent').checked = true; $('consent').dispatch('change');
      const bytes = Buffer.from(text); $('file').files = [{ name, type, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer }]; $('file').dispatch('change');
    } };
}

test('Russian standalone page uses labelled independent controls and separate trust statements', () => {
  const dom = documentFixture(); assert.match(html, /<html lang="ru">/);
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) assert.match(id, /^tw-/);
  for (const [, id] of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.equal(dom.getElementById(id)?.tagName, 'H2');
  for (const name of ['deal', 'consent', 'file', 'category']) assert.match(html, new RegExp(`<label[^>]*for="tw-${name}"`));
  assert.equal(dom.getElementById('tw-result').getAttribute('aria-live'), 'polite');
  assert.equal(dom.getElementById('tw-result').getAttribute('aria-atomic'), 'true');
  assert.match(html, /href="\/"/); assert.match(html, /href="\/styles.css"/);
  assert.match(html, /не подтверждает роли или корпоративные полномочия/); assert.match(html, /офлайн-решения локальных тестовых ключей показаны отдельно/);
  assert.match(css, /min-height: 44px/); assert.match(css, /tw-skip:focus/);
  assert.doesNotMatch(source, /innerHTML|console\.|localStorage|sessionStorage|indexedDB/);
});

test('intent rejects wrong types, hash, byte transport, purpose, action and extra fields', async () => {
  const view = evidence(), good = intent(view); assert.equal(await validateTermsIntent(good, view, TIME, webcrypto), good);
  for (const changed of [{ ...good, hash: ['a'.repeat(64)] }, { ...good, hash: 'f'.repeat(64) }, { ...good, id: [INTENT] },
    { ...good, expiresAt: TIME }, { ...good, text: good.text + ' ' }, { ...good, bytesBase64: good.bytesBase64 + '\n' },
    { ...good, bytesBase64: 'AB==' }, intent(view, { purpose: 'approve payment' }), intent(view, { action: 'offer' }),
    intent(view, { role: 'seller' })]) await assert.rejects(validateTermsIntent(changed, view, TIME, webcrypto), /invalid_response/);
});

test('intent pins exact deal/version/fingerprint and ordered document digest manifest', async () => {
  const doc = { id: DOCUMENT, dealId: DEAL, termsVersion: 1, category: 'contract', byteLength: 4, sha256: 'e'.repeat(64), createdAt: TIME, scope: 'local_test_document_only', fileKind: 'text' };
  const view = evidence(TERMS, [doc]); await validateTermsIntent(intent(view), view, TIME, webcrypto);
  for (const changed of [evidence({ ...TERMS, version: 2 }, [doc]), evidence({ ...TERMS, dealId: OTHER }, [doc]),
    evidence(TERMS, [{ ...doc, sha256: 'f'.repeat(64) }]), evidence(TERMS, [])])
    await assert.rejects(validateTermsIntent(intent(view), changed, TIME, webcrypto), /invalid_response/);
  const unordered = JSON.parse(intent(view).text); const text = JSON.stringify({ purpose: unordered.purpose, domain: unordered.domain,
    ...Object.fromEntries(Object.entries(unordered).filter(([key]) => !['purpose', 'domain'].includes(key))) }, null, 2) + '\n';
  await assert.rejects(validateTermsIntent({ ...intent(view), text, bytesBase64: Buffer.from(text).toString('base64'), hash: hash(text) }, view, TIME, webcrypto), /invalid_response/);
});

test('loaded evidence validates fingerprint, version-specific documents and signature provenance', async () => {
  const view = evidence(), signed = receipt();
  view.signatures = [{ snapshot: JSON.parse(intent().text).snapshot, receipt: signed.receipt, currentMatches: true }];
  assert.equal((await validateWorkspaceEvidence(view, DEAL, webcrypto)).signatures.length, 1);
  for (const changed of [{ ...view, deal: { ...view.deal, termsFingerprint: 'f'.repeat(64) } },
    { ...view, signatures: [{ ...view.signatures[0], currentMatches: false }] }, { ...view, offlineEvidence: { trustLevel: 'production' } }])
    await assert.rejects(validateWorkspaceEvidence(changed, DEAL, webcrypto), /invalid_response/);
});

test('stale personal snapshot and separate offline test-key evidence keep honest provenance', async () => {
  const view = evidence({ ...TERMS, version: 2, amount: TERMS.amount + 1 });
  view.signatures = [{ snapshot: JSON.parse(intent().text).snapshot, receipt: receipt().receipt, currentMatches: false }];
  view.offlineEvidence = { schema: 'dalahold.offline-evidence.v1', trustLevel: 'local_test_fixture_only',
    disclaimer: 'No NCA signature, verified file, payment or chain transaction.', dealId: DEAL, terms: TERMS,
    termsFingerprint: fingerprintDraftTerms(TERMS), status: 'offered', decisions: [{ sequence: 1, decisionId: INTENT,
      actorId: OTHER, action: 'offer', resultStatus: 'offered', challengeHash: 'a'.repeat(64), signatureHash: 'b'.repeat(64), source: 'test_key_receipt' }],
    documentMarkers: [], cms: 'should-never-export', sessionHash: 'should-never-export' };
  const checked = await validateWorkspaceEvidence(view, DEAL, webcrypto);
  assert.equal(checked.signatures[0].currentMatches, false); assert.equal(checked.offlineEvidence.terms.version, 1);
  assert.doesNotMatch(JSON.stringify(checked), /should-never-export/);
  const h = await harness({ fixture: view });
  assert.match(h.$('signatures').textContent, /Личная TEST CMS/); assert.match(h.$('offline').textContent, /не NCALayer/);
  assert.match(h.$('offline').textContent, /test_key_receipt/); await h.click('export');
  assert.doesNotMatch(h.exported[0], /should-never-export/); h.mounted.dispose();
});

test('file requires consent before any read, exact text type, size and fatal UTF8', async () => {
  let reads = 0; const file = { name: 'private.txt', type: 'text/plain', size: 1, arrayBuffer: async () => { reads++; return Uint8Array.of(65).buffer; } };
  await assert.rejects(readTestDocument(file, false, webcrypto), /consent_required/); assert.equal(reads, 0);
  for (const bad of [{ ...file, name: 'private.html' }, { ...file, type: 'text/html' }, { ...file, size: 0 }, { ...file, size: 262145 }])
    await assert.rejects(readTestDocument(bad, true, webcrypto), /invalid_file/);
  assert.equal(reads, 0);
  await assert.rejects(readTestDocument({ ...file, arrayBuffer: async () => Uint8Array.of(255).buffer }, true, webcrypto), /invalid_file/);
  const bytes = await readTestDocument(file, true, webcrypto); assert.deepEqual(Object.keys(bytes), ['bytesBase64', 'byteLength', 'sha256']);
});

test('not-ready SDK still loads evidence and accepts an anonymized document without filename', async () => {
  const h = await harness({ ready: false }); assert.equal(h.$('create').disabled, true); assert.equal(h.$('export').disabled, false);
  h.chooseFile(); await h.click('upload');
  const request = h.requests.find(r => r.path.endsWith('/documents'));
  assert.deepEqual(Object.keys(request.body).sort(), ['bytesBase64', 'category', 'expectedVersion', 'requestId']);
  assert.doesNotMatch(JSON.stringify(request.body), /secret-filename/); assert.equal(request.options.headers['X-DalaHold-CSRF'], 'c'.repeat(64));
  assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.cache, 'no-store'); assert.equal(h.signed.length, 0);
  h.mounted.dispose();
});

test('ambiguous document upload retries identical UUID and payload, file change clears pending request', async () => {
  let uploads = 0; const h = await harness({ route(req) { if (req.path.endsWith('/documents') && ++uploads === 1) return Promise.reject(new Error('lost')); } });
  h.chooseFile(); await h.click('upload'); assert.equal(h.$('upload-retry').disabled, false); assert.equal(h.$('upload').disabled, true);
  await h.click('upload-retry');
  const sent = h.requests.filter(r => r.path.endsWith('/documents')); assert.deepEqual(sent[0].body, sent[1].body);
  h.chooseFile('Новый тест'); assert.equal(h.$('upload-retry').disabled, true); h.mounted.dispose();
});

test('NCALayer uses pinned bytes and fresh/historical receipts stay distinct without authority', async () => {
  let count = 0; const h = await harness({ route(req) { if (req.path.endsWith('/receipts')) return response(receipt(intent(), ++count > 1)); } });
  await h.click('create'); await h.click('sign'); assert.equal(h.signed[0].args.data, h.issued.bytesBase64);
  assert.equal(h.$('receipt-kind').textContent, 'Новая TEST-квитанция'); assert.equal(h.$('sign').disabled, true);
  await h.click('retry'); assert.equal(h.$('receipt-kind').textContent, 'Историческая TEST-квитанция');
  assert.match(h.$('receipt-note').textContent, /не подтвердил текущий статус и не выдал разрешений/);
  assert.equal(h.$('create').disabled, false); assert.equal(h.$('refresh').disabled, false);
  h.mounted.dispose();
});

test('network loss retains exact CMS, blocks resign/refresh and permits identical historical retry', async () => {
  let count = 0; const h = await harness({ route(req) { if (req.path.endsWith('/receipts')) return ++count === 1
    ? Promise.reject(new Error('lost after commit')) : response(receipt(intent(), true)); } });
  await h.click('create'); await h.click('sign'); assert.equal(h.$('sign').disabled, true); assert.equal(h.$('create').disabled, true);
  assert.equal(h.$('refresh').disabled, true); assert.equal(h.$('retry').disabled, false);
  h.advance(301000); await h.click('retry');
  const sent = h.requests.filter(r => r.path.endsWith('/receipts')); assert.deepEqual(sent[0].body, sent[1].body); assert.equal(h.signed.length, 1);
  assert.equal(h.$('receipt-kind').textContent, 'Историческая TEST-квитанция'); h.mounted.dispose();
});

test('malformed successful response and generic503 retain CMS; explicit precommit422 may clear it', async () => {
  for (const kind of ['malformed', '503', '422']) {
    const h = await harness({ route(req) { if (req.path.endsWith('/receipts')) return kind === 'malformed' ? response({ receipt: { scope: 'grant' } })
      : response({ error: kind === '422' ? 'terms_signature_rejected' : 'verifier_unavailable' }, Number(kind)); } });
    await h.click('create'); await h.click('sign');
    assert.equal(h.$('retry').disabled, kind === '422'); assert.equal(h.$('sign').disabled, kind !== '422'); h.mounted.dispose();
  }
});

test('invalid intent never opens NCALayer or submits a receipt', async () => {
  const h = await harness({ route(req) { if (req.path.endsWith('/intents')) return response({ intent: { ...intent(), hash: ['bad'] } }); } });
  await h.click('create'); await h.click('sign'); assert.equal(h.signed.length, 0); assert.equal(h.$('sign').disabled, true);
  assert.equal(h.requests.filter(r => r.path.endsWith('/receipts')).length, 0); h.mounted.dispose();
});

test('stale asynchronous intent response cannot populate a changed selection', async () => {
  const pending = deferred(); const h = await harness({ route(req) { if (req.path.endsWith('/intents')) return pending.promise; } });
  const creating = h.click('create'); assert.equal(h.$('deal').disabled, true);
  h.$('deal').value = ''; const selecting = h.$('deal').force('change');
  pending.resolve(response({ intent: intent() })); await creating; await selecting;
  assert.equal(h.$('intent').hidden, true); assert.equal(h.$('sign').disabled, true); h.mounted.dispose();
});

test('session close during an ambiguous commit suppresses the late receipt and clears volatile bytes', async () => {
  const pending = deferred(); const h = await harness({ route(req) { if (req.path.endsWith('/receipts')) return pending.promise; } });
  await h.click('create'); const signing = h.click('sign'); await new Promise(resolve => setImmediate(resolve));
  await h.click('close'); pending.resolve(response(receipt())); await signing;
  assert.equal(h.$('receipt').hidden, true); assert.equal(h.$('exact-bytes').textContent, ''); assert.equal(h.$('retry').disabled, true);
  assert.match(h.$('result').textContent, /не отменяет сохранённую операцию/); assert.match(h.$('result').textContent, /readback оператора/); h.mounted.dispose();
});

test('session expiry after a server commit clears volatile evidence and prevents retry', async () => {
  const pending = deferred(); const h = await harness({ route(req) { if (req.path.endsWith('/receipts')) return pending.promise; } });
  await h.click('create'); const signing = h.click('sign'); await new Promise(resolve => setImmediate(resolve));
  h.advance(900001); pending.resolve(response(receipt())); await signing;
  assert.equal(h.$('receipt').hidden, true); assert.equal(h.$('export').disabled, true); assert.equal(h.$('retry').disabled, true);
  assert.equal(h.$('deal').value, ''); assert.match(h.$('result').textContent, /readback оператора/); h.mounted.dispose();
});

test('close retries retain CSRF, clear page immediately and stop after three failed attempts', async () => {
  const h = await harness({ route(req) { if (req.path.endsWith('/session/close')) return Promise.reject(new Error('lost')); } });
  await h.click('create'); await h.click('close'); assert.equal(h.$('exact-bytes').textContent, '');
  await h.click('close'); await h.click('close'); await h.click('close');
  const sent = h.requests.filter(r => r.path.endsWith('/session/close')); assert.equal(sent.length, 3);
  assert(sent.every(r => r.options.headers['X-DalaHold-CSRF'] === 'c'.repeat(64) && JSON.stringify(r.body) === '{}'));
  assert.equal(h.$('close').disabled, true); assert.equal(h.$('new-session').hidden, false); h.mounted.dispose();
});

test('validated loaded export omits CMS/session and document filename', async () => {
  const h = await harness(); await h.click('create'); await h.click('sign'); await h.click('export');
  const exported = JSON.parse(h.exported[0]); assert.equal(exported.scope, SCOPE); assert.equal(exported.deal.id, DEAL);
  assert.doesNotMatch(h.exported[0], /csrfToken|sessionHash|bytesBase64|Y21z|filename/); assert.deepEqual(h.urls, ['blob:fixture']); h.mounted.dispose();
});

test('malformed optional dealId never becomes an evidence path', async () => {
  const h = await harness({ search: '?dealId=../../private' });
  assert.equal(h.requests.filter(r => r.path.endsWith('/evidence')).length, 0); assert.equal(h.$('export').disabled, true); h.mounted.dispose();
});
