import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspect } from 'node:util';
import { canonicalDraftTerms, fingerprintDraftTerms } from './terms.mjs';

const terms = {
  dealId: 'fbe1e870-687c-4cf6-841c-37937c7e6716', version: 1,
  scenario: 'livestock', quantity: 12, amount: 8_400_000, date: '2026-10-10',
};
const canonical = 'dalahold.unsigned-local-draft-terms.v1\n' +
  'dealId=fbe1e870-687c-4cf6-841c-37937c7e6716\nversion=1\nscenario=livestock\n' +
  'quantity=12\namount=8400000\ndate=2026-10-10\n';
const invalid = (reason) => ({ name: 'TypeError', message: `invalid draft terms: ${reason}` });

function permutations(items) {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]));
}

test('canonical terms are schema-prefixed UTF-8 lines in a fixed field order', () => {
  const bytes = canonicalDraftTerms(terms);
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual(bytes, Buffer.from(canonical, 'utf8'));
  const fingerprint = fingerprintDraftTerms(terms);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, createHash('sha256').update(canonical, 'utf8').digest('hex'));
});

test('input key order does not change canonical bytes or fingerprint', () => {
  const orders = permutations(Object.keys(terms));
  assert.equal(orders.length, 720);
  for (const order of orders) {
    const reordered = Object.freeze(Object.fromEntries(order.map((key) => [key, terms[key]])));
    assert.deepEqual(Object.keys(reordered), order);
    assert.deepEqual(canonicalDraftTerms(reordered), Buffer.from(canonical, 'utf8'));
  }
  const bare = Object.assign(Object.create(null), terms);
  assert.equal(fingerprintDraftTerms(bare), fingerprintDraftTerms(terms));
});

test('fingerprint binds deal identity, version and each term value', () => {
  const variants = [
    terms,
    { ...terms, dealId: '0b6f5a2e-3c1d-4e8f-9a7b-5c4d3e2f1a0b' },
    { ...terms, version: 2 },
    { ...terms, scenario: 'grain' },
    { ...terms, quantity: 13 },
    { ...terms, amount: 8_400_001 },
    { ...terms, date: '2026-10-11' },
    // The same digits split differently across fields must still differ.
    { ...terms, quantity: 128, amount: 400_000 },
  ];
  const fingerprints = variants.map((variant) => fingerprintDraftTerms(variant));
  assert.equal(new Set(fingerprints).size, variants.length);
  assert.equal(fingerprintDraftTerms({ ...terms }), fingerprints[0]);
});

test('malformed identity, version and term values are rejected', () => {
  const malformed = {
    dealId: [
      undefined, null, 42, '', 'not-a-uuid',
      'FBE1E870-687C-4CF6-841C-37937C7E6716',
      'fbe1e870687c4cf6841c37937c7e6716',
      '{fbe1e870-687c-4cf6-841c-37937c7e6716}',
      'urn:uuid:fbe1e870-687c-4cf6-841c-37937c7e6716',
      'fbe1e870-687c-4cf6-841c-37937c7e6716\n',
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'fbe1e870-687c-4cf6-c41c-37937c7e6716',
      { toString: () => terms.dealId },
    ],
    version: [undefined, null, 0, -1, 1.5, '1', 1n, true, NaN, Infinity, 2 ** 53],
    scenario: [undefined, null, '', 'Livestock', 'dairy', 'grain ', 'grain\namount=1', ['grain']],
    quantity: [undefined, null, 0, -12, 12.5, '12', 12n, NaN, Number.MAX_SAFE_INTEGER + 1],
    amount: [undefined, null, 0, -0, -8_400_000, 0.5, '8400000', 8_400_000n, Infinity, 2 ** 53],
    date: [
      undefined, null, 20261010, new Date('2026-10-10T00:00:00Z'), '',
      '2026-02-30', '2025-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-04-31',
      '2026-10-1', '26-10-10', '+002026-10-10', '2026/10/10', '2026-10-10T00:00:00Z',
      ' 2026-10-10', '2026-10-10\n', '２０２６-10-10',
    ],
  };
  for (const [field, values] of Object.entries(malformed)) {
    for (const value of values) {
      const label = `${field}=${inspect(value)}`;
      assert.throws(() => canonicalDraftTerms({ ...terms, [field]: value }), invalid(field), label);
      assert.throws(() => fingerprintDraftTerms({ ...terms, [field]: value }), invalid(field), label);
    }
  }
});

test('valid calendar, UUID and integer edges are encoded exactly', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-01-01', '2026-12-31']) {
    assert.ok(canonicalDraftTerms({ ...terms, date }).toString('utf8').endsWith(`\ndate=${date}\n`), date);
  }
  const edge = {
    ...terms, dealId: '01928c6e-7b3a-7d4e-8f5a-1b2c3d4e5f60', version: Number.MAX_SAFE_INTEGER,
    scenario: 'grain', quantity: 1, amount: Number.MAX_SAFE_INTEGER,
  };
  assert.equal(canonicalDraftTerms(edge).toString('utf8'),
    'dalahold.unsigned-local-draft-terms.v1\ndealId=01928c6e-7b3a-7d4e-8f5a-1b2c3d4e5f60\n' +
    'version=9007199254740991\nscenario=grain\nquantity=1\namount=9007199254740991\ndate=2026-10-10\n');
});

test('only the six own term fields are accepted', () => {
  for (const extra of ['iin', 'bin', 'documents', 'participants', 'buyer', 'seller',
    'recipient', 'signature', 'approved', 'expectedVersion', 'createdAt']) {
    assert.throws(() => canonicalDraftTerms({ ...terms, [extra]: undefined }), invalid('keys'), extra);
  }
  for (const field of Object.keys(terms)) {
    const missing = { ...terms };
    delete missing[field];
    assert.throws(() => fingerprintDraftTerms(missing), invalid('keys'), field);
    // An inherited value never stands in for an own field.
    const inherited = Object.assign(Object.create({ [field]: terms[field] }), missing);
    assert.throws(() => fingerprintDraftTerms(inherited), invalid('keys'), field);
  }
  assert.throws(() => canonicalDraftTerms({ ...terms, [Symbol('iin')]: 'x' }), invalid('keys'));
  assert.throws(() => canonicalDraftTerms(Object.defineProperty({ ...terms }, 'bin', { value: 'x' })),
    invalid('keys'));
  // A stored server row must be mapped explicitly; its id and createdAt are not terms.
  const { dealId: id, ...row } = terms;
  assert.throws(() => canonicalDraftTerms({ id, ...row, createdAt: 1_000 }), invalid('keys'));
  assert.throws(() => canonicalDraftTerms(new Map(Object.entries(terms))), invalid('keys'));
  for (const value of [undefined, null, 'terms', 42, [], [terms], () => terms]) {
    assert.throws(() => canonicalDraftTerms(value), invalid('object'), inspect(value));
  }
});

test('each field is read once, so a changing getter cannot inject a line', () => {
  let reads = 0;
  const shifting = Object.defineProperty({ ...terms }, 'scenario', {
    enumerable: true, get: () => (++reads === 1 ? 'grain' : 'grain\namount=1'),
  });
  assert.deepEqual(canonicalDraftTerms(shifting), canonicalDraftTerms({ ...terms, scenario: 'grain' }));
  assert.equal(reads, 1);
});
