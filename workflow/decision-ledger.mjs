// Offline persistence for trusted test decisions only. Not an authenticated API.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fingerprintDraftTerms } from '../web/terms.mjs';
import { applyTrustedDecision, createDealDecisionState } from './decision-policy.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERM_FIELDS = ['dealId', 'version', 'scenario', 'quantity', 'amount', 'date'];
export const OFFLINE_DECISION_SCHEMA = 'dalahold.offline-decision.v1';

function snapshotJson(input, state) {
  if (input === undefined) return null; // Pure policy tests have no web draft.
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).length !== TERM_FIELDS.length ||
      TERM_FIELDS.some((key) => !Object.hasOwn(input, key))) {
    throw new Error('invalid terms snapshot');
  }
  const terms = Object.fromEntries(TERM_FIELDS.map((key) => [key, input[key]]));
  if (terms.dealId !== state.dealId || terms.version !== state.termsVersion ||
      fingerprintDraftTerms(terms) !== state.termsFingerprint) {
    throw new Error('terms snapshot mismatch');
  }
  return JSON.stringify(terms);
}

export class DecisionLedger {
  #db;
  #requireCurrentDraft;

  constructor({ dbPath, requireCurrentDraft = false }) {
    if (typeof dbPath !== 'string' || !dbPath ||
        typeof requireCurrentDraft !== 'boolean') throw new Error('invalid ledger setup');
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS decision_deals (
        deal_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        terms_json TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS decision_ids (
        decision_id TEXT PRIMARY KEY,
        deal_id TEXT NOT NULL REFERENCES decision_deals(deal_id)
      ) STRICT;
    `);
    if (!this.#db.prepare('PRAGMA table_info(decision_deals)').all()
      .some((column) => column.name === 'terms_json')) {
      this.#db.exec('ALTER TABLE decision_deals ADD COLUMN terms_json TEXT');
    }
    this.#db.exec('PRAGMA foreign_keys = ON');
    if (requireCurrentDraft && !this.#db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'drafts'",
    ).get()) {
      this.#db.close();
      throw new Error('shared draft table required');
    }
    this.#requireCurrentDraft = requireCurrentDraft;
  }

  close() { this.#db.close(); }

  createDeal(input, termsSnapshot) {
    const state = createDealDecisionState(input);
    const termsJson = snapshotJson(termsSnapshot, state);
    this.#db.prepare('INSERT INTO decision_deals (deal_id, state_json, terms_json) VALUES (?, ?, ?)')
      .run(state.dealId, JSON.stringify(state), termsJson);
    return state;
  }

  deal(dealId) {
    if (typeof dealId !== 'string' || !UUID.test(dealId)) throw new Error('invalid deal id');
    const row = this.#db.prepare('SELECT state_json FROM decision_deals WHERE deal_id = ?').get(dealId);
    return row ? JSON.parse(row.state_json) : undefined;
  }

  termsSnapshot(dealId) {
    if (typeof dealId !== 'string' || !UUID.test(dealId)) throw new Error('invalid deal id');
    const row = this.#db.prepare(
      'SELECT state_json, terms_json FROM decision_deals WHERE deal_id = ?',
    ).get(dealId);
    if (!row?.terms_json) return undefined;
    try {
      const state = JSON.parse(row.state_json);
      const terms = JSON.parse(row.terms_json);
      if (snapshotJson(terms, state) !== row.terms_json) throw new Error('mismatch');
      return terms;
    } catch {
      throw new Error('terms snapshot mismatch');
    }
  }

  // A trusted fixture may follow a revised unsigned draft only before the
  // first decision. Once offered, the recorded terms remain immutable.
  refreshUnsignedTerms({ dealId, termsVersion, termsFingerprint }, termsSnapshot) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.deal(dealId);
      if (!current) throw new Error('unknown deal');
      if (current.status !== 'draft' || current.events.length !== 0) {
        throw new Error('deal terms already offered');
      }
      const next = createDealDecisionState({
        dealId, sellerId: current.sellerId, buyerId: current.buyerId,
        termsVersion, termsFingerprint,
      });
      const termsJson = snapshotJson(termsSnapshot, next);
      this.#db.prepare('UPDATE decision_deals SET state_json = ?, terms_json = ? WHERE deal_id = ?')
        .run(JSON.stringify(next), termsJson, dealId);
      this.#db.exec('COMMIT');
      return next;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  apply(dealId, decision, verifiedReceipt) {
    if (typeof dealId !== 'string' || !UUID.test(dealId)) throw new Error('invalid deal id');
    const receiptValues = verifiedReceipt === undefined ? undefined : {
      signatureHash: verifiedReceipt?.signatureHash,
      certificateId: verifiedReceipt?.certificateId,
      challengeHash: verifiedReceipt?.challengeHash,
      expiresAt: verifiedReceipt?.expiresAt,
      now: verifiedReceipt?.now,
    };
    if (receiptValues && (
      typeof receiptValues.signatureHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(receiptValues.signatureHash) ||
      typeof receiptValues.certificateId !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(receiptValues.certificateId) ||
      typeof receiptValues.challengeHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(receiptValues.challengeHash) ||
      !Number.isSafeInteger(receiptValues.expiresAt) || receiptValues.expiresAt < 0 ||
      typeof receiptValues.now !== 'function'
    )) throw new Error('invalid verified receipt');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.deal(dealId);
      if (!current) throw new Error('unknown deal');
      if (receiptValues || this.#requireCurrentDraft) {
        if (!this.termsSnapshot(dealId)) throw new Error('missing terms snapshot');
        if (this.#requireCurrentDraft && current.status === 'draft') {
          const draft = this.#db.prepare(
            'SELECT version, scenario, quantity, amount, date FROM drafts WHERE id = ?',
          ).get(dealId);
          if (!draft || draft.version !== current.termsVersion ||
              fingerprintDraftTerms({ dealId, ...draft }) !== current.termsFingerprint) {
            throw new Error('unsigned draft changed after binding');
          }
        }
      }
      const result = applyTrustedDecision(current, decision);
      const decisionId = result.decision.decisionId;
      const existing = this.#db.prepare('SELECT deal_id FROM decision_ids WHERE decision_id = ?')
        .get(decisionId);
      if (existing && existing.deal_id !== dealId) throw new Error('decision id belongs to another deal');
      const receipt = verifiedReceipt === undefined ? undefined : this.#db.prepare(
        `SELECT signed_bytes, expires_at, signature_hash, certificate_id, result_status
         FROM decision_challenges WHERE challenge_id = ?`,
      ).get(decisionId);
      if (verifiedReceipt !== undefined && !receipt) throw new Error('unknown challenge');
      if (receipt && (
        receipt.expires_at !== receiptValues.expiresAt ||
        createHash('sha256').update(receipt.signed_bytes).digest('hex') !==
          receiptValues.challengeHash
      )) throw new Error('challenge changed during verification');
      if (receipt && !Buffer.from(receipt.signed_bytes).equals(Buffer.from(JSON.stringify({
        schema: OFFLINE_DECISION_SCHEMA, ...result.decision, expiresAt: receipt.expires_at,
      })))) throw new Error('challenge decision mismatch');
      if (!result.replayed) {
        if (existing) throw new Error('decision id conflict');
        if (receipt) {
          const now = receiptValues.now();
          if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid clock');
          if (receipt.expires_at <= now) throw new Error('challenge expired');
        }
        if (receipt && receipt.signature_hash !== null && (
          receipt.signature_hash !== receiptValues.signatureHash ||
          receipt.certificate_id !== receiptValues.certificateId ||
          receipt.result_status !== result.state.status
        )) throw new Error('challenge credential conflict');
        this.#db.prepare('INSERT INTO decision_ids (decision_id, deal_id) VALUES (?, ?)')
          .run(decisionId, dealId);
        this.#db.prepare('UPDATE decision_deals SET state_json = ? WHERE deal_id = ?')
          .run(JSON.stringify(result.state), dealId);
        if (receipt) this.#db.prepare(`UPDATE decision_challenges
          SET signature_hash = ?, certificate_id = ?, result_status = ?
          WHERE challenge_id = ?`).run(
          receiptValues.signatureHash, receiptValues.certificateId,
          result.state.status, decisionId,
        );
      } else if (!existing) {
        // A previously persisted state cannot contain an event absent from the
        // uniqueness index. Treat an incomplete/corrupt write as a hard failure.
        throw new Error('decision index mismatch');
      } else if (receipt && (
        receipt.signature_hash !== receiptValues.signatureHash ||
        receipt.certificate_id !== receiptValues.certificateId ||
        receipt.result_status === null
      )) {
        throw new Error('replay credential mismatch');
      }
      this.#db.exec('COMMIT');
      return receipt ? {
        ...result, resultStatus: result.replayed ? receipt.result_status : result.state.status,
      } : result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
