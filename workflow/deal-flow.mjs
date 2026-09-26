// Offline technical workflow: immutable crop deal -> exact test-transfer order.
// This is not a public API or a real EDS/payment path.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isAddress, SYSTEM_PROGRAM_ID } from '../signer/signer.mjs';

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AMOUNT = /^[1-9][0-9]{0,18}$/;
const TERMS_FIELDS = [
  'version', 'commodity', 'quantity_kg', 'total_price_kzt', 'delivery_date', 'quality_spec',
];
const ORDER_TTL_MS = 120_000;

function validateTerms(terms) {
  if (!terms || typeof terms !== 'object' || Array.isArray(terms) ||
      Object.keys(terms).length !== TERMS_FIELDS.length ||
      TERMS_FIELDS.some((field) => !Object.hasOwn(terms, field)) ||
      terms.version !== 1 ||
      typeof terms.commodity !== 'string' || terms.commodity.length < 2 || terms.commodity.length > 80 ||
      !Number.isSafeInteger(terms.quantity_kg) || terms.quantity_kg <= 0 ||
      !AMOUNT.test(terms.total_price_kzt) ||
      typeof terms.delivery_date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(terms.delivery_date) ||
      Number.isNaN(Date.parse(`${terms.delivery_date}T00:00:00Z`)) ||
      new Date(`${terms.delivery_date}T00:00:00Z`).toISOString().slice(0, 10) !== terms.delivery_date ||
      typeof terms.quality_spec !== 'string' ||
      terms.quality_spec.length < 3 || terms.quality_spec.length > 1000) {
    throw new Error('invalid deal terms');
  }
  return JSON.stringify(Object.fromEntries(TERMS_FIELDS.map((field) => [field, terms[field]])));
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class DealFlow {
  #db;
  #owners;
  #issuer;
  #signer;
  #now;

  constructor({ dbPath, owners, issuer, signer, now = Date.now }) {
    if (typeof dbPath !== 'string' || !dbPath || !owners || typeof owners.owner !== 'function' ||
        !issuer || typeof issuer.issue !== 'function' ||
        !signer || typeof signer.transfer !== 'function' || typeof now !== 'function') {
      throw new Error('workflow dependencies required');
    }
    this.#db = new DatabaseSync(dbPath);
    this.#owners = owners;
    this.#issuer = issuer;
    this.#signer = signer;
    this.#now = now;
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS deals (
        deal_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        test_amount_lamports TEXT NOT NULL,
        terms_json TEXT NOT NULL,
        terms_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS challenges (
        challenge_id TEXT PRIMARY KEY,
        deal_id TEXT NOT NULL REFERENCES deals(deal_id),
        owner_id TEXT NOT NULL,
        order_bytes BLOB NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  close() { this.#db.close(); }

  // Trusted fixture import only. Revised terms require a new deal ID: deals
  // are immutable, avoiding an unsigned edit to a previously signed version.
  seedFixtureDeal({ dealId, ownerId, recipient, testAmountLamports, terms }) {
    const badField = [
      ['deal id', typeof dealId !== 'string' || !ID.test(dealId)],
      ['owner id', typeof ownerId !== 'string' || !UUID.test(ownerId)],
      ['recipient', !isAddress(recipient)],
      ['amount', typeof testAmountLamports !== 'string' || !AMOUNT.test(testAmountLamports) ||
        BigInt(testAmountLamports) > 1_000_000n],
    ].find(([, invalid]) => invalid)?.[0];
    if (badField) throw new Error(`invalid fixture deal: ${badField}`);
    if (!this.#owners.owner(ownerId)) throw new Error('unknown fixture owner');
    const termsJson = validateTerms(terms);
    const termsHash = hash(Buffer.from(termsJson));
    this.#db.prepare(`INSERT INTO deals
      (deal_id, owner_id, recipient, test_amount_lamports, terms_json, terms_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      dealId, ownerId, recipient, testAmountLamports, termsJson, termsHash, this.#now(),
    );
    return { dealId, termsHash };
  }

  deal(dealId) {
    if (!ID.test(dealId)) throw new Error('invalid deal id');
    const row = this.#db.prepare('SELECT * FROM deals WHERE deal_id = ?').get(dealId);
    return row && {
      dealId: row.deal_id, ownerId: row.owner_id, recipient: row.recipient,
      testAmountLamports: row.test_amount_lamports, terms: JSON.parse(row.terms_json),
      termsHash: row.terms_hash,
    };
  }

  createTransferChallenge(dealId) {
    const deal = this.deal(dealId);
    if (!deal) throw new Error('unknown deal');
    const owner = this.#owners.owner(deal.ownerId);
    if (!owner) throw new Error('unknown owner');
    const nonce = randomUUID();
    const expiresAt = this.#now() + ORDER_TTL_MS;
    const order = {
      version: 1, action: 'test_transfer', cluster: 'devnet',
      program_id: SYSTEM_PROGRAM_ID, owner_id: owner.ownerId,
      deal_id: deal.dealId, wallet_address: owner.walletAddress,
      recipient: deal.recipient, amount_lamports: deal.testAmountLamports,
      terms_hash: deal.termsHash, auth_epoch: owner.authEpoch,
      nonce, expires_at: expiresAt,
    };
    const orderBytes = Buffer.from(JSON.stringify(order));
    this.#db.prepare(`INSERT INTO challenges
      (challenge_id, deal_id, owner_id, order_bytes, expires_at)
      VALUES (?, ?, ?, ?, ?)`).run(nonce, deal.dealId, owner.ownerId, orderBytes, expiresAt);
    return {
      challengeId: nonce,
      bytesBase64url: orderBytes.toString('base64url'),
      display: {
        dealId: deal.dealId, commodity: deal.terms.commodity,
        quantityKg: deal.terms.quantity_kg,
        totalPriceKzt: deal.terms.total_price_kzt,
        recipient: deal.recipient, testAmountLamports: deal.testAmountLamports,
        termsHash: deal.termsHash, expiresAt,
      },
    };
  }

  async submitTransfer({ challengeId, signature, certificateId }) {
    if (!UUID.test(challengeId)) throw new Error('invalid challenge id');
    const row = this.#db.prepare('SELECT * FROM challenges WHERE challenge_id = ?').get(challengeId);
    if (!row) throw new Error('unknown challenge');
    if (row.expires_at <= this.#now()) throw new Error('challenge expired');
    const grant = await this.#issuer.issue({
      orderBytes: Buffer.from(row.order_bytes), signature, certificateId,
    });
    const result = await this.#signer.transfer(grant.envelope);
    return {
      dealId: row.deal_id, challengeId, status: result.status,
      txId: result.tx_id, simulated: result.simulated,
      replayed: result.replayed || grant.replayed,
    };
  }
}
