import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fingerprintDraftTerms } from '../web/terms.mjs';
import { DecisionLedger } from './decision-ledger.mjs';
import { createDealDecisionState } from './decision-policy.mjs';

const DEAL_A = '00000000-0000-4000-8000-000000000001';
const DEAL_B = '00000000-0000-4000-8000-000000000002';
const SELLER = '00000000-0000-4000-8000-000000000003';
const BUYER = '00000000-0000-4000-8000-000000000004';
const FINGERPRINT = 'a'.repeat(64);

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-decisions-'));
  const path = join(directory, 'decisions.sqlite');
  let ledger = new DecisionLedger({ dbPath: path });
  t.after(() => {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    get ledger() { return ledger; },
    restart() { ledger.close(); ledger = new DecisionLedger({ dbPath: path }); },
    secondConnection() { return new DecisionLedger({ dbPath: path }); },
  };
}

function create(ledger, dealId = DEAL_A) {
  return ledger.createDeal({
    dealId, sellerId: SELLER, buyerId: BUYER,
    termsVersion: 1, termsFingerprint: FINGERPRINT,
  });
}

function decision(sequence, actorId, action, overrides = {}) {
  return {
    decisionId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    dealId: DEAL_A, actorId, action, termsVersion: 1, termsFingerprint: FINGERPRINT,
    ...overrides,
  };
}

test('trusted decisions survive restart; exact retry does not add an event', (t) => {
  const fx = setup(t);
  create(fx.ledger);
  const offer = decision(101, SELLER, 'offer');
  const first = fx.ledger.apply(DEAL_A, offer);
  assert.equal(first.replayed, false);
  assert.equal(fx.ledger.deal(DEAL_A).events.length, 1);
  fx.restart();
  const retry = fx.ledger.apply(DEAL_A, offer);
  assert.equal(retry.replayed, true);
  assert.equal(retry.state.events.length, 1);
  const accept = decision(102, BUYER, 'accept_terms');
  fx.ledger.apply(DEAL_A, accept);
  assert.equal(fx.ledger.deal(DEAL_A).events.length, 2);
});

test('altered retry, wrong actor and stale terms leave stored state unchanged', (t) => {
  const fx = setup(t);
  create(fx.ledger);
  const offer = decision(201, SELLER, 'offer');
  fx.ledger.apply(DEAL_A, offer);
  const before = fx.ledger.deal(DEAL_A);
  assert.throws(() => fx.ledger.apply(DEAL_A, { ...offer, termsFingerprint: 'b'.repeat(64) }));
  assert.throws(() => fx.ledger.apply(DEAL_A, decision(202, SELLER, 'accept_terms')));
  assert.throws(() => fx.ledger.apply(DEAL_A, decision(203, BUYER, 'accept_terms', { termsVersion: 2 })));
  assert.deepEqual(fx.ledger.deal(DEAL_A), before);
});

test('decision IDs cannot be reused across deals or connections', (t) => {
  const fx = setup(t);
  create(fx.ledger, DEAL_A);
  create(fx.ledger, DEAL_B);
  const other = fx.secondConnection();
  t.after(() => other.close());
  const first = decision(301, SELLER, 'offer');
  fx.ledger.apply(DEAL_A, first);
  assert.throws(() => other.apply(DEAL_B, { ...first, dealId: DEAL_B }), /another deal/);
  assert.equal(other.deal(DEAL_B).events.length, 0);
  assert.equal(other.apply(DEAL_A, first).replayed, true);
  assert.throws(() => fx.ledger.apply(DEAL_A, decision(301, BUYER, 'accept_terms')));
  assert.equal(fx.ledger.deal(DEAL_A).events.length, 1);
});

test('unknown deal and duplicate creation fail without writing a decision', (t) => {
  const fx = setup(t);
  assert.throws(() => fx.ledger.apply(DEAL_A, decision(401, SELLER, 'offer')), /unknown deal/);
  create(fx.ledger);
  assert.throws(() => create(fx.ledger), /UNIQUE constraint failed/);
  assert.equal(fx.ledger.deal(DEAL_A).events.length, 0);
});

test('ledger indexes the validated decision ID, not a second untrusted property read', (t) => {
  const fx = setup(t);
  create(fx.ledger, DEAL_A);
  create(fx.ledger, DEAL_B);
  const first = decision(501, SELLER, 'offer');
  const otherId = decision(502, SELLER, 'offer').decisionId;
  let reads = 0;
  const unstable = new Proxy(first, {
    get(target, key, receiver) {
      if (key === 'decisionId') return reads++ === 0 ? first.decisionId : otherId;
      return Reflect.get(target, key, receiver);
    },
  });
  fx.ledger.apply(DEAL_A, unstable);
  assert.equal(reads, 1);
  assert.equal(fx.ledger.deal(DEAL_A).events[0].decisionId, first.decisionId);
  assert.equal(fx.ledger.apply(DEAL_A, first).replayed, true);
  assert.throws(() => fx.ledger.apply(DEAL_B, { ...first, dealId: DEAL_B }), /another deal/);
});

test('verified receipt fields are captured once before the transaction', (t) => {
  const fx = setup(t);
  const terms = {
    dealId: DEAL_A, version: 1, scenario: 'grain',
    quantity: 20_000, amount: 5_000_000, date: '2026-10-10',
  };
  const termsFingerprint = fingerprintDraftTerms(terms);
  fx.ledger.createDeal({
    dealId: DEAL_A, sellerId: SELLER, buyerId: BUYER,
    termsVersion: 1, termsFingerprint,
  }, terms);
  const offer = decision(601, SELLER, 'offer', { termsFingerprint });
  const db = new DatabaseSync(fx.path);
  t.after(() => db.close());
  const expiresAt = 1_800_000_120_000;
  const signedBytes = Buffer.from(JSON.stringify({
    schema: 'dalahold.offline-decision.v1', ...offer, expiresAt,
  }));
  db.exec(`CREATE TABLE decision_challenges (
    challenge_id TEXT PRIMARY KEY, signed_bytes BLOB NOT NULL, expires_at INTEGER NOT NULL,
    signature_hash TEXT,
    certificate_id TEXT, result_status TEXT
  ) STRICT`);
  db.prepare(`INSERT INTO decision_challenges (challenge_id, signed_bytes, expires_at)
    VALUES (?, ?, ?)`).run(offer.decisionId, signedBytes, expiresAt);
  let reads = 0;
  const receipt = {
    get signatureHash() { return ++reads === 1 ? 'b'.repeat(64) : 'c'.repeat(64); },
    certificateId: 'seller',
    challengeHash: createHash('sha256').update(signedBytes).digest('hex'),
    expiresAt, now: () => expiresAt - 1,
  };
  fx.ledger.apply(DEAL_A, offer, receipt);
  assert.equal(reads, 1);
  assert.equal(db.prepare('SELECT signature_hash FROM decision_challenges WHERE challenge_id = ?')
    .get(offer.decisionId).signature_hash, 'b'.repeat(64));
});

test('verified receipt cannot authorize a different decision than the signed challenge', (t) => {
  const fx = setup(t);
  const terms = {
    dealId: DEAL_A, version: 1, scenario: 'grain',
    quantity: 20_000, amount: 5_000_000, date: '2026-10-10',
  };
  const termsFingerprint = fingerprintDraftTerms(terms);
  fx.ledger.createDeal({
    dealId: DEAL_A, sellerId: SELLER, buyerId: BUYER,
    termsVersion: 1, termsFingerprint,
  }, terms);
  const offer = decision(602, SELLER, 'offer', { termsFingerprint });
  const signedForBuyer = { ...offer, actorId: BUYER, action: 'accept_terms' };
  const expiresAt = 1_800_000_120_000;
  const signedBytes = Buffer.from(JSON.stringify({
    schema: 'dalahold.offline-decision.v1', ...signedForBuyer, expiresAt,
  }));
  const db = new DatabaseSync(fx.path);
  t.after(() => db.close());
  db.exec(`CREATE TABLE decision_challenges (
    challenge_id TEXT PRIMARY KEY, signed_bytes BLOB NOT NULL, expires_at INTEGER NOT NULL,
    signature_hash TEXT, certificate_id TEXT, result_status TEXT
  ) STRICT`);
  db.prepare(`INSERT INTO decision_challenges (challenge_id, signed_bytes, expires_at)
    VALUES (?, ?, ?)`).run(offer.decisionId, signedBytes, expiresAt);
  assert.throws(() => fx.ledger.apply(DEAL_A, offer, {
    signatureHash: 'b'.repeat(64), certificateId: 'seller',
    challengeHash: createHash('sha256').update(signedBytes).digest('hex'),
    expiresAt, now: () => expiresAt - 1,
  }), /challenge decision mismatch/);
  assert.equal(fx.ledger.deal(DEAL_A).status, 'draft');
  assert.equal(db.prepare('SELECT signature_hash FROM decision_challenges WHERE challenge_id = ?')
    .get(offer.decisionId).signature_hash, null);
});

test('legacy decision database gains the snapshot column without changing old deals', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-legacy-decisions-'));
  const path = join(directory, 'decisions.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE decision_deals (
    deal_id TEXT PRIMARY KEY, state_json TEXT NOT NULL
  ) STRICT`);
  const state = createDealDecisionState({
    dealId: DEAL_A, sellerId: SELLER, buyerId: BUYER,
    termsVersion: 1, termsFingerprint: FINGERPRINT,
  });
  old.prepare('INSERT INTO decision_deals (deal_id, state_json) VALUES (?, ?)')
    .run(DEAL_A, JSON.stringify(state));
  old.close();
  const ledger = new DecisionLedger({ dbPath: path });
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(ledger.deal(DEAL_A), state);
  assert.equal(ledger.termsSnapshot(DEAL_A), undefined);
  assert.equal(ledger.apply(DEAL_A, decision(701, SELLER, 'offer')).state.status, 'offered');
});
