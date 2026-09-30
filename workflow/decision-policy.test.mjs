import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTrustedDecision, createDealDecisionState } from './decision-policy.mjs';

const DEAL = '10000000-0000-4000-8000-000000000001';
const SELLER = '10000000-0000-4000-8000-000000000002';
const BUYER = '10000000-0000-4000-8000-000000000003';
const STRANGER = '10000000-0000-4000-8000-000000000004';
const FINGERPRINT = 'a'.repeat(64);
const base = { dealId: DEAL, sellerId: SELLER, buyerId: BUYER,
  termsVersion: 1, termsFingerprint: FINGERPRINT };

function decision(n, actorId, action, overrides = {}) {
  return {
    decisionId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    dealId: DEAL, actorId, action, termsVersion: 1, termsFingerprint: FINGERPRINT, ...overrides,
  };
}

function advance(state, n, actorId, action) {
  return applyTrustedDecision(state, decision(n, actorId, action)).state;
}

function toHandover() {
  let state = createDealDecisionState(base);
  state = advance(state, 1, SELLER, 'offer');
  state = advance(state, 2, BUYER, 'accept_terms');
  state = advance(state, 3, BUYER, 'reserve_demo');
  return advance(state, 4, SELLER, 'claim_handover');
}

test('ordered demo path ends with one rating per role and immutable inputs', () => {
  const start = createDealDecisionState(base);
  const offer = decision(1, SELLER, 'offer');
  const offered = applyTrustedDecision(start, offer);
  assert.equal(start.status, 'draft');
  assert.equal(start.events.length, 0);
  assert.equal(offered.state.status, 'offered');
  offer.action = 'open_dispute';
  assert.equal(offered.state.events[0].action, 'offer');

  let state = advance(offered.state, 2, BUYER, 'accept_terms');
  state = advance(state, 3, BUYER, 'reserve_demo');
  state = advance(state, 4, SELLER, 'claim_handover');
  state = advance(state, 5, BUYER, 'accept_delivery');
  state = advance(state, 6, BUYER, 'release_demo');
  assert.equal(state.status, 'completed_demo');
  state = advance(state, 7, SELLER, 'rate_counterparty_demo');
  state = advance(state, 8, BUYER, 'rate_counterparty_demo');
  assert.equal(state.events.length, 8);
  assert.equal(state.ratedBySeller, true);
  assert.equal(state.ratedByBuyer, true);
  assert.throws(() => advance(state, 9, SELLER, 'rate_counterparty_demo'), /already rated/);
});

test('exact retry is idempotent; same ID with altered fields conflicts', () => {
  const state = advance(createDealDecisionState(base), 1, SELLER, 'offer');
  const repeated = applyTrustedDecision(state, decision(1, SELLER, 'offer'));
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.state.events.length, 1);
  assert.notEqual(repeated.state, state);
  assert.notEqual(repeated.state.events[0], state.events[0]);
  assert.throws(() => applyTrustedDecision(state,
    decision(1, SELLER, 'offer', { termsFingerprint: 'b'.repeat(64) })), /conflict/);
  assert.throws(() => applyTrustedDecision(state,
    decision(1, BUYER, 'offer')), /conflict/);
});

test('actor, order, terms and forged state fail closed', () => {
  const state = createDealDecisionState(base);
  assert.throws(() => advance(state, 1, BUYER, 'offer'), /not allowed/);
  assert.throws(() => advance(state, 1, STRANGER, 'offer'), /unknown actor/);
  assert.throws(() => advance(state, 1, SELLER, 'accept_terms'), /not allowed/);
  assert.throws(() => applyTrustedDecision(state,
    decision(1, SELLER, 'offer', { termsVersion: 2 })), /stale or altered/);
  assert.throws(() => applyTrustedDecision(state,
    decision(1, SELLER, 'offer', { termsFingerprint: 'b'.repeat(64) })), /stale or altered/);
  assert.throws(() => applyTrustedDecision({ ...state, status: 'completed_demo' },
    decision(1, SELLER, 'offer')), /invalid decision state/);
  assert.throws(() => applyTrustedDecision(state,
    { ...decision(1, SELLER, 'offer'), claimedRole: 'buyer' }), /invalid decision/);
  assert.equal(state.events.length, 0);
});

test('dispute is terminal and cannot be released or rated', () => {
  const disputed = advance(toHandover(), 5, BUYER, 'open_dispute');
  assert.equal(disputed.status, 'disputed');
  assert.throws(() => advance(disputed, 6, BUYER, 'release_demo'), /not allowed/);
  assert.throws(() => advance(disputed, 6, SELLER, 'rate_counterparty_demo'), /not allowed/);
  assert.throws(() => advance(disputed, 6, BUYER, 'accept_delivery'), /not allowed/);
});

test('different deal and malformed identities cannot inherit an approval', () => {
  const other = createDealDecisionState({ ...base, dealId: '10000000-0000-4000-8000-000000000005' });
  const first = advance(createDealDecisionState(base), 1, SELLER, 'offer');
  assert.equal(other.status, 'draft');
  assert.equal(other.events.length, 0);
  assert.equal(first.dealId, DEAL);
  assert.throws(() => applyTrustedDecision(other,
    decision(1, SELLER, 'offer')), /another deal/);
  assert.throws(() => createDealDecisionState({ ...base, buyerId: SELLER }), /invalid deal identity/);
  assert.throws(() => createDealDecisionState({ ...base, termsFingerprint: 'A'.repeat(64) }), /invalid deal identity/);
});
