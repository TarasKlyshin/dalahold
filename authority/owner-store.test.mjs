import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerStore } from './owner-store.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dalahold-owner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'owners.sqlite');
}

const owner = {
  ownerId: 'test-owner', subjectId: 'test-subject',
  certificateId: 'cert-1', walletAddress: 'test-wallet',
};

test('replacement keeps wallet, increments epoch and rejects stale/foreign credentials', (t) => {
  const store = new OwnerStore(fixture(t));
  t.after(() => store.close());
  assert.equal(store.registerVerifiedOwner(owner).authEpoch, 0);
  const rotated = store.rotateVerifiedCertificate({
    ownerId: owner.ownerId, subjectId: owner.subjectId,
    previousCertificateId: 'cert-1', newCertificateId: 'cert-2', nonce: 'rotate-1',
  });
  assert.equal(rotated.walletAddress, owner.walletAddress);
  assert.equal(rotated.authEpoch, 1);
  assert.equal(rotated.certificateId, 'cert-2');
  assert.throws(() => store.rotateVerifiedCertificate({
    ownerId: owner.ownerId, subjectId: owner.subjectId,
    previousCertificateId: 'cert-1', newCertificateId: 'cert-3', nonce: 'rotate-2',
  }), /stale/);
  assert.throws(() => store.rotateVerifiedCertificate({
    ownerId: owner.ownerId, subjectId: 'someone-else',
    previousCertificateId: 'cert-2', newCertificateId: 'cert-3', nonce: 'rotate-3',
  }), /foreign/);
  assert.throws(() => store.rotateVerifiedCertificate({
    ownerId: owner.ownerId, subjectId: owner.subjectId,
    previousCertificateId: 'cert-2', newCertificateId: 'cert-3', nonce: 'rotate-1',
  }), /replay/);
  assert.deepEqual(store.owner(owner.ownerId), rotated);
});

test('nonce cannot be consumed twice, even after restart or on another connection', (t) => {
  const path = fixture(t);
  const a = new OwnerStore(path);
  a.registerVerifiedOwner(owner);
  const b = new OwnerStore(path);
  assert.equal(a.consumeNonce(owner.ownerId, 'operation-1'), true);
  assert.equal(b.consumeNonce(owner.ownerId, 'operation-1'), false);
  a.close();
  b.close();
  const reopened = new OwnerStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.consumeNonce(owner.ownerId, 'operation-1'), false);
  assert.equal(reopened.consumeNonce(owner.ownerId, 'operation-2'), true);
  assert.deepEqual(reopened.owner(owner.ownerId), { ...owner, authEpoch: 0 });
});

test('duplicate owner and malformed identifiers fail closed', (t) => {
  const store = new OwnerStore(fixture(t));
  t.after(() => store.close());
  store.registerVerifiedOwner(owner);
  assert.throws(() => store.registerVerifiedOwner(owner), /UNIQUE/);
  assert.throws(() => store.registerVerifiedOwner({
    ...owner, ownerId: 'another-owner', certificateId: 'another-cert',
  }), /UNIQUE/);
  assert.throws(() => store.consumeNonce(owner.ownerId, 'bad:nonce/route'), /invalid nonce/);
  assert.throws(() => store.consumeNonce('unknown', 'nonce-1'), /unknown owner/);
});

test('grant reservation is durable, idempotent, and invalidated by rotation', (t) => {
  const path = fixture(t);
  const store = new OwnerStore(path);
  store.registerVerifiedOwner(owner);
  const orderHash = 'a'.repeat(64);
  const input = { ...owner, authEpoch: 0, nonce: 'grant-1', orderHash, envelope: '{"grant":1}' };
  assert.deepEqual(store.saveVerifiedGrant(input), { envelope: input.envelope, replayed: false });
  assert.deepEqual(store.saveVerifiedGrant({ ...input, envelope: '{"grant":2}' }),
    { envelope: input.envelope, replayed: true });
  assert.throws(() => store.saveVerifiedGrant({ ...input, nonce: 'other-nonce' }), /grant conflict/);
  assert.throws(() => store.saveVerifiedGrant({ ...input, orderHash: 'b'.repeat(64) }), /replay/);
  store.close();

  const reopened = new OwnerStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.saveVerifiedGrant(input), { envelope: input.envelope, replayed: true });
  reopened.rotateVerifiedCertificate({
    ownerId: owner.ownerId, subjectId: owner.subjectId,
    previousCertificateId: 'cert-1', newCertificateId: 'cert-2', nonce: 'rotate-1',
  });
  assert.throws(() => reopened.saveVerifiedGrant(input), /stale authority/);
});
