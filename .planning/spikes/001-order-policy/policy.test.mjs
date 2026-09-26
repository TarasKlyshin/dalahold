import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import { PolicySpike, rebindBytes, transferBytes } from './policy.mjs';

function fixture() {
  const certs = new Map();
  for (const [id, subjectId] of [['cert-old', 'person-1'], ['cert-new', 'person-1'], ['cert-other', 'person-2']]) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    certs.set(id, { subjectId, privateKey, publicKey, status: 'valid' });
  }
  const policy = new PolicySpike({
    now: () => 1000,
    verifySigned: async (bytes, signature, id) => {
      const cert = certs.get(id);
      return cert && verify(null, bytes, cert.publicKey, signature)
        ? { certificateId: id, subjectId: cert.subjectId, status: cert.status }
        : null;
    },
  });
  policy.seedPerson({ ownerId: 'owner-1', subjectId: 'person-1', certificateId: 'cert-old', walletAddress: 'test-wallet-1' });
  let nonce = 0;
  const order = (changes = {}) => ({
    version: 1, action: 'test_transfer', cluster: 'devnet',
    program_id: '11111111111111111111111111111111',
    owner_id: 'owner-1', deal_id: 'deal-1', wallet_address: 'test-wallet-1',
    recipient: 'test-recipient-1', amount_lamports: '1200',
    terms_hash: createHash('sha256').update('test terms').digest('hex'),
    auth_epoch: policy.owner('owner-1').authEpoch,
    nonce: `nonce-${++nonce}`, expires_at: 2000, ...changes,
  });
  const signed = (bytes, id = 'cert-old') => ({
    bytes, certificateId: id, signature: sign(null, bytes, certs.get(id).privateKey),
  });
  const instruction = (value) => ({
    cluster: value.cluster, program_id: value.program_id,
    wallet_address: value.wallet_address, recipient: value.recipient,
    amount_lamports: value.amount_lamports,
  });
  return { certs, policy, order, signed, instruction };
}

test('one exact transfer passes once; direct bypass and replay fail', async () => {
  const f = fixture();
  const order = f.order();
  const approvalId = await f.policy.authorize(f.signed(transferBytes(order)));
  assert.deepEqual(f.policy.execute({ approvalId, instruction: f.instruction(order) }), { simulated: true, approvalId });
  assert.throws(() => f.policy.execute({ approvalId, instruction: f.instruction(order) }), /spent/);
  assert.throws(() => f.policy.execute({ approvalId: 'forged', instruction: f.instruction(order) }), /missing/);
  await assert.rejects(f.policy.authorize(f.signed(transferBytes(order))), /replay/);
});

test('signed bytes and executable instruction cannot be changed', async () => {
  const f = fixture();
  const order = f.order();
  const signed = f.signed(transferBytes(order));
  await assert.rejects(f.policy.authorize({ ...signed, bytes: transferBytes({ ...order, amount_lamports: '1201' }) }), /rejected/);
  await assert.rejects(f.policy.authorize({ ...signed, bytes: transferBytes({ ...order, recipient: 'attacker' }) }), /rejected/);
  const reordered = Buffer.from(JSON.stringify({ action: order.action, version: order.version, ...order }));
  await assert.rejects(f.policy.authorize(f.signed(reordered)), /non-canonical/);
  const approvalId = await f.policy.authorize(signed);
  assert.throws(() => f.policy.execute({ approvalId, instruction: { ...f.instruction(order), recipient: 'attacker' } }), /mismatch/);
  assert.throws(() => f.policy.execute({ approvalId, instruction: { ...f.instruction(order), amount_lamports: '1201' } }), /mismatch/);
  assert.equal(f.policy.execute({ approvalId, instruction: f.instruction(order) }).simulated, true);
});

test('parallel replay receives only one approval', async () => {
  const f = fixture();
  const request = f.signed(transferBytes(f.order()));
  const results = await Promise.allSettled([f.policy.authorize(request), f.policy.authorize(request)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
});

test('revoked, unknown, expired and foreign credentials fail closed', async () => {
  const f = fixture();
  f.certs.get('cert-old').status = 'revoked';
  await assert.rejects(f.policy.authorize(f.signed(transferBytes(f.order()))), /rejected/);
  f.certs.get('cert-old').status = 'unknown';
  await assert.rejects(f.policy.authorize(f.signed(transferBytes(f.order()))), /rejected/);
  f.certs.get('cert-old').status = 'valid';
  await assert.rejects(f.policy.authorize(f.signed(transferBytes(f.order({ expires_at: 1000 })))), /expired/);
  await assert.rejects(f.policy.authorize(f.signed(transferBytes(f.order()), 'cert-other')), /rejected/);
});

test('new certificate retains wallet and revokes old access and approvals', async () => {
  const f = fixture();
  const oldOrder = f.order();
  const oldApproval = await f.policy.authorize(f.signed(transferBytes(oldOrder)));
  f.certs.get('cert-old').status = 'revoked';
  const rebind = rebindBytes({
    version: 1, action: 'rebind_certificate', owner_id: 'owner-1',
    new_certificate_id: 'cert-new', nonce: 'rebind-1', expires_at: 2000,
  });
  assert.deepEqual(await f.policy.rebind(f.signed(rebind, 'cert-new')),
    { walletAddress: 'test-wallet-1', authEpoch: 1 });
  assert.throws(() => f.policy.execute({ approvalId: oldApproval, instruction: f.instruction(oldOrder) }), /stale/);
  await assert.rejects(f.policy.authorize(f.signed(transferBytes(f.order({ auth_epoch: 0 })), 'cert-new')), /stale/);
  f.certs.get('cert-old').status = 'valid'; // Still valid at the test CA, but no longer allowed here.
  await assert.rejects(f.policy.authorize(f.signed(transferBytes(f.order()), 'cert-old')), /stale/);
  const newOrder = f.order();
  const newApproval = await f.policy.authorize(f.signed(transferBytes(newOrder), 'cert-new'));
  assert.equal(f.policy.execute({ approvalId: newApproval, instruction: f.instruction(newOrder) }).simulated, true);
});

test('another person cannot rebind even with a valid signature', async () => {
  const f = fixture();
  const bytes = rebindBytes({
    version: 1, action: 'rebind_certificate', owner_id: 'owner-1',
    new_certificate_id: 'cert-other', nonce: 'rebind-2', expires_at: 2000,
  });
  await assert.rejects(f.policy.rebind(f.signed(bytes, 'cert-other')), /rejected/);
  assert.equal(f.policy.owner('owner-1').certificateId, 'cert-old');
});
