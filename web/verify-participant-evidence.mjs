#!/usr/bin/env node
// Reads one explicitly supplied JSON file; never executes or extracts documents.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { PARTICIPANT_EVIDENCE_MAX_BYTES, PARTICIPANT_EVIDENCE_MODE,
  PARTICIPANT_EVIDENCE_LIMITATIONS, verifyParticipantEvidence } from './participant-evidence.mjs';

function failure(code) {
  return { valid: false, mode: PARTICIPANT_EVIDENCE_MODE, authenticityVerified: false,
    sdkVerificationPerformed: false, freshStatusChecked: false, chronologyVerified: false, errors: [code],
    limitations: [...PARTICIPANT_EVIDENCE_LIMITATIONS] };
}

// JSON.parse silently overwrites duplicate keys. Reject ambiguous serialized
// records too, including keys spelled with equivalent JSON Unicode escapes.
function parseJson(text) {
  let offset = 0;
  const reject = code => { throw Object.assign(new Error(code), { evidenceCode: code }); };
  const whitespace = () => { while (/[ \r\n\t]/.test(text[offset] ?? 'x')) offset++; };
  const string = () => {
    if (text[offset] !== '"') reject('invalid_evidence_json');
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '\\') offset++;
      else if (character === '"') return text.slice(start, offset);
    }
    reject('invalid_evidence_json');
  };
  const value = depth => {
    if (depth > 32) reject('evidence_limit');
    whitespace();
    if (text[offset] === '{') {
      offset++; whitespace();
      const keys = new Set();
      if (text[offset] === '}') { offset++; return; }
      for (;;) {
        whitespace();
        const key = JSON.parse(string());
        if (keys.has(key)) reject('duplicate_evidence_key');
        keys.add(key); whitespace();
        if (text[offset++] !== ':') reject('invalid_evidence_json');
        value(depth + 1); whitespace();
        const end = text[offset++];
        if (end === '}') return;
        if (end !== ',') reject('invalid_evidence_json');
      }
    } else if (text[offset] === '[') {
      offset++; whitespace();
      if (text[offset] === ']') { offset++; return; }
      for (;;) {
        value(depth + 1); whitespace();
        const end = text[offset++];
        if (end === ']') return;
        if (end !== ',') reject('invalid_evidence_json');
      }
    } else if (text[offset] === '"') string();
    else {
      const start = offset;
      while (offset < text.length && !/[,}\]\s]/.test(text[offset])) offset++;
      if (offset === start) reject('invalid_evidence_json');
    }
  };
  value(0); whitespace();
  if (offset !== text.length) reject('invalid_evidence_json');
  return JSON.parse(text);
}

let report;
if (process.argv.length !== 3 || !process.argv[2] || process.argv[2].startsWith('-')) {
  report = failure('expected_one_json_file');
} else {
  let fd;
  try {
    // O_NONBLOCK avoids hanging on a FIFO. fstat validates the opened target.
    fd = openSync(process.argv[2], constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) report = failure('expected_regular_json_file');
    else if (stat.size < 1) report = failure('invalid_evidence_json');
    else if (stat.size > PARTICIPANT_EVIDENCE_MAX_BYTES) report = failure('evidence_limit');
    else {
      // Bound the read independently of fstat in case the file grows meanwhile.
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0, count = 0;
      do {
        count = readSync(fd, bytes, offset, bytes.length - offset, null);
        offset += count;
      } while (count && offset < bytes.length);
      if (offset > stat.size) report = failure('evidence_file_changed');
      else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
        report = verifyParticipantEvidence(parseJson(text));
      }
    }
  } catch (error) {
    const code = ['evidence_limit', 'duplicate_evidence_key'].includes(error.evidenceCode) ? error.evidenceCode : null;
    report = failure(code ?? (fd === undefined ? 'evidence_file_unavailable' : 'invalid_evidence_json'));
  } finally { if (fd !== undefined) closeSync(fd); }
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.valid ? 0 : 1;
