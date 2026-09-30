// Internal offline bridge from server-owned unsigned draft terms to a signed
// test decision. No HTTP route, NCA verifier, payment, or Solana broadcast.
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fingerprintDraftTerms } from '../web/terms.mjs';
import { DecisionLedger, OFFLINE_DECISION_SCHEMA } from './decision-ledger.mjs';
import { applyTrustedDecision, createDealDecisionState } from './decision-policy.mjs';

const SCHEMA = OFFLINE_DECISION_SCHEMA;
const TTL_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CERTIFICATE_ID = /^[A-Za-z0-9:_-]{1,128}$/;

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`invalid ${label}`);
  }
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}

function clockNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 ||
      value > Number.MAX_SAFE_INTEGER - TTL_MS) throw new Error('invalid clock');
  return value;
}

function sameDatabase(a, b) {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return resolve(a) === resolve(b); }
}

export class SignedDecisionFixture {
  #drafts;
  #db;
  #ledger;
  #verifySigned;
  #verifyPowers;
  #now;

  constructor({ draftDbPath, decisionDbPath, verifySigned, verifyPowers, now = Date.now }) {
    if (typeof draftDbPath !== 'string' || !draftDbPath ||
        typeof decisionDbPath !== 'string' || !decisionDbPath ||
        typeof verifySigned !== 'function' || typeof verifyPowers !== 'function' ||
        typeof now !== 'function') throw new Error('fixture dependencies required');
    this.#drafts = new DatabaseSync(draftDbPath, { readOnly: true });
    this.#ledger = new DecisionLedger({
      dbPath: decisionDbPath,
      requireCurrentDraft: sameDatabase(draftDbPath, decisionDbPath),
    });
    this.#db = new DatabaseSync(decisionDbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS decision_challenges (
        challenge_id TEXT PRIMARY KEY,
        signed_bytes BLOB NOT NULL,
        expires_at INTEGER NOT NULL,
        signature_hash TEXT,
        certificate_id TEXT,
        result_status TEXT,
        CHECK ((signature_hash IS NULL) = (certificate_id IS NULL)
          AND (signature_hash IS NULL) = (result_status IS NULL))
      ) STRICT;
    `);
    this.#verifySigned = verifySigned;
    this.#verifyPowers = verifyPowers;
    this.#now = now;
  }

  close() {
    this.#db.close();
    this.#ledger.close();
    this.#drafts.close();
  }

  #currentDraft(dealId) {
    const row = this.#drafts.prepare(
      'SELECT version, scenario, quantity, amount, date FROM drafts WHERE id = ?',
    ).get(dealId);
    if (!row) throw new Error('unknown unsigned draft');
    const terms = {
      dealId, version: row.version, scenario: row.scenario,
      quantity: row.quantity, amount: row.amount, date: row.date,
    };
    return {
      version: row.version,
      fingerprint: fingerprintDraftTerms(terms), terms,
    };
  }

  #assertCurrent(state) {
    const terms = this.#ledger.termsSnapshot(state.dealId);
    if (!terms) throw new Error('missing terms snapshot');
    // Before the first offer, a newer unsigned edit invalidates pending bytes.
    // After offer, the stored terms are immutable: a mutable draft
    // must not let one party block the other's acceptance or dispute.
    if (state.status !== 'draft') return terms;
    const current = this.#currentDraft(state.dealId);
    if (current.version !== state.termsVersion ||
        current.fingerprint !== state.termsFingerprint) {
      throw new Error('unsigned draft changed after binding');
    }
    return terms;
  }

  // Trusted fixture setup only. The browser cannot choose these participant IDs.
  bindDeal(input) {
    const { dealId, sellerId, buyerId } = exactFields(
      input, ['dealId', 'sellerId', 'buyerId'], 'deal binding',
    );
    const { version, fingerprint, terms } = this.#currentDraft(dealId);
    return this.#ledger.createDeal({
      dealId, sellerId, buyerId, termsVersion: version, termsFingerprint: fingerprint,
    }, terms);
  }

  deal(dealId) { return this.#ledger.deal(dealId); }
  termsSnapshot(dealId) { return this.#ledger.termsSnapshot(dealId); }

  demoEvidence(dealId) {
    const state = this.#ledger.deal(dealId);
    if (!state) throw new Error('unknown bound deal');
    const terms = this.#ledger.termsSnapshot(dealId);
    if (!terms) throw new Error('missing terms snapshot');
    const archived = this.#drafts.prepare(`SELECT version, scenario, quantity, amount, date
      FROM draft_versions WHERE deal_id = ? AND version = ?`)
      .get(dealId, terms.version);
    if (!archived || fingerprintDraftTerms({ dealId, ...archived }) !== state.termsFingerprint) {
      throw new Error('archived terms mismatch');
    }
    let derived = createDealDecisionState({
      dealId, sellerId: state.sellerId, buyerId: state.buyerId,
      termsVersion: state.termsVersion, termsFingerprint: state.termsFingerprint,
    });
    const decisionFields = [
      'decisionId', 'dealId', 'actorId', 'action', 'termsVersion', 'termsFingerprint',
    ];
    const decisions = state.events.map((event, index) => {
      const row = this.#db.prepare(`SELECT signed_bytes, expires_at, signature_hash,
        certificate_id, result_status FROM decision_challenges WHERE challenge_id = ?`)
        .get(event.decisionId);
      if (typeof row?.signature_hash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(row.signature_hash) ||
          !row.certificate_id || !row.result_status) {
        throw new Error('missing test decision receipt');
      }
      const { schema, expiresAt, ...signedDecision } = JSON.parse(
        Buffer.from(row.signed_bytes).toString('utf8'),
      );
      if (schema !== SCHEMA || expiresAt !== row.expires_at ||
          Object.keys(signedDecision).length !== decisionFields.length ||
          decisionFields.some((key) => signedDecision[key] !== event[key])) {
        throw new Error('decision receipt mismatch');
      }
      const next = applyTrustedDecision(derived, event);
      if (next.replayed || next.state.status !== row.result_status) {
        throw new Error('decision receipt mismatch');
      }
      derived = next.state;
      return {
        sequence: index + 1, decisionId: event.decisionId,
        actorId: event.actorId, action: event.action, resultStatus: row.result_status,
        challengeHash: createHash('sha256').update(row.signed_bytes).digest('hex'),
        signatureHash: row.signature_hash, source: 'test_key_receipt',
      };
    });
    if (derived.status !== state.status ||
        derived.ratedBySeller !== state.ratedBySeller ||
        derived.ratedByBuyer !== state.ratedByBuyer) {
      throw new Error('decision state mismatch');
    }
    const documentMarkers = this.#drafts.prepare(`SELECT id, category, context, note,
      claimed_role AS claimedRole, file_kind AS fileKind, created_at AS createdAt
      FROM document_markers WHERE deal_id = ? AND terms_version = ?
      ORDER BY created_at, rowid`).all(dealId, terms.version)
      .map((marker) => ({ ...marker, source: 'unsigned_metadata_only' }));
    return {
      schema: 'dalahold.offline-evidence.v1', trustLevel: 'local_test_fixture_only',
      disclaimer: 'No NCA signature, verified file, payment or chain transaction.',
      dealId, terms, termsFingerprint: state.termsFingerprint,
      status: state.status, decisions, documentMarkers,
    };
  }

  refreshUnsignedTerms(dealId) {
    const { version, fingerprint, terms } = this.#currentDraft(dealId);
    return this.#ledger.refreshUnsignedTerms({
      dealId, termsVersion: version, termsFingerprint: fingerprint,
    }, terms);
  }

  issueChallenge(input) {
    const { dealId, actorId, action } = exactFields(
      input, ['dealId', 'actorId', 'action'], 'challenge request',
    );
    const state = this.#ledger.deal(dealId);
    if (!state) throw new Error('unknown bound deal');
    const terms = this.#assertCurrent(state);
    const decision = {
      decisionId: randomUUID(), dealId, actorId, action,
      termsVersion: state.termsVersion, termsFingerprint: state.termsFingerprint,
    };
    applyTrustedDecision(state, decision); // Preflight; submission checks again.
    const expiresAt = clockNow(this.#now) + TTL_MS;
    const signedBytes = Buffer.from(JSON.stringify({ schema: SCHEMA, ...decision, expiresAt }));
    this.#db.prepare(`INSERT INTO decision_challenges
      (challenge_id, signed_bytes, expires_at) VALUES (?, ?, ?)`)
      .run(decision.decisionId, signedBytes, expiresAt);
    return {
      challengeId: decision.decisionId,
      bytesBase64url: signedBytes.toString('base64url'),
      display: { dealId, actorId, action,
        termsVersion: state.termsVersion, termsFingerprint: state.termsFingerprint,
        expiresAt, terms },
    };
  }

  #submissionState(decision, challengeId, signatureHash, certificateId) {
    const state = this.#ledger.deal(decision.dealId);
    if (!state) throw new Error('unknown bound deal');
    if (!state.events.some((event) => event.decisionId === challengeId)) return { state };
    const result = applyTrustedDecision(state, decision);
    const receipt = this.#db.prepare(`SELECT signature_hash, certificate_id, result_status
      FROM decision_challenges WHERE challenge_id = ?`).get(challengeId);
    if (!result.replayed || receipt?.signature_hash !== signatureHash ||
        receipt.certificate_id !== certificateId || receipt.result_status === null) {
      throw new Error('replay credential mismatch');
    }
    return { historical: {
      dealId: decision.dealId, challengeId, status: receipt.result_status, replayed: true,
    } };
  }

  async submitChallenge(input) {
    const { challengeId, signature, certificateId } = exactFields(
      input, ['challengeId', 'signature', 'certificateId'], 'challenge response',
    );
    const signatureLength = Buffer.isBuffer(signature) && ArrayBuffer.isView(signature)
      ? Buffer.byteLength(signature) : 0;
    if (typeof challengeId !== 'string' || !UUID.test(challengeId) ||
        signatureLength === 0 || signatureLength > 16_384 ||
        typeof certificateId !== 'string' || !CERTIFICATE_ID.test(certificateId)) {
      throw new Error('invalid challenge response');
    }
    const signatureBytes = Buffer.alloc(signatureLength);
    Uint8Array.prototype.set.call(signatureBytes, signature);
    const signatureHash = createHash('sha256').update(signatureBytes).digest('hex');
    const row = this.#db.prepare(`SELECT signed_bytes, expires_at
      FROM decision_challenges WHERE challenge_id = ?`).get(challengeId);
    if (!row) throw new Error('unknown challenge');
    const bytes = Buffer.from(row.signed_bytes);
    const challengeHash = createHash('sha256').update(bytes).digest('hex');
    const payload = JSON.parse(bytes.toString('utf8'));
    const { schema, expiresAt, ...decision } = payload;
    if (schema !== SCHEMA || expiresAt !== row.expires_at ||
        decision.decisionId !== challengeId) throw new Error('invalid stored challenge');
    let current = this.#submissionState(decision, challengeId, signatureHash, certificateId);
    if (current.historical) return current.historical;
    if (row.expires_at <= clockNow(this.#now)) throw new Error('challenge expired');
    this.#assertCurrent(current.state);
    const verified = await this.#verifySigned(bytes, Buffer.from(signatureBytes), certificateId);
    current = this.#submissionState(decision, challengeId, signatureHash, certificateId);
    if (current.historical) return current.historical;
    const verifiedStatus = verified?.status;
    const verifiedActorId = verified?.actorId;
    if (verifiedStatus !== 'valid' ||
        verifiedActorId !== decision.actorId) throw new Error('identity rejected');
    const powers = await this.#verifyPowers({
      actorId: verifiedActorId, dealId: decision.dealId, action: decision.action,
    });
    current = this.#submissionState(decision, challengeId, signatureHash, certificateId);
    if (current.historical) return current.historical;
    if (powers !== true) throw new Error('powers rejected');
    if (row.expires_at <= clockNow(this.#now)) throw new Error('challenge expired');
    this.#assertCurrent(current.state);
    const resultStatus = applyTrustedDecision(current.state, decision).state.status;
    // The receipt and state transition share one SQLite transaction.
    const result = this.#ledger.apply(decision.dealId, decision, {
      signatureHash, certificateId, challengeHash, expiresAt, now: this.#now,
    });
    if (!result.replayed && result.resultStatus !== resultStatus) {
      throw new Error('unexpected decision status');
    }
    return {
      dealId: decision.dealId, challengeId,
      status: result.resultStatus, replayed: result.replayed,
    };
  }
}
