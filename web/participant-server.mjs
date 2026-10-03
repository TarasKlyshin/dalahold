// Independent local TEST capability accounts; never NCA identity or authority.
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParticipantStore, ParticipantStoreError, PARTICIPANT_REPUTATION_SCOPE } from './participant-store.mjs';
import { TestDocumentError } from './test-documents.mjs';
import { ParticipantSignatureError } from '../nca/participant-signatures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const PREFIX = '/api/participants/v1';
const COOKIE = 'dalahold_participant_test';
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCOPE = 'local_test_participant_statements_only';
const TTL = 900_000;
const fail = (code, status) => Object.assign(new Error(code), { code, status, transportError: true });
const token = () => randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');

function fields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(','))
    throw fail('invalid_request', 400);
  return value;
}

async function readBody(req, timeoutMs) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || ''))
    throw fail('content_type', 415);
  let length = 0; const chunks = [];
  const timer = setTimeout(() => req.destroy(), timeoutMs); timer.unref();
  try {
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 370_000) throw fail('body_too_large', 413);
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('invalid_request', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('invalid_request', 400);
  return value;
}

function content(value) {
  if (typeof value !== 'string' || !value.length || value.length > 349_528 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw fail('invalid_request', 400);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > 262_144 || bytes.toString('base64') !== value)
    throw fail('invalid_request', 400);
  return bytes;
}

function signatureContent(value) {
  if (typeof value !== 'string' || !value.length || value.length > 131_072 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw fail('invalid_signature_request', 400);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > 98_304 || bytes.toString('base64') !== value)
    throw fail('invalid_signature_request', 400);
  return bytes;
}

function publicIntent(value) {
  return { id: value.id, text: value.bytes.toString('utf8'), bytesBase64: value.bytes.toString('base64'),
    hash: value.hash, expiresAt: value.expiresAt };
}

export function createParticipantServer({ store, now = Date.now, bodyTimeoutMs = 15_000 } = {}) {
  if (!store || typeof now !== 'function' || !Number.isInteger(bodyTimeoutMs) ||
      bodyTimeoutMs < 10 || bodyTimeoutMs > 15_000) throw new Error('invalid_participant_server');
  const sessions = new Map();
  const scope = store.scope || SCOPE;
  const buckets = new Map();
  let stopping = false;
  const assets = new Map([
    ['/participants/', ['web/participant.html', 'text/html; charset=utf-8']],
    ['/participants/client.mjs', ['web/participant-client.mjs', 'text/javascript; charset=utf-8']],
    ['/participants/delivery-client.mjs', ['web/participant-delivery-client.mjs', 'text/javascript; charset=utf-8']],
    ['/participants/styles.css', ['web/participant.css', 'text/css; charset=utf-8']],
  ]);
  if (store.signedTest) {
    assets.set('/participants/signing-client.mjs', ['web/participant-signing-client.mjs', 'text/javascript; charset=utf-8']);
    assets.set('/participants/nca-client.mjs', ['nca/client.mjs', 'text/javascript; charset=utf-8']);
  }
  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer' });
    res.end(JSON.stringify(value));
  }
  function limited(key, maximum) {
    let bucket = buckets.get(key);
    if (!bucket || now() >= bucket.until) {
      bucket = { count: 0, until: now() + 60_000 };
      buckets.set(key, bucket);
    }
    if (bucket.count >= maximum) throw fail('rate_limited', 429);
    bucket.count++;
  }
  function prune() {
    for (const [key, entry] of sessions) if (entry.expiresAt <= now()) sessions.delete(key);
    for (const [key, entry] of buckets) if (entry.until <= now()) buckets.delete(key);
  }
  function cookie(req) {
    const entries = (req.headers.cookie || '').split(';').map(x => x.trim())
      .filter(x => x.startsWith(`${COOKIE}=`)).map(x => x.slice(COOKIE.length + 1));
    return entries.length === 1 && HEX.test(entries[0]) ? entries[0] : null;
  }
  function issue(res, participant = null, oldKey = null) {
    prune();
    if (stopping) throw fail('unavailable', 503);
    if (oldKey) sessions.delete(oldKey);
    if (sessions.size >= 200) throw fail('rate_limited', 429);
    const key = token();
    const entry = { csrfToken: token(), expiresAt: now() + TTL, participant };
    sessions.set(key, entry);
    res.setHeader('Set-Cookie', `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=${PREFIX}; Max-Age=900`);
    return { key, entry };
  }
  function current(req, res, authenticated = false) {
    const key = cookie(req), entry = key && sessions.get(key);
    const assertCurrent = () => {
      if (stopping || !entry || sessions.get(key) !== entry || entry.expiresAt <= now() ||
          req.aborted || res.destroyed) throw fail('session_unavailable', 401);
      if (authenticated && !entry.participant) throw fail('authentication_required', 401);
    };
    assertCurrent(); return { key, entry, assertCurrent };
  }
  function publicSession(entry) {
    return { authenticated: Boolean(entry.participant), csrfToken: entry.csrfToken,
      expiresAt: entry.expiresAt, ...(entry.participant ? { participant: entry.participant } : {}), scope,
      ...(store.signedTest ? { signing: { enabled: true, statusSource: 'test_ocsp' } } : {}) };
  }
  function csrf(req, entry) {
    const value = req.headers['x-dalahold-csrf'];
    if (typeof value !== 'string' || !HEX.test(value) ||
        !timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(entry.csrfToken, 'hex')))
      throw fail('csrf_required', 403);
  }
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address()?.port}`;
    try {
      if (stopping) throw fail('unavailable', 503);
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) ||
          (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) ||
          (req.method !== 'GET' && req.headers.origin !== `http://${host}`))
        throw fail('local_origin_required', 403);
      const url = new URL(req.url, `http://${host}`);
      if (url.search) throw fail('not_found', 404);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/') {
        res.writeHead(302, { Location: '/participants/', 'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const bytes = await readFile(resolve(root, file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'${store.signedTest ? ' wss://127.0.0.1:13579' : ''}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` });
        res.end(bytes); return;
      }
      if (!path.startsWith(`${PREFIX}/`)) throw fail('not_found', 404);
      limited('requests', 500);
      if (req.method === 'GET' && path === `${PREFIX}/session`) {
        limited('bootstrap', 60);
        prune();
        const key = cookie(req), entry = key && sessions.get(key);
        send(res, 200, publicSession(entry || issue(res).entry)); return;
      }
      if (!['GET', 'POST'].includes(req.method)) throw fail('not_found', 404);
      const authenticationRoute = [`${PREFIX}/participants`, `${PREFIX}/session/login`, `${PREFIX}/session/logout`].includes(path);
      if (authenticationRoute && req.method !== 'POST') throw fail('not_found', 404);
      const session = current(req, res, !authenticationRoute);
      const { entry, assertCurrent } = session;
      const scoped = action => store.withCommitGuard(assertCurrent, action);
      let input;
      if (req.method === 'POST') {
        csrf(req, entry); limited(`writes:${session.key}`, 40); limited('writes', 120);
        input = await readBody(req, bodyTimeoutMs); assertCurrent();
      } else limited(`reads:${session.key}`, 100);
      if (path === `${PREFIX}/participants` && req.method === 'POST') {
        fields(input, []);
        if (entry.participant) throw fail('already_authenticated', 409);
        limited('registrations', 10);
        const result = scoped(() => store.register());
        const next = issue(res, result.participant, session.key);
        send(res, 201, { ...result, ...publicSession(next.entry) }); return;
      }
      if (path === `${PREFIX}/session/login` && req.method === 'POST') {
        fields(input, ['accessCode']); limited('login', 20);
        if (entry.participant) throw fail('already_authenticated', 409);
        const participant = scoped(() => store.authenticate(input.accessCode));
        const next = issue(res, participant, session.key);
        send(res, 200, publicSession(next.entry)); return;
      }
      if (path === `${PREFIX}/session/logout` && req.method === 'POST') {
        fields(input, []); sessions.delete(session.key);
        res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=${PREFIX}; Max-Age=0`);
        send(res, 200, { closed: true, scope }); return;
      }
      const actorId = entry.participant.id;
      if (path === `${PREFIX}/reputation` && req.method === 'GET') {
        send(res, 200, { reputation: scoped(() => store.getReputation(actorId)), scope: PARTICIPANT_REPUTATION_SCOPE, dealScope: scope }); return;
      }
      if (store.signedTest) {
        const sessionHash = hash(session.key);
        if (req.method === 'GET' && path === `${PREFIX}/signing`) {
          const result = await store.signatureStatus(); assertCurrent();
          send(res, 200, { ...result, anchorEnabled: store.memoEnabled, scope }); return;
        }
        if (req.method === 'GET' && path === `${PREFIX}/identity`) {
          send(res, 200, { binding: scoped(() => store.getCertificateBinding(actorId)), scope }); return;
        }
        if (req.method === 'POST' && path === `${PREFIX}/identity-intents`) {
          fields(input, []);
          const intent = store.createEnrollmentIntent(actorId, sessionHash, input, { assertCurrent });
          send(res, 201, { intent: publicIntent(intent), scope }); return;
        }
        if (req.method === 'POST' && path === `${PREFIX}/signature-receipts`) {
          fields(input, ['intentId', 'cms']);
          const result = await store.submitSignature(actorId, sessionHash,
            { intentId: input.intentId, cms: signatureContent(input.cms) }, { assertCurrent });
          assertCurrent();
          const deal = result.receipt.dealId ? scoped(() => store.getDeal(actorId, result.receipt.dealId)) : undefined;
          send(res, 200, { ...result, ...(deal ? { deal } : {}), scope }); return;
        }
      }
      if (path === `${PREFIX}/deals`) {
        if (req.method === 'GET') send(res, 200, { deals: scoped(() => store.listDeals(actorId)), scope });
        else {
          fields(input, ['requestId', 'creatorRole', 'scenario', 'quantity', 'amount', 'date']);
          const deal = scoped(() => store.createDeal(actorId, input));
          res.setHeader('Location', `${PREFIX}/deals/${deal.id}`);
          send(res, 201, { deal });
        }
        return;
      }
      if (path === `${PREFIX}/invitations/claims` && req.method === 'POST') {
        fields(input, ['code']); send(res, 200, scoped(() => store.claimInvitation(actorId, input))); return;
      }
      const match = new RegExp(`^${PREFIX}/deals/([^/]+)(?:/(versions|invitations|documents|events|reviews|reputation|evidence|signature-intents|anchor-intents)(?:/([^/]+))?)?$`).exec(path);
      if (!match || !UUID.test(match[1]) || (match[3] && !UUID.test(match[3]))) throw fail('not_found', 404);
      const [, dealId, resource, documentId] = match;
      // Shared membership check happens before body validation or any detail lookup.
      scoped(() => store.getDeal(actorId, dealId)); assertCurrent();
      if (req.method === 'GET' && !resource) { send(res, 200, { deal: scoped(() => store.getDeal(actorId, dealId)) }); return; }
      if (req.method === 'GET' && resource === 'evidence' && !documentId) {
        const evidence = scoped(() => store.getEvidencePackage(actorId, dealId)); assertCurrent();
        res.setHeader('Content-Disposition', `attachment; filename="test-evidence-${dealId}.json"`);
        send(res, 200, evidence); return;
      }
      if (req.method === 'GET' && resource === 'reviews') {
        const reviews = scoped(() => store.listReviews(actorId, dealId));
        if (documentId) {
          const review = reviews.find(item => item.id === documentId);
          if (!review) throw fail('not_found', 404);
          send(res, 200, { review, scope: PARTICIPANT_REPUTATION_SCOPE, dealScope: scope });
        } else send(res, 200, { reviews, scope: PARTICIPANT_REPUTATION_SCOPE, dealScope: scope });
        return;
      }
      if (req.method === 'GET' && resource === 'reputation' && !documentId) {
        send(res, 200, { reputation: scoped(() => store.getDealReputation(actorId, dealId)), scope: PARTICIPANT_REPUTATION_SCOPE, dealScope: scope }); return;
      }
      if (req.method === 'GET' && resource === 'documents') {
        if (!documentId) { send(res, 200, { documents: scoped(() => store.listDocuments(actorId, dealId)), scope }); return; }
        const file = scoped(() => store.readDocument(actorId, dealId, documentId)); assertCurrent();
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
          'Content-Length': file.bytes.length,
          'Content-Disposition': `attachment; filename="test-${file.document.id}.txt"` });
        res.end(file.bytes); return;
      }
      if (req.method !== 'POST' || documentId) throw fail('not_found', 404);
      if (resource === 'reviews') {
        fields(input, ['requestId', 'expectedVersion', 'expectedStateRevision', 'snapshotHash', 'score']);
        const result = scoped(() => store.review(actorId, dealId, input));
        res.setHeader('Location', `${PREFIX}/deals/${dealId}/reviews/${result.review.id}`);
        send(res, result.historical ? 200 : 201, { ...result, scope: PARTICIPANT_REPUTATION_SCOPE, dealScope: scope }); return;
      }
      if (store.signedTest && ['signature-intents', 'anchor-intents'].includes(resource)) {
        fields(input, resource === 'signature-intents' ? ['requestId', 'action', 'expectedVersion', 'expectedStateRevision', 'snapshotHash'] :
          ['expectedVersion', 'expectedStateRevision', 'snapshotHash']);
        const options = { assertCurrent };
        const intent = resource === 'signature-intents' ? store.createSignatureIntent(actorId, dealId, hash(session.key), input, options) :
          store.createAnchorIntent(actorId, dealId, hash(session.key), {
            requestId: randomUUID(), action: 'anchor_test_memo', ...input,
          }, options);
        send(res, 201, { intent: publicIntent(intent), scope }); return;
      }
      if (resource === 'invitations') {
        fields(input, ['expectedVersion', 'participantId']);
        send(res, 201, scoped(() => store.createInvitation(actorId, dealId, input))); return;
      }
      if (resource === 'versions') {
        fields(input, ['requestId', 'expectedVersion', 'scenario', 'quantity', 'amount', 'date']);
        send(res, 201, { deal: scoped(() => store.reviseDeal(actorId, dealId, input)) }); return;
      }
      if (resource === 'documents') {
        fields(input, ['requestId', 'expectedVersion', 'category', 'contentBase64']);
        const { contentBase64, ...metadata } = input;
        send(res, 201, { document: scoped(() => store.addDocument(actorId, dealId, { ...metadata, bytes: content(contentBase64) })) }); return;
      }
      if (resource === 'events') {
        fields(input, ['requestId', 'action', 'expectedVersion', 'expectedStateRevision', 'snapshotHash']);
        const result = scoped(() => store.action(actorId, dealId, input));
        send(res, result.historical ? 200 : 201, result); return;
      }
      throw fail('not_found', 404);
    } catch (error) {
      if (res.destroyed) return;
      const recognized = error instanceof ParticipantStoreError || error instanceof TestDocumentError ||
        error instanceof ParticipantSignatureError || error?.transportError === true;
      const status = recognized && [400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 503].includes(error.status) ? error.status : 503;
      const code = recognized ? error.code : 'unavailable';
      if (status === 429) res.setHeader('Retry-After', '60');
      send(res, status, { error: { code, message: code } });
    }
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.stopParticipantSessions = () => { stopping = true; sessions.clear(); buckets.clear(); };
  return server;
}

export async function startParticipantWorkspace({ directory = resolve(root, '.local/participant-test-cabinet'),
  port = 4177, now = Date.now, signatureSdk, memoConfiguration } = {}) {
  mkdirSync(resolve(root, '.local'), { recursive: true });
  const store = new ParticipantStore({ dbPath: resolve(directory, 'participants.sqlite'), now, signatureSdk, memoConfiguration });
  const server = createParticipantServer({ store, now });
  try { await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); }
  catch (error) { store.close(); throw error; }
  let closing;
  const close = () => closing ||= (async () => {
    server.stopParticipantSessions();
    await new Promise(resolve => server.close(resolve));
    store.close();
  })();
  return { store, server, close, url: `http://127.0.0.1:${server.address().port}/participants/` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const stand = await startParticipantWorkspace();
    process.stdout.write(`DalaHold local participant TEST: ${stand.url}\n`);
    const stop = () => stand.close().then(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch {
    process.stderr.write('Participant TEST unavailable; check private directory and loopback port.\n');
    process.exitCode = 1;
  }
}
