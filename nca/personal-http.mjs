// Bounded browser personal binding evidence only. A TEST session is NOT identity auth.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'dalahold_personal_test';
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE = 'test_personal_binding_only';
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (code, status) => Object.assign(new Error(code), { status });

function cookieToken(req) {
  const values = (req.headers.cookie || '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${COOKIE}=`)).map(part => part.slice(COOKIE.length + 1));
  return values.length === 1 && HEX.test(values[0]) ? values[0] : null;
}

export function createPersonalTestHandler({ bindings, inspect, readBody, now = Date.now }) {
  const sessions = new Map(); // server-issued only, bounded, lost safely on restart
  const sessionTtl = 15 * 60_000, windowMs = 60_000;
  const globals = new Map();
  let closed = false;
  let active = 0, drainResolve;
  const drained = new Promise(resolve => { drainResolve = resolve; });

  function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }
  function limit(buckets, kind, maximum) {
    const at = now(), current = buckets.get(kind);
    const bucket = !current || at >= current.reset ? { count: 0, reset: at + windowMs } : current;
    if (bucket.count >= maximum) throw Object.assign(error('personal_rate_limited', 429),
      { retryAfter: Math.max(1, Math.ceil((bucket.reset - at) / 1000)) });
    bucket.count++; buckets.set(kind, bucket);
  }
  function prune() {
    for (const [token, entry] of sessions) if (entry.expiresAt <= now()) sessions.delete(token);
  }
  function current(req) {
    const token = cookieToken(req), entry = token && sessions.get(token);
    if (closed || !entry || entry.expiresAt <= now()) throw error('personal_session_unavailable', 401);
    return { token, entry, assertCurrent() {
      if (closed || sessions.get(token) !== entry || entry.expiresAt <= now()) throw error('personal_session_unavailable', 401);
    } };
  }
  function csrf(req, entry) {
    const token = req.headers['x-dalahold-csrf'];
    if (typeof token !== 'string' || !HEX.test(token) ||
        !timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(entry.csrf, 'hex'))) throw error('personal_csrf_required', 403);
  }
  function caught(res, failure) {
    if (res.destroyed) return;
    const statuses = { personal_session_unavailable: 401, personal_csrf_required: 403,
      personal_rate_limited: 429, binding_storage_limit: 429,
      invalid_binding_submission: 400, invalid_binding_request: 400,
      content_type: 415, body_too_large: 413, invalid_body: 400,
      organization_binding_disabled: 422, binding_identity_rejected: 422,
      replacement_certificate_mismatch: 422, stale_or_foreign_binding: 409,
      same_certificate: 409, binding_not_found: 404,
      binding_replay_conflict: 409, certificate_rebind_required: 409, retired_certificate: 409,
      binding_intent_not_found: 404, binding_intent_expired: 410, binding_status_expired: 503,
      verifier_busy: 503, status_unavailable: 503 };
    const code = Object.hasOwn(statuses, failure?.message) ? failure.message : 'binding_state_unavailable';
    if (code === 'personal_rate_limited') res.setHeader('Retry-After', String(failure.retryAfter));
    if (code === 'binding_storage_limit') res.setHeader('Retry-After', '3600');
    if (code === 'verifier_busy') res.setHeader('Retry-After', '2');
    send(res, statuses[code] || 503, { error: code });
  }

  return {
    // Invoked only for the exact page GET after common Host/Origin/Fetch gates.
    openSession(req, res) {
      try {
        prune();
        if (closed) throw error('personal_session_unavailable', 401);
        const existing = cookieToken(req);
        if (existing && sessions.has(existing)) return true;
        limit(globals, 'sessions', 20);
        if (sessions.size >= 200) throw Object.assign(error('personal_rate_limited', 429), { retryAfter: 60 });
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { csrf: randomBytes(32).toString('hex'), expiresAt: now() + sessionTtl, limits: new Map() });
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtl / 1000}`);
        return true;
      } catch (failure) { caught(res, failure); return false; }
    },
    async handle(req, res, pathname) {
      active++;
      try {
        const session = current(req);
        const { entry, assertCurrent } = session;
        if (req.method === 'POST') csrf(req, entry);
        // Close is always usable even when verification/issuance is rate-limited.
        if (pathname === '/api/personal-test/session/close' && req.method === 'POST') {
          if (Object.keys(await readBody(req)).length) throw error('invalid_binding_request', 400);
          assertCurrent(); sessions.delete(session.token);
          res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
          return send(res, 200, { closed: true, scope: SCOPE });
        }
        if (pathname === '/api/personal-test/status' && req.method === 'GET') {
          limit(entry.limits, 'status', 10); limit(globals, 'status', 40);
          const status = await inspect(); assertCurrent();
          bindings.assertAvailable(); assertCurrent();
          return send(res, 200, { enabled: true, ready: true, scope: SCOPE,
            statusSource: status.statusSource, chain: status.chain, validUntil: status.validUntil,
            csrfToken: entry.csrf, sessionExpiresAt: entry.expiresAt });
        }
        if (pathname === '/api/personal-test/intents' && req.method === 'POST') {
          const input = await readBody(req);
          const keys = Object.keys(input).sort().join(',');
          const enroll = input.action === 'enroll_test_person' && keys === 'action';
          const replace = input.action === 'replace_test_certificate' &&
            keys === 'action,bindingId,newCertificateDigest' && typeof input.bindingId === 'string' &&
            UUID.test(input.bindingId) && typeof input.newCertificateDigest === 'string' &&
            HEX.test(input.newCertificateDigest);
          if (!enroll && !replace) throw error('invalid_binding_request', 400);
          assertCurrent();
          limit(entry.limits, 'issue', 3); limit(globals, 'issue', 12);
          await inspect(); assertCurrent();
          // ID/digest choose only the proposed target, never verified identity.
          // The store pins current epoch/old digest and requires a fresh eligible
          // CMS from the SAME personal identity and exact candidate before commit.
          const intent = bindings.createIntent(hash(session.token), input, { assertCurrent });
          return send(res, 201, { intent: { id: intent.id, text: intent.bytes.toString('utf8'),
            bytesBase64: intent.bytes.toString('base64'), hash: intent.hash, expiresAt: intent.expiresAt } });
        }
        if (pathname === '/api/personal-test/receipts' && req.method === 'POST') {
          const input = await readBody(req);
          if (Object.keys(input).sort().join(',') !== 'cms,intentId' || typeof input.intentId !== 'string' || !UUID.test(input.intentId) ||
              typeof input.cms !== 'string' || input.cms.length > 131072 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.cms)) throw error('invalid_binding_submission', 400);
          const cms = Buffer.from(input.cms, 'base64');
          if (!cms.length || cms.length > 98304 || cms.toString('base64') !== input.cms) throw error('invalid_binding_submission', 400);
          limit(entry.limits, 'submit', 8); limit(globals, 'submit', 24);
          const result = await bindings.submit(hash(session.token), { intentId: input.intentId, cms }, { assertCurrent });
          assertCurrent();
          // Whitelist only binding evidence; never forward opaque subject IDs,
          // mapping-key metadata, verifier extras, grants or wallet fields.
          const receipt = Object.fromEntries(['id', 'intentHash', 'action', 'bindingId', 'epoch',
            'certificateDigest', 'verifiedAt', 'validUntil', 'statusSource', 'scope'].map(field => [field, result.receipt[field]]));
          return send(res, 200, { receipt, historical: result.historical });
        }
        send(res, 404, { error: 'not_found' });
      } catch (failure) { caught(res, failure); }
      finally { active--; if (closed && active === 0) drainResolve(); }
    },
    close() {
      closed = true; sessions.clear(); globals.clear();
      if (active === 0) drainResolve();
      return drained;
    }
  };
}
