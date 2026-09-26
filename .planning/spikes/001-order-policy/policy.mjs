import { createHash } from 'node:crypto';

const TRANSFER_FIELDS = [
  'version', 'action', 'cluster', 'program_id', 'owner_id', 'deal_id',
  'wallet_address', 'recipient', 'amount_lamports', 'terms_hash',
  'auth_epoch', 'nonce', 'expires_at',
];
const REBIND_FIELDS = [
  'version', 'action', 'owner_id', 'new_certificate_id', 'nonce', 'expires_at',
];
const SIMPLE_ID = /^[A-Za-z0-9:_-]{1,128}$/;

function canonical(value, fields, action) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error('unexpected fields');
  }
  if (value.version !== 1 || value.action !== action ||
      !Number.isSafeInteger(value.expires_at) || value.expires_at <= 0 ||
      !SIMPLE_ID.test(value.owner_id) || !SIMPLE_ID.test(value.nonce)) {
    throw new Error('invalid instruction');
  }
  if (action === 'test_transfer') {
    if (value.cluster !== 'devnet' ||
        value.program_id !== '11111111111111111111111111111111' ||
        !['deal_id', 'wallet_address', 'recipient'].every((key) => SIMPLE_ID.test(value[key])) ||
        !/^[1-9][0-9]{0,19}$/.test(value.amount_lamports) ||
        BigInt(value.amount_lamports) > 18446744073709551615n ||
        !/^[a-f0-9]{64}$/.test(value.terms_hash) ||
        !Number.isSafeInteger(value.auth_epoch) || value.auth_epoch < 0) {
      throw new Error('invalid transfer');
    }
  } else if (!SIMPLE_ID.test(value.new_certificate_id)) {
    throw new Error('invalid certificate id');
  }
  return Buffer.from(JSON.stringify(Object.fromEntries(fields.map((field) => [field, value[field]]))));
}

export const transferBytes = (value) => canonical(value, TRANSFER_FIELDS, 'test_transfer');
export const rebindBytes = (value) => canonical(value, REBIND_FIELDS, 'rebind_certificate');

function decode(bytes, encode) {
  if (!Buffer.isBuffer(bytes)) throw new Error('bytes required');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('invalid JSON'); }
  if (!encode(value).equals(bytes)) throw new Error('non-canonical bytes');
  return value;
}

export class PolicySpike {
  #owners = new Map();
  #nonces = new Set();
  #approvals = new Map();
  #verifySigned;
  #now;

  constructor({ verifySigned, now = Date.now }) {
    if (typeof verifySigned !== 'function') throw new Error('verifier required');
    this.#verifySigned = verifySigned;
    this.#now = now;
  }

  // Fixture only. Production registration requires a separately verified NCA challenge.
  seedPerson({ ownerId, subjectId, certificateId, walletAddress }) {
    if ([ownerId, subjectId, certificateId, walletAddress].some((id) => !SIMPLE_ID.test(id))) {
      throw new Error('invalid owner');
    }
    if (this.#owners.has(ownerId)) throw new Error('owner exists');
    this.#owners.set(ownerId, { subjectId, certificateId, walletAddress, authEpoch: 0 });
  }

  owner(ownerId) {
    const owner = this.#owners.get(ownerId);
    return owner && { ...owner };
  }

  async #checkIdentity(bytes, signature, certificateId, ownerId) {
    const owner = this.#owners.get(ownerId);
    if (!owner) throw new Error('unknown owner');
    const identity = await this.#verifySigned(bytes, signature, certificateId);
    if (!identity || identity.status !== 'valid' || identity.certificateId !== certificateId ||
        identity.subjectId !== owner.subjectId) {
      throw new Error('signature or certificate rejected');
    }
    return owner;
  }

  #checkFresh(value) {
    if (value.expires_at <= this.#now()) throw new Error('expired');
    const key = `${value.owner_id}:${value.nonce}`;
    if (this.#nonces.has(key)) throw new Error('replay');
    return key;
  }

  async authorize({ bytes, signature, certificateId }) {
    const order = decode(bytes, transferBytes);
    const owner = await this.#checkIdentity(bytes, signature, certificateId, order.owner_id);
    if (certificateId !== owner.certificateId || order.auth_epoch !== owner.authEpoch ||
        order.wallet_address !== owner.walletAddress) throw new Error('stale authority');
    const nonceKey = this.#checkFresh(order);
    this.#nonces.add(nonceKey);
    const approvalId = createHash('sha256').update(bytes).digest('hex');
    this.#approvals.set(approvalId, { order, used: false });
    return approvalId;
  }

  execute({ approvalId, instruction }) {
    const approval = this.#approvals.get(approvalId);
    if (!approval || approval.used) throw new Error('missing or spent approval');
    const { order } = approval;
    const owner = this.#owners.get(order.owner_id);
    if (!owner || owner.authEpoch !== order.auth_epoch) throw new Error('stale authority');
    const expected = {
      cluster: order.cluster,
      program_id: order.program_id,
      wallet_address: order.wallet_address,
      recipient: order.recipient,
      amount_lamports: order.amount_lamports,
    };
    if (!instruction || Object.keys(instruction).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => instruction[key] !== value)) {
      throw new Error('instruction mismatch');
    }
    approval.used = true;
    return { simulated: true, approvalId };
  }

  async rebind({ bytes, signature, certificateId }) {
    const challenge = decode(bytes, rebindBytes);
    const owner = await this.#checkIdentity(bytes, signature, certificateId, challenge.owner_id);
    if (certificateId !== challenge.new_certificate_id || certificateId === owner.certificateId) {
      throw new Error('invalid replacement');
    }
    const nonceKey = this.#checkFresh(challenge);
    this.#nonces.add(nonceKey);
    owner.certificateId = certificateId;
    owner.authEpoch += 1;
    return { walletAddress: owner.walletAddress, authEpoch: owner.authEpoch };
  }
}
