// Opt-in genuine bundled TEST SDK + loopback HTTP integration. This is one-sided
// exact-terms CMS evidence, not participant login, roles, two-party approval,
// corporate powers, certificate renewal, wallet/payment or manual NCALayer UAT.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createDraftServer } from '../web/server.mjs';
import { prepareSdk, javaProcess } from './sdk.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PRIVATE_FIELDS = ['personId', 'organizationId', 'iin', 'bin', 'subject', 'identity',
  'ownerId', 'mappingKeyId', 'powers', 'walletAddress', 'grant', 'sessionHash', 'cms'];
const RECEIPT_FIELDS = ['id', 'intentHash', 'dealId', 'termsVersion', 'termsFingerprint',
  'certificateDigest', 'verifiedAt', 'validUntil', 'statusSource', 'scope', 'action'];

function publicOnly(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => !PRIVATE_FIELDS.includes(key) && publicOnly(child));
}

async function bundledPassword(root) {
  // No README contents, password, CMS or subject is emitted on a load failure.
  try {
    const bytes = await readFile(join(root, 'Keys and Certs/Gost2015/README.txt'));
    const utf8 = bytes.toString('utf8');
    const text = utf8.includes('\ufffd') ? new TextDecoder('windows-1251').decode(bytes) : utf8;
    const password = /Пароль к тестовым сертификатам:\s*(\S+)/u.exec(text)?.[1];
    if (!password) throw new Error();
    return password;
  } catch { throw new Error('bundled_test_password_unavailable'); }
}

test('genuine TEST SDK through shared draft/documents/exact-terms HTTP boundary',
  { skip: !process.env.NCA_SDK_ROOT, timeout: 120_000 }, async t => {
    const root = process.env.NCA_SDK_ROOT;
    const java = process.env.NCA_JAVA_BIN || '/opt/homebrew/opt/openjdk@17/bin';
    const build = await mkdtemp(join(tmpdir(), 'dalahold-terms-sdk-http-'));
    let sdk, server;
    t.after(async () => {
      if (server?.listening) {
        await new Promise(resolve => server.close(resolve));
        await server.resourcesClosed;
      }
      await sdk?.close();
      await rm(build, { recursive: true, force: true });
    });
    const jars = ['Java/provider/kalkancrypt-0.7.8-current.jar', 'Java/utils/knca_provider_util-0.8.5.jar']
      .map(name => join(root, name)).join(delimiter);
    await javaProcess(join(java, 'javac'), ['-encoding', 'UTF-8', '-d', build, '-cp', jars,
      ...['CmsVerifier.java', 'OcspVerifier.java', 'TestCmsSigner.java']
        .map(name => fileURLToPath(new URL(name, import.meta.url)))]);
    const classpath = [build, jars].join(delimiter);
    const password = await bundledPassword(root);
    const sign = async (bytes, mode = 'sign') => {
      const output = (await javaProcess(join(java, 'java'),
        ['-cp', classpath, 'TestCmsSigner', root, mode, join(root, 'Keys and Certs/CRL')],
        `${password}\n${bytes.toString('base64')}\n`)).trim();
      // Boolean checks produce no CMS or password in assertion diagnostics.
      assert.ok(!output.startsWith('{') && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output),
        'bundled fixture must create genuine detached TEST CMS');
      const cms = Buffer.from(output, 'base64');
      assert.ok(cms.length > 0 && cms.length <= 98_304, 'genuine CMS must fit the HTTP boundary');
      return cms.toString('base64');
    };
    sdk = await prepareSdk({ sdkRoot: root, javaBin: java, statusSource: 'ocsp' });
    let available = true, verificationCalls = 0, genuineVerificationCalls = 0, inspectCalls = 0;
    const classifications = new Map();
    const countedSdk = { statusSource: sdk.statusSource,
      async inspect() {
        inspectCalls++;
        if (!available) throw new Error('verifier_unavailable');
        return sdk.inspect();
      },
      async verifyIdentity(bytes, cms, key) {
        verificationCalls++;
        if (!available) throw new Error('verifier_unavailable');
        genuineVerificationCalls++;
        const result = await sdk.verifyIdentity(bytes, cms, key);
        const classification = result.verified === true ? 'verified' : `${result.error || 'rejected'}:${result.reason || 'unspecified'}`;
        classifications.set(classification, (classifications.get(classification) || 0) + 1);
        return result;
      },
    };
    // Private parent and child directory are required by the actual server;
    // no existing draft, enrollment registry or protected checkpoint is opened.
    const dbPath = join(build, 'private-workspace', 'drafts.sqlite');
    server = createDraftServer({ dbPath, testWorkspace: { sdk: countedSdk } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const json = async (response, expected, label) => {
      assert.equal(response.status, expected, label);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return response.json();
    };
    const openSession = async () => {
      const response = await fetch(origin + '/api/test-workspace/status');
      const status = await json(response, 200, 'TEST workspace session/status opens');
      const header = response.headers.get('set-cookie');
      assert.ok(typeof header === 'string' && header.includes('HttpOnly') && header.includes('SameSite=Strict'), 'anonymous TEST session cookie is protected');
      assert.equal(status.scope, 'local_test_workspace_only');
      assert.equal(status.signing.ready, true, 'strict TEST OCSP must be available for this genuine integration test');
      assert.equal(status.signing.statusSource, 'test_ocsp');
      assert.ok(Number.isSafeInteger(status.signing.validUntil) && status.signing.validUntil > Date.now());
      return { cookie: header.split(';')[0], csrf: status.csrfToken };
    };
    const session = await openSession();
    const post = (path, body, current = session, method = 'POST') => fetch(origin + path, {
      method, headers: { Cookie: current.cookie, Origin: origin, 'Content-Type': 'application/json',
        'X-DalaHold-CSRF': current.csrf }, body: JSON.stringify(body) });
    const get = (path, current = session) => fetch(origin + path, { headers: { Cookie: current.cookie, Origin: origin } });
    const draft = { scenario: 'grain', quantity: 12, amount: 8_400_000, date: '2026-10-10' };
    const deal = (await json(await post('/api/deals', draft), 201, 'unsigned draft is created')).deal;
    const documentBytes = Buffer.from('ANONYMIZED TEST CONTRACT\nGrain fixture: 12 units; no participant identity or authority.\n', 'utf8');
    const upload = async (bytes, expectedVersion = 1, category = 'contract') =>
      (await json(await post(`/api/test-workspace/deals/${deal.id}/documents`, {
        requestId: randomUUID(), expectedVersion, category, bytesBase64: bytes.toString('base64'),
      }), 201, 'anonymized text attachment is persisted')).document;
    const document = await upload(documentBytes);
    assert.equal(document.sha256, hash(documentBytes));
    assert.equal(document.byteLength, documentBytes.length);
    assert.equal(document.scope, 'local_test_document_only');
    const issue = async (expectedVersion = 1, current = session) => {
      const intent = (await json(await post('/api/test-workspace/intents', {
        dealId: deal.id, expectedVersion,
      }, current), 201, 'exact current TEST terms intent is issued')).intent;
      const bytes = Buffer.from(intent.bytesBase64, 'base64');
      assert.ok(bytes.equals(Buffer.from(intent.text, 'utf8')), 'text and Base64 represent the same exact bytes');
      assert.equal(hash(bytes), intent.hash);
      const payload = JSON.parse(bytes.toString('utf8'));
      assert.equal(payload.domain, 'dalahold:test-terms-evidence:v1');
      assert.equal(payload.action, 'record_test_terms_signature');
      assert.equal(payload.statusSource, 'test_ocsp');
      assert.equal(payload.snapshot.terms.dealId, deal.id);
      assert.equal(payload.snapshot.terms.version, expectedVersion);
      return { ...intent, bytes, payload };
    };
    const submit = (intent, cms, current = session) => post('/api/test-workspace/receipts', { intentId: intent.id, cms }, current);
    const sql = (callback, writable = false) => {
      const db = new DatabaseSync(dbPath, { readOnly: !writable });
      try { return callback(db); } finally { db.close(); }
    };
    const counts = () => sql(db => ({
      receipts: db.prepare('SELECT count(*) AS n FROM terms_evidence_intents WHERE receipt_json IS NOT NULL').get().n,
      privateCmsRows: db.prepare('SELECT count(*) AS n FROM terms_evidence_intents WHERE cms IS NOT NULL').get().n,
      signedRows: db.prepare('SELECT count(*) AS n FROM terms_evidence_intents WHERE signature_hash IS NOT NULL').get().n,
      enrollmentTables: db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='personal_bindings'").get().n,
      privateReceiptFields: db.prepare(`SELECT count(*) AS n FROM terms_evidence_intents
        WHERE receipt_json LIKE '%personId%' OR receipt_json LIKE '%organizationId%'
        OR receipt_json LIKE '%mappingKeyId%' OR receipt_json LIKE '%walletAddress%'`).get().n,
    }));
    const oneReceipt = () => assert.deepEqual(counts(), {
      receipts: 1, privateCmsRows: 1, signedRows: 1, enrollmentTables: 0, privateReceiptFields: 0,
    });

    const firstIntent = await issue(), firstCms = await sign(firstIntent.bytes);
    assert.equal(firstIntent.payload.snapshot.termsFingerprint, deal.termsFingerprint);
    assert.deepEqual(firstIntent.payload.snapshot.documents, [{
      id: document.id, category: document.category, byteLength: document.byteLength, sha256: document.sha256,
    }]);
    const fresh = await json(await submit(firstIntent, firstCms), 200, 'genuine personal TEST CMS accepts once');
    assert.equal(fresh.historical, false);
    assert.deepEqual(Object.keys(fresh.receipt), RECEIPT_FIELDS);
    assert.equal(fresh.receipt.intentHash, firstIntent.hash);
    assert.equal(fresh.receipt.dealId, deal.id);
    assert.equal(fresh.receipt.termsVersion, 1);
    assert.equal(fresh.receipt.termsFingerprint, deal.termsFingerprint);
    assert.equal(fresh.receipt.scope, 'test_terms_evidence_only');
    assert.equal(fresh.receipt.action, 'record_test_terms_signature');
    assert.equal(fresh.receipt.statusSource, 'test_ocsp');
    assert.ok(/^[0-9a-f]{64}$/.test(fresh.receipt.certificateDigest));
    assert.ok(publicOnly(fresh), 'fresh receipt exposes no CMS, subject or authority');
    oneReceipt();
    const afterFreshCalls = verificationCalls;
    assert.deepEqual(await json(await submit(firstIntent, firstCms), 200, 'exact CMS retry returns original receipt'),
      { receipt: fresh.receipt, historical: true });
    assert.equal(verificationCalls, afterFreshCalls, 'exact retry does not invoke SDK verification');
    oneReceipt();

    const baseline = counts();
    const evidence = await json(await get(`/api/test-workspace/deals/${deal.id}/evidence`), 200, 'read-only scoped evidence is available');
    assert.equal(evidence.scope, 'local_test_workspace_only');
    assert.equal(evidence.signatures.length, 1);
    assert.deepEqual(evidence.signatures[0].receipt, fresh.receipt);
    assert.deepEqual(evidence.signatures[0].snapshot, firstIntent.payload.snapshot);
    assert.equal(evidence.signatures[0].currentMatches, true);
    assert.ok(publicOnly(evidence), 'read-only evidence exposes no private CMS, identity or authority');
    const download = await get(`/api/test-workspace/deals/${deal.id}/documents/${document.id}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.ok(download.headers.get('content-disposition').includes('.txt'));
    const downloadedBytes = Buffer.from(await download.arrayBuffer());
    assert.ok(downloadedBytes.equals(documentBytes), 'download returns the identical anonymized file bytes');
    assert.equal(hash(downloadedBytes), document.sha256);
    assert.deepEqual(counts(), baseline, 'read evidence and download mutate no signature storage');
    assert.equal(verificationCalls, afterFreshCalls, 'read operations invoke no verifier');

    const negativeIntent = await issue();
    let corporateRefusals = 0, statusRefusals = 0, changedByteRefusals = 0;
    for (const mode of ['legal-director', 'legal-signer']) {
      const refused = await json(await submit(negativeIntent, await sign(negativeIntent.bytes, mode)), 422,
        `genuine bundled ${mode} CMS grants no corporate authority`);
      assert.equal(refused.error, 'terms_signature_rejected'); corporateRefusals++; oneReceipt();
    }
    for (const mode of ['revoked', 'wrong-purpose']) {
      const response = await submit(negativeIntent, await sign(negativeIntent.bytes, mode));
      // Current adapter drops SDK rejection details and maps both to 422. A
      // status-preserving adapter may classify unavailable/revoked OCSP as 503;
      // neither classification permits a receipt or consumes accepted evidence.
      assert.ok([422, 503].includes(response.status), `genuine ${mode} CMS must refuse`);
      const body = await response.json();
      assert.ok(['terms_signature_rejected', 'status_unavailable', 'workspace_unavailable'].includes(body.error),
        'refusal stays within the documented verification/status classifications');
      statusRefusals++; oneReceipt();
    }
    const alteredCms = await sign(Buffer.concat([negativeIntent.bytes, Buffer.from('changed exact bytes')]), 'sign');
    assert.equal((await json(await submit(negativeIntent, alteredCms), 422, 'CMS over different bytes refuses')).error,
      'terms_signature_rejected');
    changedByteRefusals++; oneReceipt();

    const staleDocumentCms = await sign(negativeIntent.bytes);
    await upload(Buffer.from('ANONYMIZED TEST QUALITY FILE\nAdditional content changes the manifest.\n'), 1, 'quality');
    assert.equal((await json(await submit(negativeIntent, staleDocumentCms), 409, 'added file invalidates pending exact manifest')).error,
      'terms_snapshot_stale');
    oneReceipt();
    const revisionIntent = await issue(), revisionCms = await sign(revisionIntent.bytes);
    const revised = (await json(await post(`/api/deals/${deal.id}`, {
      ...draft, quantity: 13, expectedVersion: 1,
    }, session, 'PUT'), 200, 'unsigned draft revision creates version two')).deal;
    assert.equal(revised.version, 2);
    assert.equal((await json(await submit(revisionIntent, revisionCms), 409, 'new version invalidates pending exact terms')).error,
      'terms_snapshot_stale');
    oneReceipt();
    const historical = await json(await get(`/api/test-workspace/deals/${deal.id}/evidence`), 200, 'old signed snapshot remains readable after v2');
    assert.equal(historical.signatures.length, 1);
    assert.deepEqual(historical.signatures[0].snapshot, firstIntent.payload.snapshot);
    assert.deepEqual(historical.signatures[0].receipt, fresh.receipt);
    assert.equal(historical.signatures[0].currentMatches, false);

    // Controlled persisted expiry fixture, not elapsed-clock or OCSP freshness
    // evidence. Only this private unsigned intent is rewritten canonically;
    // accepted receipts and their local integrity data remain untouched.
    const expiredIntent = await issue(2);
    const expiredPayload = { ...expiredIntent.payload, issuedAt: Date.now() - 300_001 };
    expiredPayload.expiresAt = expiredPayload.issuedAt + 300_000;
    const expiredBytes = Buffer.from(JSON.stringify(expiredPayload, null, 2) + '\n');
    sql(db => db.prepare(`UPDATE terms_evidence_intents SET bytes=?,bytes_hash=?,expires_at=?
      WHERE id=? AND receipt_json IS NULL`).run(expiredBytes, hash(expiredBytes), expiredPayload.expiresAt, expiredIntent.id), true);
    const beforeExpiredCalls = verificationCalls;
    assert.equal((await json(await submit(expiredIntent, await sign(expiredBytes)), 410, 'expired persisted pending intent refuses')).error,
      'terms_intent_expired');
    assert.equal(verificationCalls, beforeExpiredCalls, 'expired intent is rejected before SDK verification'); oneReceipt();

    const unavailableIntent = await issue(2), unavailableCms = await sign(unavailableIntent.bytes);
    const closedSession = await openSession(), closedIntent = await issue(2, closedSession), closedCms = await sign(closedIntent.bytes);
    available = false;
    const refusedFreshIssue = await post('/api/test-workspace/intents', { dealId: deal.id, expectedVersion: 2 }, closedSession);
    assert.equal(refusedFreshIssue.status, 503, 'unavailable SDK status cannot issue a fresh intent');
    assert.equal((await submit(unavailableIntent, unavailableCms)).status, 503, 'unavailable SDK cannot accept fresh CMS');
    oneReceipt();
    const beforeUnavailableRetry = verificationCalls;
    assert.deepEqual(await json(await submit(firstIntent, firstCms), 200, 'accepted exact CMS still recovers during SDK outage'),
      { receipt: fresh.receipt, historical: true });
    assert.equal(verificationCalls, beforeUnavailableRetry, 'historical outage retry performs no new verification');
    assert.equal((await json(await post('/api/test-workspace/session/close', {}, closedSession), 200, 'pending TEST session closes')).closed, true);
    const beforeClosedCalls = verificationCalls;
    assert.equal((await submit(closedIntent, closedCms, closedSession)).status, 401, 'closed session cannot accept its pending genuine CMS');
    assert.equal(verificationCalls, beforeClosedCalls, 'closed session is rejected before verification'); oneReceipt();

    assert.equal(corporateRefusals, 2); assert.equal(statusRefusals, 2); assert.equal(changedByteRefusals, 1);
    assert.ok(genuineVerificationCalls >= 8 && classifications.get('verified') >= 5,
      'positive and corporate/stale negatives reached genuine SDK verification');
    assert.ok([...classifications.keys()].some(key => key.startsWith('status_unavailable:')),
      'revoked fixture reached genuine strict TEST status verification');
    t.diagnostic(`Genuine bundled TEST SDK HTTP: one receipt, two corporate refusals, two status/purpose refusals, one altered-byte refusal, manifest/version stale refusals, persisted-expiry/session-close/outage refusals; SDK verifications=${genuineVerificationCalls}, total attempts=${verificationCalls}, status checks=${inspectCalls}. Exact retry/read/download add no receipt. Expiry uses a private persisted fixture. No manual NCALayer UAT, two-party approval, roles/auth, renewal, wallet or payment.`);
  });
