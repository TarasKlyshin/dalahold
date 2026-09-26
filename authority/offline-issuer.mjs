// Offline-only issuer contract. The injected verifier is a test double until
// the official NCA SDK and test certificates are available.
import { createHash, randomUUID, sign } from 'node:crypto';
import { MAX_AMOUNT_LAMPORTS, MAX_GRANT_TTL_MS, SIGNING_PREFIX,
  SYSTEM_PROGRAM_ID } from '../signer/signer.mjs';

const FIELDS = [
  'version', 'action', 'cluster', 'program_id', 'owner_id', 'deal_id',
  'wallet_address', 'recipient', 'amount_lamports', 'terms_hash',
  'auth_epoch', 'nonce', 'expires_at',
];
const REBIND_FIELDS = ['version', 'action', 'owner_id', 'new_certificate_id', 'nonce', 'expires_at'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;

function decodeOrder(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('order bytes required');
  let order;
  try { order = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('invalid order JSON'); }
  if (!order || typeof order !== 'object' || Array.isArray(order) ||
      Object.keys(order).length !== FIELDS.length ||
      FIELDS.some((field) => !Object.hasOwn(order, field)) ||
      JSON.stringify(Object.fromEntries(FIELDS.map((field) => [field, order[field]]))) !== bytes.toString('utf8')) {
    throw new Error('non-canonical order');
  }
  if (order.version !== 1 || order.action !== 'test_transfer' ||
      order.cluster !== 'devnet' || order.program_id !== SYSTEM_PROGRAM_ID ||
      !UUID.test(order.owner_id) || !ID.test(order.deal_id) || !ID.test(order.nonce) ||
      typeof order.wallet_address !== 'string' || typeof order.recipient !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(order.amount_lamports) ||
      BigInt(order.amount_lamports) > MAX_AMOUNT_LAMPORTS ||
      !/^[a-f0-9]{64}$/.test(order.terms_hash) ||
      !Number.isSafeInteger(order.auth_epoch) || order.auth_epoch < 0 ||
      !Number.isSafeInteger(order.expires_at) || order.expires_at <= 0) {
    throw new Error('invalid order');
  }
  return order;
}

function decodeRebind(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('rebind bytes required');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('invalid rebind JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== REBIND_FIELDS.length ||
      REBIND_FIELDS.some((field) => !Object.hasOwn(value, field)) ||
      JSON.stringify(Object.fromEntries(REBIND_FIELDS.map((field) => [field, value[field]]))) !== bytes.toString('utf8') ||
      value.version !== 1 || value.action !== 'rebind_certificate' ||
      !UUID.test(value.owner_id) || !ID.test(value.new_certificate_id) || !ID.test(value.nonce) ||
      !Number.isSafeInteger(value.expires_at) || value.expires_at <= 0) {
    throw new Error('invalid rebind');
  }
  return value;
}

function envelopeFor(value, privateKey) {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({
    payload: payload.toString('base64url'),
    sig: sign(null, Buffer.concat([SIGNING_PREFIX, payload]), privateKey).toString('base64url'),
  });
}

export class OfflineIssuer {
  #store;
  #verifySigned;
  #verifyPowers;
  #policyPrivateKey;
  #now;

  constructor({ store, verifySigned, verifyPowers, policyPrivateKey, now = Date.now }) {
    if (!store || typeof store.saveVerifiedGrant !== 'function' ||
        typeof verifySigned !== 'function' || typeof verifyPowers !== 'function' ||
        !policyPrivateKey || typeof now !== 'function') {
      throw new Error('issuer dependencies required');
    }
    this.#store = store;
    this.#verifySigned = verifySigned;
    this.#verifyPowers = verifyPowers;
    this.#policyPrivateKey = policyPrivateKey;
    this.#now = now;
  }

  async issue({ orderBytes, signature, certificateId }) {
    const order = decodeOrder(orderBytes);
    const now = this.#now();
    if (order.expires_at <= now) throw new Error('order expired');
    const identity = await this.#verifySigned(orderBytes, signature, certificateId);
    if (!identity || identity.status !== 'valid' || identity.certificateId !== certificateId ||
        typeof identity.subjectId !== 'string') throw new Error('identity rejected');
    if (await this.#verifyPowers(order.owner_id, identity.subjectId, 'test_transfer') !== true) {
      throw new Error('powers rejected');
    }
    const owner = this.#store.owner(order.owner_id);
    if (!owner || owner.subjectId !== identity.subjectId || owner.certificateId !== certificateId ||
        owner.walletAddress !== order.wallet_address || owner.authEpoch !== order.auth_epoch) {
      throw new Error('stale authority');
    }
    const expiresAt = Math.min(order.expires_at, now + Math.min(MAX_GRANT_TTL_MS, 60_000));
    const orderHash = createHash('sha256').update(orderBytes).digest('hex');
    const grant = {
      v: 1, kind: 'test_transfer', grant_id: randomUUID(), owner_id: order.owner_id,
      auth_epoch: owner.authEpoch, cluster: 'devnet', expires_at: expiresAt,
      order_hash: orderHash, wallet_address: owner.walletAddress,
      program_id: SYSTEM_PROGRAM_ID, asset: 'SOL', recipient: order.recipient,
      amount_lamports: order.amount_lamports, max_fee_lamports: '5000',
    };
    const envelope = envelopeFor(grant, this.#policyPrivateKey);
    return this.#store.saveVerifiedGrant({
      ownerId: owner.ownerId, subjectId: identity.subjectId, certificateId,
      authEpoch: order.auth_epoch, walletAddress: owner.walletAddress,
      dealId: order.deal_id, nonce: order.nonce, orderHash, envelope,
    });
  }

  async rebind({ rebindBytes, signature, certificateId, notifySigner }) {
    if (typeof notifySigner !== 'function') throw new Error('signer notice required');
    const request = decodeRebind(rebindBytes);
    if (request.new_certificate_id !== certificateId || request.expires_at <= this.#now()) {
      throw new Error('invalid replacement');
    }
    const identity = await this.#verifySigned(rebindBytes, signature, certificateId);
    if (!identity || identity.status !== 'valid' || identity.certificateId !== certificateId ||
        typeof identity.subjectId !== 'string') throw new Error('identity rejected');
    if (await this.#verifyPowers(request.owner_id, identity.subjectId, 'rebind_certificate') !== true) {
      throw new Error('powers rejected');
    }
    const owner = this.#store.owner(request.owner_id);
    if (!owner || owner.subjectId !== identity.subjectId || owner.certificateId === certificateId) {
      throw new Error('stale authority');
    }
    const nextEpoch = owner.authEpoch + 1;
    const notice = envelopeFor({
      v: 1, kind: 'epoch', owner_id: request.owner_id, auth_epoch: nextEpoch,
    }, this.#policyPrivateKey);
    const acknowledged = await notifySigner(notice);
    if (!acknowledged || acknowledged.owner_id !== request.owner_id ||
        acknowledged.auth_epoch !== nextEpoch) throw new Error('epoch not acknowledged');
    return this.#store.rotateVerifiedCertificate({
      ownerId: request.owner_id, subjectId: identity.subjectId,
      previousCertificateId: owner.certificateId, newCertificateId: certificateId,
      nonce: request.nonce,
    });
  }
}
