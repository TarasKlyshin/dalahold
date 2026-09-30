// A marker describes a claimed test file for an unsigned local draft version.
// It cannot carry file content, file names, identity proof or payment status.
const FIELDS = ['expectedVersion', 'requestId', 'category', 'context', 'note', 'claimedRole', 'fileKind'];
const CATEGORIES = new Map([
  ['livestock', new Set(['animals', 'veterinary', 'handover', 'acceptance', 'settlement'])],
  ['grain', new Set(['specification', 'waybill', 'weight', 'quality', 'acceptance', 'settlement'])],
]);
const ROLES = new Set(['seller', 'buyer']);
const FILE_KINDS = new Set(['pdf', 'image', 'word', 'spreadsheet']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function invalid(field) {
  return new TypeError(`invalid document marker: ${field}`);
}

function boundedText(value, length, field) {
  if (typeof value !== 'string' || !value.isWellFormed() || CONTROL.test(value)) {
    throw invalid(field);
  }
  const trimmed = value.trim();
  if ([...trimmed].length > length) throw invalid(field);
  return trimmed;
}

export function normalizeMarkerInput(value, scenario) {
  const categories = CATEGORIES.get(scenario);
  if (!categories) throw invalid('scenario');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid('object');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.includes(field))) {
    throw invalid('keys');
  }
  const [expectedVersion, requestId, category, context, note, claimedRole, fileKind] =
    FIELDS.map((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid('keys');
      return descriptor.value;
    });
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw invalid('expectedVersion');
  if (typeof requestId !== 'string' || !UUID.test(requestId)) throw invalid('requestId');
  if (!categories.has(category)) throw invalid('category');
  const normalizedContext = boundedText(context, 80, 'context');
  const normalizedNote = boundedText(note, 120, 'note');
  if (!ROLES.has(claimedRole)) throw invalid('claimedRole');
  if (!FILE_KINDS.has(fileKind)) throw invalid('fileKind');
  return {
    expectedVersion, requestId, category, context: normalizedContext, note: normalizedNote,
    claimedRole, fileKind,
  };
}
