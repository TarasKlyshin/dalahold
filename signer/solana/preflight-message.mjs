// Compile exactly one unsigned version-0 Memo message for a fee quote.
// This module accepts only a public fee payer and a fresh RPC blockhash;
// it has no key, signature, transaction or arbitrary instruction input.
import { types as nodeTypes } from 'node:util';
import {
  address,
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  isTestMemoBase58,
  isTestMemoUint,
  rejectTestMemo,
  TEST_MEMO_PROGRAM_ID,
} from '../test-memo-grant.mjs';

export const PREFLIGHT_PROGRAM_ID = TEST_MEMO_PROGRAM_ID;
export const PREFLIGHT_MEMO = 'DalaHold devnet preflight v1';
const PREFLIGHT_MEMO_BYTES = Buffer.from(PREFLIGHT_MEMO, 'utf8');

function exactConfig(value) {
  if (nodeTypes.isProxy(value)) rejectTestMemo('invalid_preflight_fee_message');
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    rejectTestMemo('invalid_preflight_fee_message');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    rejectTestMemo('invalid_preflight_fee_message');
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 3 || names.some(name => !['feePayer', 'blockhash', 'lastValidBlockHeight'].includes(name)) ||
      Object.getOwnPropertySymbols(value).length !== 0)
    rejectTestMemo('invalid_preflight_fee_message');
  const entries = [];
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set)
      rejectTestMemo('invalid_preflight_fee_message');
    entries.push([name, descriptor.value]);
  }
  const copy = Object.create(null);
  for (const [name, entry] of entries) Object.defineProperty(copy, name, {
    value: entry, enumerable: true, writable: true, configurable: true,
  });
  return copy;
}

/**
 * Return serialized message bytes for one fixed Memo instruction.
 * The bytes are an unsigned message, not a transaction and not a signature.
 */
export function compilePreflightMemoMessage(input) {
  const { feePayer, blockhash, lastValidBlockHeight } = exactConfig(input);
  if (!isTestMemoBase58(feePayer, 32) || !isTestMemoBase58(blockhash, 32) ||
      !isTestMemoUint(lastValidBlockHeight)) rejectTestMemo('invalid_preflight_fee_message');
  try {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      value => setTransactionMessageFeePayer(address(feePayer), value),
      value => setTransactionMessageLifetimeUsingBlockhash({
        blockhash,
        lastValidBlockHeight: BigInt(lastValidBlockHeight),
      }, value),
      value => appendTransactionMessageInstruction({
        programAddress: address(PREFLIGHT_PROGRAM_ID),
        accounts: [],
        data: PREFLIGHT_MEMO_BYTES,
      }, value),
    );
    const compiled = compileTransactionMessage(message);
    const bytes = Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled));
    if (bytes.length < 1 || bytes.length > 1_232) rejectTestMemo('invalid_preflight_fee_message');
    return bytes;
  } catch {
    rejectTestMemo('invalid_preflight_fee_message');
  }
}
