// Local unsigned-draft demo. This is not an NCA verifier or a payment API.
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeMarkerInput } from './markers.mjs';
import { fingerprintDraftTerms } from './terms.mjs';
import { TestDocuments } from './test-documents.mjs';
import { TermsEvidence } from '../nca/terms-evidence.mjs';
import { createTestWorkspaceHandler } from './test-workspace-http.mjs';
import { preparePrivateTestDatabase } from './private-test-store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function send(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function validDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'amount,date,quantity,scenario' ||
      !['livestock', 'grain'].includes(value.scenario) ||
      !Number.isSafeInteger(value.quantity) || value.quantity < 1 || value.quantity > 100_000 ||
      !Number.isSafeInteger(value.amount) || value.amount < 1 || value.amount > 999_999_999_999 ||
      typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return false;
  const parsed = new Date(`${value.date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.date;
}

async function readDraft(req, update = false) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
    return { error: 'content_type', status: 415 };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) return { error: 'body_too_large', status: 413 };
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (update) {
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
        return { error: 'invalid_draft', status: 400 };
      }
      const { expectedVersion, ...draft } = body;
      return validDraft(draft) ? { draft, expectedVersion } : { error: 'invalid_draft', status: 400 };
    }
    return validDraft(body) ? { draft: body } : { error: 'invalid_draft', status: 400 };
  } catch {
    return { error: 'invalid_json', status: 400 };
  }
}

async function readMarker(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
    return { error: 'content_type', status: 415 };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) return { error: 'body_too_large', status: 413 };
    chunks.push(chunk);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { error: 'invalid_json', status: 400 };
  }
}

export function createDraftServer({ dbPath, testWorkspace = null }) {
  if (typeof dbPath !== 'string' || !dbPath) throw new Error('dbPath required');
  if (testWorkspace) dbPath = preparePrivateTestDatabase(dbPath);
  else mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const identityKey = testWorkspace ? randomBytes(32) : null;
  try {
  db.exec(`
    PRAGMA journal_mode = ${testWorkspace ? 'DELETE' : 'WAL'};
    PRAGMA synchronous = FULL;
    PRAGMA mmap_size = 0;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      scenario TEXT NOT NULL CHECK (scenario IN ('livestock', 'grain')),
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
      amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 999999999999),
      date TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
  `);
  if (!db.prepare('PRAGMA table_info(drafts)').all().some((column) => column.name === 'version')) {
    db.exec('ALTER TABLE drafts ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS draft_versions (
      deal_id TEXT NOT NULL REFERENCES drafts(id),
      version INTEGER NOT NULL CHECK (version >= 1),
      scenario TEXT NOT NULL CHECK (scenario IN ('livestock', 'grain')),
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
      amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 999999999999),
      date TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      PRIMARY KEY (deal_id, version)
    ) STRICT;
    INSERT OR IGNORE INTO draft_versions (deal_id, version, scenario, quantity, amount, date, changed_at)
      SELECT id, version, scenario, quantity, amount, date, created_at FROM drafts;
    CREATE TABLE IF NOT EXISTS document_markers (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES drafts(id),
      terms_version INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      category TEXT NOT NULL,
      context TEXT NOT NULL,
      note TEXT NOT NULL,
      claimed_role TEXT NOT NULL CHECK (claimed_role IN ('seller', 'buyer')),
      file_kind TEXT NOT NULL CHECK (file_kind IN ('pdf', 'image', 'word', 'spreadsheet')),
      created_at INTEGER NOT NULL,
      UNIQUE (deal_id, request_id),
      FOREIGN KEY (deal_id, terms_version) REFERENCES draft_versions(deal_id, version)
    ) STRICT;
  `);
  const list = db.prepare('SELECT id, scenario, quantity, amount, date, created_at AS createdAt, version FROM drafts ORDER BY created_at DESC, rowid DESC LIMIT 100');
  const insert = db.prepare('INSERT INTO drafts (id, scenario, quantity, amount, date, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const find = db.prepare('SELECT id, scenario, quantity, amount, date, created_at AS createdAt, version FROM drafts WHERE id = ?');
  const insertVersion = db.prepare('INSERT INTO draft_versions (deal_id, version, scenario, quantity, amount, date, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const versions = db.prepare('SELECT version, scenario, quantity, amount, date, changed_at AS changedAt FROM draft_versions WHERE deal_id = ? ORDER BY version DESC');
  const findVersionScenario = db.prepare('SELECT scenario FROM draft_versions WHERE deal_id = ? AND version = ?');
  const revise = db.prepare('UPDATE drafts SET scenario = ?, quantity = ?, amount = ?, date = ?, version = ? WHERE id = ? AND version = ?');
  const markerColumns = `m.id, m.deal_id AS dealId, m.terms_version AS termsVersion,
    m.request_id AS requestId, m.category, m.context, m.note,
    m.claimed_role AS claimedRole, m.file_kind AS fileKind, m.created_at AS createdAt,
    v.scenario, v.quantity, v.amount, v.date`;
  const markerJoin = 'FROM document_markers m JOIN draft_versions v ON v.deal_id = m.deal_id AND v.version = m.terms_version';
  const listMarkers = db.prepare(`SELECT ${markerColumns} ${markerJoin} WHERE m.deal_id = ? ORDER BY m.terms_version DESC, m.created_at DESC, m.rowid DESC`);
  const findMarkerByRequest = db.prepare(`SELECT ${markerColumns} ${markerJoin} WHERE m.deal_id = ? AND m.request_id = ?`);
  const insertMarker = db.prepare(`INSERT INTO document_markers
    (id, deal_id, terms_version, request_id, category, context, note, claimed_role, file_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function withFingerprint(row, dealId = row?.id) {
    if (!row) return row;
    const { version, scenario, quantity, amount, date } = row;
    return {
      ...row,
      termsFingerprint: fingerprintDraftTerms({ dealId, version, scenario, quantity, amount, date }),
    };
  }

  function publicMarker(row) {
    const { scenario, quantity, amount, date, ...marker } = row;
    return { ...marker, termsScenario: scenario, termsFingerprint: fingerprintDraftTerms({
      dealId: marker.dealId, version: marker.termsVersion, scenario, quantity, amount, date,
    }) };
  }

  function addMarker(id, value) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = find.get(id);
      if (!current) { db.exec('COMMIT'); return { status: 404, error: 'not_found' }; }
      const existing = value && typeof value === 'object' &&
        Object.hasOwn(value, 'requestId') && typeof value.requestId === 'string'
        ? findMarkerByRequest.get(id, value.requestId) : undefined;
      const requestedScenario = !existing && value && typeof value === 'object' &&
        Number.isSafeInteger(value.expectedVersion) && value.expectedVersion > 0
        ? findVersionScenario.get(id, value.expectedVersion)?.scenario : undefined;
      let input;
      try { input = normalizeMarkerInput(value, existing?.scenario || requestedScenario || current.scenario); }
      catch { db.exec('COMMIT'); return { status: 400, error: 'invalid_marker' }; }
      if (existing) {
        const same = existing.termsVersion === input.expectedVersion &&
          ['category', 'context', 'note', 'claimedRole', 'fileKind'].every(
            (field) => existing[field] === input[field]);
        db.exec('COMMIT');
        return same
          ? { status: 200, marker: publicMarker(existing) }
          : { status: 409, error: 'idempotency_conflict' };
      }
      if (current.version !== input.expectedVersion) {
        db.exec('COMMIT');
        return { status: 409, error: 'stale_draft', current: withFingerprint(current) };
      }
      const markerId = randomUUID();
      insertMarker.run(markerId, id, current.version, input.requestId, input.category,
        input.context, input.note, input.claimedRole, input.fileKind, Date.now());
      const marker = publicMarker(findMarkerByRequest.get(id, input.requestId));
      db.exec('COMMIT');
      return { status: 201, marker };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function reviseDraft(id, draft, expectedVersion) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = find.get(id);
      if (!current) { db.exec('COMMIT'); return { status: 404, error: 'not_found' }; }
      if (current.version !== expectedVersion) {
        db.exec('COMMIT');
        return { status: 409, error: 'stale_draft', current: withFingerprint(current) };
      }
      if (['scenario', 'quantity', 'amount', 'date'].every((field) => current[field] === draft[field])) {
        db.exec('COMMIT');
        return { status: 200, deal: withFingerprint(current) };
      }
      const next = current.version + 1;
      const { scenario, quantity, amount, date } = draft;
      revise.run(scenario, quantity, amount, date, next, id, expectedVersion);
      insertVersion.run(id, next, scenario, quantity, amount, date, Date.now());
      const deal = find.get(id);
      db.exec('COMMIT');
      return { status: 200, deal: withFingerprint(deal) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  let workspace, documents, terms;
  let sdkActive = 0;
  const runSdk = async fn => {
    if (sdkActive >= 2) throw Object.assign(new Error('verifier_busy'), { status: 503 });
    sdkActive++;
    try { return await fn(); } finally { sdkActive--; }
  };
  if (testWorkspace) {
      documents = new TestDocuments({ db });
      const readSnapshot = dealId => {
        const row = find.get(dealId);
        if (!row) throw new Error('terms_deal_not_found');
        const { version, scenario, quantity, amount, date } = row;
        const archived = db.prepare('SELECT version,scenario,quantity,amount,date FROM draft_versions WHERE deal_id=? AND version=?').get(dealId,version);
        if (!archived || ['version','scenario','quantity','amount','date'].some(field => archived[field] !== row[field]))
          throw Object.assign(new Error('evidence_corrupt'), { status:409 });
        const terms = { dealId, version, scenario, quantity, amount, date };
        return { terms, termsFingerprint:fingerprintDraftTerms(terms), documents:documents.manifest(dealId,version) };
      };
      const sdk = testWorkspace.sdk;
      const inspect = async () => sdk?.statusSource === 'test_ocsp' ? runSdk(() => sdk.inspect()) : null;
      terms = new TermsEvidence({ db, readSnapshot, verify:async (bytes,cms) => {
        if (sdk?.statusSource !== 'test_ocsp') return { verified:false };
        const result = await runSdk(() => sdk.verifyIdentity(bytes,cms,identityKey));
        // Only classification is needed. Opaque subject IDs are NOT persisted or
        // exposed, and this process-local mapping key creates no account binding.
        return { verified:result.verified, statusSource:result.statusSource,
          certificateDigest:result.certificateDigest, validUntil:result.validUntil,
          personal: result.verified === true && result.identity?.schema === 'nca_test_subject_v1' &&
            result.identity.organizationId === null && typeof result.identity.personId === 'string' &&
            /^person:[a-f0-9]{64}$/.test(result.identity.personId) };
      } });
      workspace = createTestWorkspaceHandler({ documents, terms, readSnapshot,
        readDeal:dealId => withFingerprint(find.get(dealId)), inspect,
        fixtureProvider:testWorkspace.fixtureProvider, bodyTimeoutMs:testWorkspace.bodyTimeoutMs });
  }
  const workspaceAssets = new Map([
    ['/test-workspace/', ['web/test-workspace.html','text/html; charset=utf-8']],
    ['/test-workspace/client.mjs', ['web/test-workspace-client.mjs','text/javascript; charset=utf-8']],
    ['/test-workspace/styles.css', ['web/test-workspace.css','text/css; charset=utf-8']],
    ['/nca-client.mjs', ['nca/client.mjs','text/javascript; charset=utf-8']],
  ]);
  const server = createServer(async (req, res) => {
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    if (req.headers.host !== expectedHost ||
        (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) {
      send(res, 403, { error: 'local_origin_required' });
      return;
    }
    const pathname = new URL(req.url, `http://${expectedHost}`).pathname;
    try {
      if (workspace && await workspace.handle(req,res,pathname,expectedHost)) return;
      if (workspace && req.method === 'GET' && workspaceAssets.has(pathname)) {
        const [name,contentType] = workspaceAssets.get(pathname);
        const body = await readFile(resolve(root,name));
        res.writeHead(200,{'Content-Type':contentType,'Cache-Control':'no-store',
          'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss://127.0.0.1:13579; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"});
        res.end(body); return;
      }
      if (pathname === '/api/deals' && req.method === 'GET') {
        send(res, 200, { deals: list.all().map((deal) => withFingerprint(deal)) });
      } else if (pathname === '/api/deals' && req.method === 'POST') {
        const parsed = await readDraft(req);
        if (parsed.error) return send(res, parsed.status, { error: parsed.error });
        const { scenario, quantity, amount, date } = parsed.draft;
        const id = randomUUID();
        const createdAt = Date.now();
        db.exec('BEGIN IMMEDIATE');
        try {
          insert.run(id, scenario, quantity, amount, date, createdAt);
          insertVersion.run(id, 1, scenario, quantity, amount, date, createdAt);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        send(res, 201, { deal: withFingerprint(find.get(id)) });
      } else if (/^\/api\/deals\/[0-9a-f-]{36}\/versions$/.test(pathname) && req.method === 'GET') {
        const id = pathname.slice('/api/deals/'.length, -'/versions'.length);
        const deal = find.get(id);
        send(res, deal ? 200 : 404, deal
          ? { versions: versions.all(id).map((version) => withFingerprint(version, id)) }
          : { error: 'not_found' });
      } else if (/^\/api\/deals\/[0-9a-f-]{36}\/markers$/.test(pathname) && req.method === 'GET') {
        const id = pathname.slice('/api/deals/'.length, -'/markers'.length);
        const deal = find.get(id);
        send(res, deal ? 200 : 404, deal
          ? { markers: listMarkers.all(id).map(publicMarker) }
          : { error: 'not_found' });
      } else if (/^\/api\/deals\/[0-9a-f-]{36}\/markers$/.test(pathname) && req.method === 'POST') {
        const id = pathname.slice('/api/deals/'.length, -'/markers'.length);
        const parsed = await readMarker(req);
        if (parsed.error) return send(res, parsed.status, { error: parsed.error });
        const outcome = addMarker(id, parsed.value);
        const { status, ...body } = outcome;
        send(res, status, body);
      } else if (/^\/api\/deals\/[0-9a-f-]{36}$/.test(pathname) && req.method === 'PUT') {
        const id = pathname.slice('/api/deals/'.length);
        const parsed = await readDraft(req, true);
        if (parsed.error) return send(res, parsed.status, { error: parsed.error });
        const outcome = reviseDraft(id, parsed.draft, parsed.expectedVersion);
        const { status, ...body } = outcome;
        send(res, status, body);
      } else if (pathname.startsWith('/api/deals/') && req.method === 'GET') {
        const id = pathname.slice('/api/deals/'.length);
        const deal = /^[0-9a-f-]{36}$/.test(id) ? find.get(id) : undefined;
        send(res, deal ? 200 : 404, deal ? { deal: withFingerprint(deal) } : { error: 'not_found' });
      } else if (req.method === 'GET' && assets.has(pathname)) {
        const [name, contentType] = assets.get(pathname);
        let body = await readFile(resolve(root, 'prototype', name));
        if (workspace && name === 'index.html') body = Buffer.from(body.toString('utf8').replace('<body>','<body data-test-workspace="enabled">'));
        res.writeHead(200, {
          'Content-Type': contentType, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(body);
      } else if (pathname === '/favicon.ico' && req.method === 'GET') {
        res.writeHead(204); res.end();
      } else {
        send(res, 404, { error: 'not_found' });
      }
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'server_error' });
      else res.end();
    }
  });
  server.workspaceShutdown = () => workspace?.close();
  let resolveResources;
  server.resourcesClosed = new Promise(resolve => { resolveResources = resolve; });
  server.on('close', async () => {
    try { await workspace?.close(); } finally { identityKey?.fill(0); db.close(); resolveResources(); }
  });
  return server;
  } catch (error) {
    identityKey?.fill(0);
    db.close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createDraftServer({ dbPath: resolve(root, '.local', 'drafts.sqlite') });
  server.listen(4174, '127.0.0.1', () => {
    process.stdout.write('DalaHold unsigned drafts: http://127.0.0.1:4174/\n');
  });
}
