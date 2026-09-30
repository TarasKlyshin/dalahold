// Pure offline state machine. actorId is supplied by a trusted test fixture;
// this module does not verify NCA signatures, identities or real payments.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STATE_KEYS = [
  'dealId', 'sellerId', 'buyerId', 'termsVersion', 'termsFingerprint',
  'status', 'ratedBySeller', 'ratedByBuyer', 'events',
];
const BASE_KEYS = STATE_KEYS.slice(0, 5);
const DECISION_KEYS = ['decisionId', 'dealId', 'actorId', 'action', 'termsVersion', 'termsFingerprint'];

const transitions = Object.freeze({
  offer: { from: 'draft', to: 'offered', role: 'seller' },
  accept_terms: { from: 'offered', to: 'agreed', role: 'buyer' },
  reserve_demo: { from: 'agreed', to: 'demo_reserved', role: 'buyer' },
  claim_handover: { from: 'demo_reserved', to: 'handover_claimed', role: 'seller' },
  accept_delivery: { from: 'handover_claimed', to: 'delivery_accepted', role: 'buyer' },
  open_dispute: { from: 'handover_claimed', to: 'disputed', role: 'buyer' },
  release_demo: { from: 'delivery_accepted', to: 'completed_demo', role: 'buyer' },
  rate_counterparty_demo: { from: 'completed_demo', to: 'completed_demo', role: 'either' },
});

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`invalid ${label}`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
  })) throw new Error(`invalid ${label}`);
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function validateBase(input) {
  const base = exactRecord(input, BASE_KEYS, 'deal identity');
  if (![base.dealId, base.sellerId, base.buyerId].every(
    (value) => typeof value === 'string' && UUID.test(value)) ||
      base.sellerId === base.buyerId ||
      !Number.isSafeInteger(base.termsVersion) || base.termsVersion < 1 ||
      typeof base.termsFingerprint !== 'string' || !SHA256.test(base.termsFingerprint)) {
    throw new Error('invalid deal identity');
  }
  return base;
}

function validateDecision(input) {
  const decision = exactRecord(input, DECISION_KEYS, 'decision');
  if (![decision.decisionId, decision.dealId, decision.actorId].every(
    (value) => typeof value === 'string' && UUID.test(value)) ||
      typeof decision.action !== 'string' || !Object.hasOwn(transitions, decision.action) ||
      !Number.isSafeInteger(decision.termsVersion) || decision.termsVersion < 1 ||
      typeof decision.termsFingerprint !== 'string' || !SHA256.test(decision.termsFingerprint)) {
    throw new Error('invalid decision');
  }
  return decision;
}

function advance(state, decision) {
  if (decision.dealId !== state.dealId) throw new Error('decision belongs to another deal');
  const duplicate = state.events.find((event) => event.decisionId === decision.decisionId);
  if (duplicate) {
    if (DECISION_KEYS.some((key) => duplicate[key] !== decision[key])) {
      throw new Error('decision id conflict');
    }
    return { state: { ...state, events: state.events.map((event) => ({ ...event })) }, replayed: true };
  }
  if (decision.termsVersion !== state.termsVersion ||
      decision.termsFingerprint !== state.termsFingerprint) {
    throw new Error('stale or altered terms');
  }
  const role = decision.actorId === state.sellerId ? 'seller'
    : decision.actorId === state.buyerId ? 'buyer' : undefined;
  if (!role) throw new Error('unknown actor');
  const rule = transitions[decision.action];
  if (state.status !== rule.from || (rule.role !== 'either' && role !== rule.role)) {
    throw new Error('decision not allowed');
  }
  if (decision.action === 'rate_counterparty_demo' &&
      (role === 'seller' ? state.ratedBySeller : state.ratedByBuyer)) {
    throw new Error('counterparty already rated');
  }
  return {
    state: {
      ...state,
      status: rule.to,
      ratedBySeller: state.ratedBySeller ||
        (decision.action === 'rate_counterparty_demo' && role === 'seller'),
      ratedByBuyer: state.ratedByBuyer ||
        (decision.action === 'rate_counterparty_demo' && role === 'buyer'),
      events: [...state.events, decision],
    },
    replayed: false,
  };
}

export function createDealDecisionState(input) {
  return {
    ...validateBase(input), status: 'draft',
    ratedBySeller: false, ratedByBuyer: false, events: [],
  };
}

function validateState(input) {
  const state = exactRecord(input, STATE_KEYS, 'decision state');
  const base = validateBase(Object.fromEntries(BASE_KEYS.map((key) => [key, state[key]])));
  if (!Array.isArray(state.events) || state.events.length > 8 ||
      typeof state.status !== 'string' ||
      typeof state.ratedBySeller !== 'boolean' ||
      typeof state.ratedByBuyer !== 'boolean') {
    throw new Error('invalid decision state');
  }
  let derived = createDealDecisionState(base);
  for (const raw of state.events) {
    const decision = validateDecision(raw);
    const applied = advance(derived, decision);
    if (applied.replayed) throw new Error('invalid decision state');
    derived = applied.state;
  }
  if (derived.status !== state.status ||
      derived.ratedBySeller !== state.ratedBySeller ||
      derived.ratedByBuyer !== state.ratedByBuyer) {
    throw new Error('invalid decision state');
  }
  return derived;
}

export function applyTrustedDecision(state, input) {
  const decision = validateDecision(input);
  return { ...advance(validateState(state), decision), decision };
}
