import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMarkerInput } from './markers.mjs';

const input = {
  expectedVersion: 2,
  requestId: 'fbe1e870-687c-4cf6-841c-37937c7e6716',
  category: 'veterinary',
  context: '  Партия КРС  ',
  note: '  Тестовая запись  ',
  claimedRole: 'seller',
  fileKind: 'pdf',
};

test('normalizes only the exact metadata envelope', () => {
  const result = normalizeMarkerInput(input, 'livestock');
  assert.deepEqual(result, { ...input, context: 'Партия КРС', note: 'Тестовая запись' });
  assert.deepEqual(input.context, '  Партия КРС  ');
  assert.notEqual(result, input);
  for (const category of ['animals', 'veterinary', 'handover', 'acceptance', 'settlement']) {
    assert.equal(normalizeMarkerInput({ ...input, category }, 'livestock').category, category);
  }
  for (const category of ['specification', 'waybill', 'weight', 'quality', 'acceptance', 'settlement']) {
    assert.equal(normalizeMarkerInput({ ...input, category }, 'grain').category, category);
  }
});

test('rejects category from the other scenario and generated terms', () => {
  for (const category of ['specification', 'weight', 'quality', 'terms']) {
    assert.throws(() => normalizeMarkerInput({ ...input, category }, 'livestock'), TypeError);
  }
  assert.throws(() => normalizeMarkerInput(input, 'grain'), TypeError);
  assert.throws(() => normalizeMarkerInput(input, 'other'), TypeError);
});

test('rejects extra, missing, inherited, accessor and non-enumerable fields', () => {
  for (const field of ['filename', 'fileBytes', 'hash', 'verified', 'approval', 'payment']) {
    assert.throws(() => normalizeMarkerInput({ ...input, [field]: 'forged' }, 'livestock'), TypeError);
  }
  const missing = { ...input };
  delete missing.note;
  assert.throws(() => normalizeMarkerInput(missing, 'livestock'), TypeError);
  assert.throws(() => normalizeMarkerInput(Object.create(input), 'livestock'), TypeError);
  assert.throws(() => normalizeMarkerInput(Object.defineProperty({ ...input }, 'note', {
    enumerable: false,
  }), 'livestock'), TypeError);
  let called = false;
  const getter = Object.defineProperty({ ...input }, 'note', {
    enumerable: true, get() { called = true; return ''; },
  });
  assert.throws(() => normalizeMarkerInput(getter, 'livestock'), TypeError);
  assert.equal(called, false);
  const polluted = JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(input).slice(1)}`);
  assert.throws(() => normalizeMarkerInput(polluted, 'livestock'), TypeError);
  assert.equal({}.polluted, undefined);
});

test('requires a positive version, UUID, claimed demo role and file kind', () => {
  for (const expectedVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
    assert.throws(() => normalizeMarkerInput({ ...input, expectedVersion }, 'livestock'), TypeError);
  }
  for (const requestId of ['FBE1E870-687C-4CF6-841C-37937C7E6716',
    '00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
    assert.throws(() => normalizeMarkerInput({ ...input, requestId }, 'livestock'), TypeError);
  }
  for (const claimedRole of ['admin', 'Seller', '']) {
    assert.throws(() => normalizeMarkerInput({ ...input, claimedRole }, 'livestock'), TypeError);
  }
  for (const fileKind of ['invoice.pdf', 'exe', 'PDF']) {
    assert.throws(() => normalizeMarkerInput({ ...input, fileKind }, 'livestock'), TypeError);
  }
});

test('bounded descriptions reject controls and invisible direction overrides', () => {
  assert.equal(normalizeMarkerInput({ ...input, context: '🐄'.repeat(80), note: '🌾'.repeat(120) }, 'livestock').context.length, 160);
  for (const field of ['context', 'note']) {
    for (const value of ['line\nnext', 'left\u202eright', '\u0000', '\ud800', 42]) {
      assert.throws(() => normalizeMarkerInput({ ...input, [field]: value }, 'livestock'), TypeError);
    }
  }
  assert.throws(() => normalizeMarkerInput({ ...input, context: '🐄'.repeat(81) }, 'livestock'), TypeError);
  assert.throws(() => normalizeMarkerInput({ ...input, note: '🌾'.repeat(121) }, 'livestock'), TypeError);
});
