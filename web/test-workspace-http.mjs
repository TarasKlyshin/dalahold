// Anonymous loopback TEST resources. Session/CSRF are not participant identity.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'dalahold_workspace_test';
const SCOPE = 'local_test_workspace_only';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, status) => Object.assign(new Error(code), { status });

async function jsonBody(req, maxBytes = 370_000, timeoutMs = 15_000) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || ''))
    throw failure('content_type', 415);
  const chunks = []; let size = 0;
  const timeout = setTimeout(() => req.destroy(new Error('body_timeout')), timeoutMs);
  timeout.unref();
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw failure('body_too_large', 413);
      chunks.push(chunk);
    }
  } finally { clearTimeout(timeout); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw failure('invalid_request', 400); }
}

function base64(value, maximum) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw failure('invalid_request', 400);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value)
    throw failure('invalid_request', 400);
  return bytes;
}

export function createTestWorkspaceHandler({ documents, terms, readSnapshot, readDeal,
  fixtureProvider = () => null, inspect = async () => null, now = Date.now,
  bodyTimeoutMs = 15_000 }) {
  if (!Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 10 || bodyTimeoutMs > 15_000)
    throw new Error('invalid_body_timeout');
  const sessions = new Map(), globalLimits = new Map();
  let stopped = false, active = 0, resolveDrain;
  const drained = new Promise(resolve => { resolveDrain = resolve; });
  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  function limit(map, name, maximum) {
    let bucket = map.get(name);
    if (!bucket || now() >= bucket.until) bucket = { count: 0, until: now() + 60_000 };
    if (bucket.count >= maximum) throw Object.assign(failure('workspace_rate_limited', 429),
      { retryAfter: Math.max(1, Math.ceil((bucket.until - now()) / 1000)) });
    bucket.count++; map.set(name, bucket);
  }
  function signingReady(status) {
    if (status?.ready !== true || status.statusSource !== 'test_ocsp' ||
        !Number.isSafeInteger(status.validUntil) || status.validUntil <= now() ||
        !Array.isArray(status.chain) || status.chain.length !== 2 ||
        !status.chain.every(item => typeof item === 'string' && item.startsWith('-----BEGIN CERTIFICATE-----')))
      throw failure('status_unavailable',503);
    return {ready:true,statusSource:'test_ocsp',chain:status.chain,validUntil:status.validUntil};
  }
  function token(req) {
    const values = (req.headers.cookie || '').split(';').map(value => value.trim())
      .filter(value => value.startsWith(`${COOKIE}=`)).map(value => value.slice(COOKIE.length + 1));
    return values.length === 1 && HEX.test(values[0]) ? values[0] : null;
  }
  function current(req, res) {
    const key = token(req), entry = key && sessions.get(key);
    const assertCurrent = () => {
      if (stopped || !entry || sessions.get(key) !== entry || entry.expiresAt <= now() ||
          req.aborted || res.destroyed) throw failure('workspace_session_unavailable', 401);
    };
    assertCurrent(); return { key, entry, assertCurrent };
  }
  function open(req, res) {
    if (stopped) throw failure('workspace_session_unavailable', 401);
    for (const [key, entry] of sessions) if (entry.expiresAt <= now()) sessions.delete(key);
    if (token(req) && sessions.has(token(req))) return;
    limit(globalLimits, 'sessions', 20);
    if (sessions.size >= 200) throw Object.assign(failure('workspace_rate_limited', 429), { retryAfter: 60 });
    const key = randomBytes(32).toString('hex');
    sessions.set(key, { csrf: randomBytes(32).toString('hex'), expiresAt: now() + 900_000, limits: new Map() });
    res.setHeader('Set-Cookie', `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`);
    return { key, entry: sessions.get(key), assertCurrent() {
      if (stopped || sessions.get(key)?.expiresAt <= now() || !sessions.has(key) || res.destroyed)
        throw failure('workspace_session_unavailable', 401);
    } };
  }
  function caught(res, error) {
    if (res.destroyed) return;
    const known = new Set(['content_type','body_too_large','invalid_request','not_found',
      'invalid_document','stale_draft','idempotency_conflict','document_limit','storage_limit','document_corrupt',
      'workspace_rate_limited','workspace_session_unavailable','workspace_csrf_required',
      'local_origin_required','status_unavailable','verifier_busy','evidence_corrupt',
      'terms_request_invalid','terms_submission_invalid','terms_deal_not_found','terms_intent_not_found',
      'terms_snapshot_stale','terms_intent_expired','terms_signature_rejected','terms_replay_conflict',
      'terms_intent_changed','terms_receipt_changed','terms_state_changed','terms_snapshot_invalid',
      'terms_pending_limit','terms_history_limit','terms_store_closed','terms_status_expired']);
    const candidate = error?.code || error?.message;
    const code = known.has(candidate) ? candidate : 'workspace_unavailable';
    const fallback = { invalid_request:400, content_type:415, body_too_large:413,
      not_found:404, workspace_session_unavailable:401, workspace_csrf_required:403,
      local_origin_required:403, workspace_rate_limited:429, status_unavailable:503,
      verifier_busy:503, evidence_corrupt:409, invalid_document:400,
      terms_request_invalid:400, terms_submission_invalid:400, terms_deal_not_found:404,
      terms_intent_not_found:404, terms_snapshot_stale:409, terms_intent_expired:410,
      terms_signature_rejected:422, terms_replay_conflict:409, terms_intent_changed:409,
      terms_receipt_changed:409, terms_state_changed:409, terms_snapshot_invalid:409,
      terms_pending_limit:429, terms_history_limit:429, terms_store_closed:503, terms_status_expired:503 };
    const status = fallback[code] || ([400,404,409,410,413,422,429,503].includes(error?.status) ? error.status : 503);
    if (status === 429 || code === 'verifier_busy') res.setHeader('Retry-After', String(error.retryAfter || 2));
    send(res, status, { error: code });
  }
  return {
    async handle(req, res, pathname, expectedHost) {
      if (!pathname.startsWith('/api/test-workspace/')) return false;
      active++;
      try {
        const origin = `http://${expectedHost}`;
        if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== origin) ||
            (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) ||
            (req.method === 'POST' && req.headers.origin !== origin)) throw failure('local_origin_required', 403);
        const isStatus = pathname === '/api/test-workspace/status' && req.method === 'GET';
        const session = (isStatus && open(req, res)) || current(req, res);
        const { entry, assertCurrent } = session;
        if (req.method === 'POST') {
          const csrf = req.headers['x-dalahold-csrf'];
          if (typeof csrf !== 'string' || !HEX.test(csrf) ||
              !timingSafeEqual(Buffer.from(csrf,'hex'), Buffer.from(entry.csrf,'hex')))
            throw failure('workspace_csrf_required', 403);
        }
        if (pathname === '/api/test-workspace/session/close' && req.method === 'POST') {
          if (Object.keys(await jsonBody(req, 4096, bodyTimeoutMs)).length) throw failure('invalid_request', 400);
          assertCurrent(); sessions.delete(session.key);
          res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
          send(res,200,{closed:true,scope:SCOPE}); return true;
        }
        if (isStatus) {
          limit(entry.limits,'status',10); limit(globalLimits,'status',40);
          let signing;
          try {
            const status = await inspect(); assertCurrent();
            signing = signingReady(status);
          } catch { signing = {ready:false,error:'status_unavailable'}; }
          assertCurrent(); send(res,200,{scope:SCOPE,csrfToken:entry.csrf,sessionExpiresAt:entry.expiresAt,signing}); return true;
        }
        if (pathname === '/api/test-workspace/intents' && req.method === 'POST') {
          const input = await jsonBody(req,4096,bodyTimeoutMs);
          if (Object.keys(input).sort().join(',') !== 'dealId,expectedVersion' ||
              typeof input.dealId !== 'string' || !UUID.test(input.dealId) ||
              !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw failure('invalid_request',400);
          limit(entry.limits,'issue',5); limit(globalLimits,'issue',20);
          const status = await inspect(); assertCurrent();
          signingReady(status);
          const intent = terms.createIntent(digest(session.key),input,{assertCurrent});
          send(res,201,{intent:{id:intent.id,text:intent.bytes.toString('utf8'),bytesBase64:intent.bytes.toString('base64'),hash:intent.hash,expiresAt:intent.expiresAt}}); return true;
        }
        if (pathname === '/api/test-workspace/receipts' && req.method === 'POST') {
          const input = await jsonBody(req,140_000,bodyTimeoutMs);
          if (Object.keys(input).sort().join(',') !== 'cms,intentId' || typeof input.intentId !== 'string' || !UUID.test(input.intentId))
            throw failure('invalid_request',400);
          const cms = base64(input.cms,98304); assertCurrent();
          limit(entry.limits,'submit',12); limit(globalLimits,'submit',40);
          send(res,200,await terms.submit(digest(session.key),{intentId:input.intentId,cms},{assertCurrent})); return true;
        }
        const match = /^\/api\/test-workspace\/deals\/([^/]+)\/(evidence|documents)(?:\/([^/]+))?$/.exec(pathname);
        if (!match || !UUID.test(match[1]) || (match[3] && !UUID.test(match[3]))) throw failure('not_found',404);
        const [,dealId,resource,documentId] = match;
        if (req.method === 'GET') {
          limit(entry.limits,'read',60); limit(globalLimits,'read',200);
          if (resource === 'evidence' && !documentId) {
            const deal = readDeal(dealId); if (!deal) throw failure('not_found',404);
            const snapshot = readSnapshot(dealId);
            const signatures = terms.list(dealId).map(value => ({...value,
              currentMatches: JSON.stringify(value.snapshot) === JSON.stringify(snapshot)}));
            let offlineEvidence;
            try { offlineEvidence = fixtureProvider(dealId) || null; }
            catch { throw failure('evidence_corrupt',409); }
            assertCurrent(); send(res,200,{scope:SCOPE,deal,terms:snapshot.terms,documents:documents.list(dealId,deal.version),signatures,offlineEvidence}); return true;
          }
          if (resource === 'documents' && documentId) {
            const value = documents.read(dealId,documentId); assertCurrent();
            res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store',
              'X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename="test-${value.document.id}.txt"`,
              'Content-Length':value.bytes.length}); res.end(value.bytes); return true;
          }
        }
        if (req.method === 'POST' && resource === 'documents' && !documentId) {
          const input = await jsonBody(req,370_000,bodyTimeoutMs);
          if (Object.keys(input).sort().join(',') !== 'bytesBase64,category,expectedVersion,requestId') throw failure('invalid_request',400);
          const bytes = base64(input.bytesBase64,262144); assertCurrent();
          limit(entry.limits,'upload',10); limit(globalLimits,'upload',30);
          const document = documents.add({dealId,expectedVersion:input.expectedVersion,requestId:input.requestId,category:input.category,bytes});
          send(res,201,{document}); return true;
        }
        throw failure('not_found',404);
      } catch (error) { caught(res,error); return true; }
      finally { active--; if(stopped && !active) resolveDrain(); }
    },
    async close() { stopped = true; sessions.clear(); if(!active) resolveDrain(); await drained; terms.close(); },
  };
}
