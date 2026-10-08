// Reproducible anonymous unsigned participant TEST demo.
//
// This command prepares fresh local TEST data through the real HTTP API. It
// deliberately has no certificate, signer, SDK, Solana or retained-state
// capability. Bearer codes remain in memory until the owner-only operator file
// is written; reports and evidence are safe to share.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { types } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyParticipantEvidence } from './participant-evidence.mjs';
import { startParticipantRuntime } from './participant-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const API = '/api/participants/v1';
const DEFAULT_PORT = 4177;
const RUN_PREFIX = 'participant-demo-';
const REPORT_FILE = 'run-report.json';
const CODES_FILE = 'operator-access.json';
const ACCEPTED_EVIDENCE_FILE = 'accepted-evidence.json';
const DISPUTED_EVIDENCE_FILE = 'disputed-evidence.json';
const HEX = /^[a-f0-9]{64}$/;
const SAFE_CODE = /^[a-z0-9_]+$/;
const SECRET_MARKERS = Object.freeze([
  'accessCode', 'csrfToken', 'sessionHash', 'cms', 'mappingKey', 'cookie', 'set-cookie',
]);
const DEMO_OPTION_KEYS = Object.freeze(['runDirectory', 'port', 'now']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ensure(condition, code) {
  if (!condition) throw fail(code);
}

// Validate the raw public API value before reading configurable properties or
// touching the filesystem/network. CLI-only flags intentionally are not part
// of this unsigned preparation API.
function exactDemoOptions(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('demo_options_invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.length > DEMO_OPTION_KEYS.length || keys.some(key => typeof key !== 'string' || !DEMO_OPTION_KEYS.includes(key)))
    throw fail('demo_options_invalid');
  const output = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || types.isProxy(descriptor.value))
      throw fail('demo_options_invalid');
    output[key] = descriptor.value;
  }
  return output;
}

function ownerId() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function owner(stat) {
  const uid = ownerId();
  return uid === null || stat.uid === uid;
}

function privateParent(path) {
  let stat;
  try { stat = lstatSync(path); } catch { throw fail('demo_parent_required'); }
  if (stat.isSymbolicLink()) {
    try { path = realpathSync(path); stat = lstatSync(path); } catch { throw fail('demo_parent_required'); }
  }
  if (!stat.isDirectory() || !owner(stat) || (stat.mode & 0o022)) throw fail('demo_parent_required');
  return path;
}

function reservedPath(path) {
  return path.split('/').some(segment => /^(?:participant-test-cabinet|signed-participant-test-cabinet|nca-personal-bindings(?:-|$)|personal[-_].*checkpoint)/i.test(segment));
}

function requestedFreshPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('demo_directory_required');
  const requested = resolve(value);
  if (reservedPath(requested)) throw fail('demo_directory_reserved');
  try {
    lstatSync(requested);
    throw fail('demo_target_exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = privateParent(dirname(requested));
  const target = join(parent, basename(requested));
  if (reservedPath(target)) throw fail('demo_directory_reserved');
  return target;
}

function createDefaultRunDirectory() {
  const localDirectory = join(root, '.local');
  let parent;
  try { parent = privateParent(localDirectory); }
  catch (error) {
    if (error?.code !== 'demo_parent_required') throw error;
    try { mkdirSync(localDirectory, { mode: 0o700 }); }
    catch (createError) { if (createError?.code !== 'EEXIST') throw fail('demo_parent_required'); }
    parent = privateParent(localDirectory);
  }
  if (reservedPath(parent)) throw fail('demo_directory_reserved');
  for (let attempt = 0; attempt < 8; attempt++) {
    const target = join(parent, `${RUN_PREFIX}${randomBytes(8).toString('hex')}`);
    try {
      mkdirSync(target, { mode: 0o700 });
      return target;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw fail('demo_target_unavailable');
    }
  }
  throw fail('demo_target_unavailable');
}

function createRunDirectory(value) {
  if (value === undefined) return createDefaultRunDirectory();
  const target = requestedFreshPath(value);
  try { mkdirSync(target, { mode: 0o700 }); }
  catch (error) { if (error?.code === 'EEXIST') throw fail('demo_target_exists'); throw fail('demo_target_unavailable'); }
  let stat;
  try { stat = lstatSync(target); } catch { throw fail('demo_target_unavailable'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owner(stat) || (stat.mode & 0o077))
    throw fail('demo_directory_private_required');
  return target;
}

function writeExclusive(path, bytes, mode, privateFile) {
  const data = Buffer.from(bytes);
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      (constants.O_NOFOLLOW || 0), mode);
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset, null);
      if (!written) throw fail('demo_file_write_failed');
      offset += written;
    }
    const stat = fstatSync(fd);
    ensure(stat.isFile() && owner(stat) && stat.nlink === 1 && !(stat.mode & 0o111), 'demo_file_required');
    if (privateFile) ensure((stat.mode & 0o077) === 0, 'demo_private_file_required');
    else ensure((stat.mode & 0o022) === 0, 'demo_public_file_required');
    return stat;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function writeVerified(path, bytes, mode, privateFile) {
  const expected = Buffer.from(bytes);
  writeExclusive(path, expected, mode, privateFile);
  const actual = readFileSync(path);
  ensure(actual.equals(expected), 'demo_artifact_changed');
  return actual;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeApiCode(value) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : 'unavailable';
}

function runtimeError(error) {
  if (error?.code === 'EADDRINUSE') return fail('demo_port_in_use');
  if (typeof error?.code === 'string' && SAFE_CODE.test(error.code)) return fail(`demo_runtime_${error.code}`);
  return fail('demo_runtime_unavailable');
}

function expectStatus(response, expected, name) {
  if (response.status !== expected) {
    const remote = safeApiCode(response.data?.error?.code);
    throw fail(`demo_${name}_${remote}`);
  }
  return response.data;
}

function client(origin) {
  let cookie = '';
  let csrf = '';
  return {
    async request(path, body, { method = body === undefined ? 'GET' : 'POST', raw = false } = {}) {
      const headers = {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', 'X-DalaHold-CSRF': csrf } : {}),
      };
      const response = await fetch(origin + path, {
        method, headers, redirect: 'manual',
        ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const bytes = Buffer.from(await response.arrayBuffer());
      let data = null;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { /* binary document/error */ }
      if (data?.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data, bytes, headers: response.headers };
    },
  };
}

async function bootstrap(account) {
  expectStatus(await account.request(`${API}/session`), 200, 'session');
}

async function register(account) {
  await bootstrap(account);
  const result = expectStatus(await account.request(`${API}/participants`, {}), 201, 'register');
  ensure(HEX.test(result.accessCode) && result.participant?.id, 'demo_register_invalid');
  return { participant: result.participant, accessCode: result.accessCode };
}

async function detail(account, dealId) {
  return expectStatus(await account.request(`${API}/deals/${dealId}`), 200, 'detail').deal;
}

function actionInput(deal, action) {
  return { requestId: randomUUID(), action, expectedVersion: deal.version,
    expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash };
}

async function action(account, deal, action) {
  const body = actionInput(deal, action);
  const response = await account.request(`${API}/deals/${deal.id}/events`, body);
  const result = expectStatus(response, 201, `action_${action}`);
  ensure(result.deal?.state, 'demo_action_invalid');
  return { body, response, result, deal: result.deal };
}

async function invite(seller, buyer, deal) {
  const invitation = expectStatus(await seller.request(`${API}/deals/${deal.id}/invitations`, {
    expectedVersion: deal.version, participantId: buyer.participant.id,
  }), 201, 'invite');
  expectStatus(await buyer.client.request(`${API}/invitations/claims`, { code: invitation.code }), 200, 'claim');
  return invitation.code;
}

function safeShareable(bytes, bearerCodes) {
  const text = Buffer.from(bytes).toString('utf8');
  for (const marker of SECRET_MARKERS) ensure(!text.includes(marker), 'demo_shareable_secret');
  for (const code of bearerCodes) ensure(!text.includes(code), 'demo_shareable_bearer');
  return text;
}

async function evidence(account, dealId, expected) {
  const response = await account.request(`${API}/deals/${dealId}/evidence`);
  expectStatus(response, 200, 'evidence');
  const checked = verifyParticipantEvidence(response.data);
  ensure(checked.valid && checked.authenticityVerified === false && checked.sdkVerificationPerformed === false,
    'demo_evidence_invalid');
  ensure(response.data.deal.state === expected.state && response.data.deal.version === expected.version,
    'demo_evidence_state');
  ensure(response.data.receipts.length === 0, 'demo_signed_receipts');
  return { bytes: response.bytes, value: response.data, check: checked };
}

function terms(value) {
  return { scenario: value.scenario, quantity: value.quantity, amount: value.amount, date: value.date };
}

async function prepareAccepted(seller, buyer) {
  const created = expectStatus(await seller.request(`${API}/deals`, {
    requestId: randomUUID(), creatorRole: 'seller', ...terms({ scenario: 'livestock', quantity: 20, amount: 9_500_000, date: '2026-10-03' }),
  }), 201, 'accepted_create');
  let deal = created.deal;
  const invitationCode = await invite(seller, buyer, deal);
  const firstDocument = expectStatus(await seller.request(`${API}/deals/${deal.id}/documents`, {
    requestId: randomUUID(), expectedVersion: 1, category: 'contract',
    contentBase64: Buffer.from('ANONYMOUS TEST CONTRACT v1\n').toString('base64'),
  }), 201, 'accepted_document_v1');
  const revised = expectStatus(await seller.request(`${API}/deals/${deal.id}/versions`, {
    requestId: randomUUID(), expectedVersion: 1, scenario: 'livestock', quantity: 20, amount: 9_786_000, date: '2026-10-03',
  }), 201, 'accepted_version');
  deal = revised.deal;
  const secondDocument = expectStatus(await seller.request(`${API}/deals/${deal.id}/documents`, {
    requestId: randomUUID(), expectedVersion: 2, category: 'delivery',
    contentBase64: Buffer.from('ANONYMOUS TEST DELIVERY v2\n').toString('base64'),
  }), 201, 'accepted_document_v2');
  deal = await detail(seller, deal.id);

  const offer = await action(seller, deal, 'offer');
  const retry = await seller.request(`${API}/deals/${deal.id}/events`, offer.body);
  ensure(retry.status === 200 && retry.data?.historical === true && retry.data.event?.id === offer.result.event.id,
    'demo_action_retry');
  deal = offer.deal;
  deal = (await action(buyer.client, deal, 'agree')).deal;
  deal = (await action(seller, deal, 'handover')).deal;
  deal = (await action(buyer.client, deal, 'accept')).deal;

  const buyerReviewBody = { requestId: randomUUID(), expectedVersion: deal.version,
    expectedStateRevision: deal.stateRevision, snapshotHash: deal.snapshotHash, score: 5 };
  const sellerReviewBody = { ...buyerReviewBody, requestId: randomUUID(), score: 4 };
  const buyerReview = expectStatus(await buyer.client.request(`${API}/deals/${deal.id}/reviews`, buyerReviewBody), 201, 'buyer_review');
  const sellerReview = expectStatus(await seller.request(`${API}/deals/${deal.id}/reviews`, sellerReviewBody), 201, 'seller_review');
  const buyerReviews = expectStatus(await buyer.client.request(`${API}/deals/${deal.id}/reviews`), 200, 'accepted_reviews');
  ensure(buyerReviews.reviews.length === 2, 'demo_accepted_review_count');

  const strict = await seller.request(`${API}/deals`, {
    requestId: randomUUID(), creatorRole: 'seller', scenario: 'grain', quantity: 1, amount: 1, date: '2026-10-03', extra: 'reject',
  });
  ensure(strict.status === 400 && strict.data?.error?.code === 'invalid_request', 'demo_strict_input');
  return { deal, firstDocument: firstDocument.document, secondDocument: secondDocument.document,
    reviews: [buyerReview.review, sellerReview.review], invitationCode, retryPassed: true, strictInputPassed: true };
}

async function prepareDisputed(seller, buyer) {
  const created = expectStatus(await seller.request(`${API}/deals`, {
    requestId: randomUUID(), creatorRole: 'seller', scenario: 'livestock', quantity: 3, amount: 90_000, date: '2026-10-03',
  }), 201, 'disputed_create');
  let deal = created.deal;
  const invitationCode = await invite(seller, buyer, deal);
  deal = await detail(seller, deal.id);
  deal = (await action(seller, deal, 'offer')).deal;
  deal = (await action(buyer.client, deal, 'agree')).deal;
  deal = (await action(seller, deal, 'dispute')).deal;
  const deniedReview = await buyer.client.request(`${API}/deals/${deal.id}/reviews`, {
    requestId: randomUUID(), expectedVersion: deal.version, expectedStateRevision: deal.stateRevision,
    snapshotHash: deal.snapshotHash, score: 5,
  });
  ensure(deniedReview.status === 409 && deniedReview.data?.error?.code === 'review_not_allowed', 'demo_disputed_review_guard');
  const reviews = expectStatus(await buyer.client.request(`${API}/deals/${deal.id}/reviews`), 200, 'disputed_reviews');
  ensure(reviews.reviews.length === 0, 'demo_disputed_review_count');
  return { deal, reviews: reviews.reviews, invitationCode, reviewGuardPassed: true };
}

function publicSummary(value, evidenceFile, evidenceBytes, evidenceCheck) {
  return {
    id: value.deal.id,
    state: value.deal.state,
    version: value.deal.version,
    events: value.deal.events.length,
    versions: value.deal.version,
    documents: value.deal.documentHistory.length,
    documentSummary: [value.firstDocument, value.secondDocument].filter(Boolean).map(document => ({
      termsVersion: document.termsVersion, category: document.category,
      byteLength: document.byteLength, sha256: document.sha256,
    })),
    reviews: value.reviews.length,
    reviewSummary: value.reviews.map(review => ({ authorRole: review.authorRole, targetRole: review.targetRole,
      score: review.score, termsVersion: review.termsVersion, stateRevision: review.stateRevision })),
    evidence: { file: evidenceFile, bytes: evidenceBytes.length, sha256: sha256(evidenceBytes),
      packageSha256: evidenceCheck.packageSha256 },
  };
}

export async function prepareParticipantDemo(options = undefined) {
  const input = exactDemoOptions(options);
  const runDirectory = input.runDirectory;
  const port = input.port === undefined ? DEFAULT_PORT : input.port;
  const now = input.now === undefined ? Date.now : input.now;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof now !== 'function') throw fail('demo_options_invalid');
  const runDir = createRunDirectory(runDirectory);
  const runtimeDirectory = join(runDir, 'runtime');
  let stand;
  try {
    try { stand = await startParticipantRuntime({ directory: runtimeDirectory, port, now }); }
    catch (error) { throw runtimeError(error); }
    const origin = new URL(stand.url).origin;
    const seller = client(origin), buyer = client(origin);
    const sellerAccount = await register(seller);
    const buyerAccount = await register(buyer);
    const invalid = client(origin);
    await bootstrap(invalid);
    const invalidAccessCode = randomBytes(32).toString('hex');
    const invalidLogin = await invalid.request(`${API}/session/login`, { accessCode: invalidAccessCode });
    ensure(invalidLogin.status === 401 && invalidLogin.data?.error?.code === 'unauthorized', 'demo_invalid_login_guard');
    const accepted = await prepareAccepted(seller, { client: buyer, participant: buyerAccount.participant });
    const disputed = await prepareDisputed(seller, { client: buyer, participant: buyerAccount.participant });
    const acceptedEvidence = await evidence(buyer, accepted.deal.id, { state: 'accepted', version: 2 });
    const disputedEvidence = await evidence(buyer, disputed.deal.id, { state: 'disputed', version: 1 });
    const bearerCodes = [sellerAccount.accessCode, buyerAccount.accessCode, accepted.invitationCode,
      disputed.invitationCode, invalidAccessCode];
    safeShareable(acceptedEvidence.bytes, bearerCodes);
    safeShareable(disputedEvidence.bytes, bearerCodes);

    const acceptedEvidencePath = join(runDir, ACCEPTED_EVIDENCE_FILE);
    const disputedEvidencePath = join(runDir, DISPUTED_EVIDENCE_FILE);
    writeVerified(acceptedEvidencePath, acceptedEvidence.bytes, 0o644, false);
    writeVerified(disputedEvidencePath, disputedEvidence.bytes, 0o644, false);
    const operatorPath = join(runDir, CODES_FILE);
    const operatorBytes = Buffer.from(JSON.stringify({ schema: 'dalahold.local-test-participant-demo-access.v1',
      sellerAccessCode: sellerAccount.accessCode, buyerAccessCode: buyerAccount.accessCode }));
    writeVerified(operatorPath, operatorBytes, 0o600, true);
    const report = {
      schema: 'dalahold.local-test-participant-demo-report.v1',
      mode: 'unsigned_local_test_only',
      runDirectory: basename(runDir),
      runtime: { directory: 'runtime', port: stand.server.address().port, origin, signed: false },
      operatorAccessFile: CODES_FILE,
      acceptedDeal: publicSummary(accepted, ACCEPTED_EVIDENCE_FILE, acceptedEvidence.bytes, acceptedEvidence.check),
      disputedDeal: publicSummary(disputed, DISPUTED_EVIDENCE_FILE, disputedEvidence.bytes, disputedEvidence.check),
      checks: { twoSeparateAnonymousAccounts: sellerAccount.participant.id !== buyerAccount.participant.id,
        acceptedStateAndVersion: accepted.deal.state === 'accepted' && accepted.deal.version === 2,
        acceptedDocuments: accepted.deal.documentHistory.length === 2,
        bothRoleReviews: accepted.reviews.length === 2,
        disputedStateAndNoReviews: disputed.deal.state === 'disputed' && disputed.reviews.length === 0,
        actionRetry: accepted.retryPassed, strictInput: accepted.strictInputPassed,
        disputedReviewGuard: disputed.reviewGuardPassed, unsignedReceipts: 0,
        invalidCapabilityDenied: true,
        shareableArtifactsContainNoBearerOrSessionData: true },
      limitations: [
        'Local unsigned TEST capability statements only; no identity, certificate, signature, authority, payment or Solana proof.',
        'Evidence SHA-256 values check integrity and consistency only; they do not establish provenance or authenticity.',
        'The private operator file contains only the two local random account bearer codes and must not be shared.',
      ],
    };
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    safeShareable(reportBytes, bearerCodes);
    writeVerified(join(runDir, REPORT_FILE), reportBytes, 0o644, false);
    return { runDirectory: runDir, runtimeDirectory, reportPath: join(runDir, REPORT_FILE),
      acceptedEvidencePath, disputedEvidencePath, operatorPath, report, stand,
      close: () => stand.close() };
  } catch (error) {
    try { await stand?.close(); } catch { /* preserve failed private residue */ }
    if (error?.code && SAFE_CODE.test(error.code)) throw error;
    throw fail('demo_failed');
  }
}

function parsePort(value) {
  if (!/^\d+$/.test(value || '')) throw fail('demo_port_invalid');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw fail('demo_port_invalid');
  return parsed;
}

export function parseDemoArgs(argv = []) {
  const options = { port: DEFAULT_PORT, serve: false };
  let portSeen = false;
  let runDirectorySeen = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--help') { options.help = true; continue; }
    if (value === '--serve') { if (options.serve) throw fail('demo_usage'); options.serve = true; continue; }
    if (value === '--run-dir') {
      if (runDirectorySeen || argv[index + 1] === undefined) throw fail('demo_usage');
      runDirectorySeen = true;
      options.runDirectory = argv[++index]; continue;
    }
    if (value === '--port') {
      if (portSeen || argv[index + 1] === undefined) throw fail('demo_usage');
      portSeen = true;
      options.port = parsePort(argv[++index]); continue;
    }
    throw fail('demo_usage');
  }
  if (options.help && argv.length !== 1) throw fail('demo_usage');
  return options;
}

function usage() {
  return 'Usage: node web/participant-demo.mjs [--run-dir PATH] [--port 4177|0] [--serve]';
}

function cliError(error) {
  if (error?.code === 'demo_port_in_use') return 'demo_port_in_use';
  if (error?.code === 'demo_target_exists') return 'demo_target_exists';
  if (error?.code === 'demo_usage') return 'demo_usage';
  if (typeof error?.code === 'string' && SAFE_CODE.test(error.code) && error.code.startsWith('demo_')) return error.code;
  return 'demo_failed';
}

async function serveUntilSignal(demo) {
  await new Promise(resolveDone => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      demo.close().then(resolveDone, resolveDone);
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseDemoArgs(argv);
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
  const demoOptions = { port: options.port,
    ...(options.runDirectory === undefined ? {} : { runDirectory: options.runDirectory }) };
  const demo = await prepareParticipantDemo(demoOptions);
  process.stdout.write(`DalaHold anonymous unsigned TEST demo prepared.\nRun directory: ${demo.runDirectory}\nPublic report: ${demo.reportPath}\nAccepted evidence: ${demo.acceptedEvidencePath}\nDisputed evidence: ${demo.disputedEvidencePath}\nPrivate bearer file (0600): ${demo.operatorPath}\n`);
  if (options.serve) {
    const waiting = serveUntilSignal(demo);
    process.stdout.write(`Serving: ${demo.report.runtime.origin}/participants/\n`);
    await waiting;
  } else await demo.close();
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`Participant demo unavailable: ${cliError(error)}.\n`);
    if (error?.code === 'demo_usage') process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
  }
}
