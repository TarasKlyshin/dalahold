// Isolated current-code participant TEST runtime tooling.
//
// The default unsigned stand deliberately uses a new private directory.  It
// does not open the retained participant cabinets or any personal registry.
// Signed mode is an explicit opt-in and never falls back to unsigned mode.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startParticipantWorkspace } from './participant-server.mjs';
import { startSignedParticipantWorkspace } from './signed-participant-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const STORE_FILE = 'participants.sqlite';
const ACTIVE_FILE = '.participant-runtime-active';
const MANIFEST_FILE = 'manifest.json';
const UNSIGNED_KIND = 'dalahold.local-test-participants.v1';
const SIGNED_KIND = `${UNSIGNED_KIND}.personal-test-signed`;
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MODES = new Set(['unsigned', 'signed']);

export const DEFAULT_PARTICIPANT_RUNTIME_DIRECTORY = resolve(root, '.local/participant-runtime');
export const DEFAULT_SIGNED_PARTICIPANT_RUNTIME_DIRECTORY = resolve(root, '.local/participant-runtime-signed');
export const DEFAULT_PARTICIPANT_RUNTIME_PORT = 4177;
export const PARTICIPANT_RUNTIME_STORE_FILE = STORE_FILE;

// These paths are intentionally reserved.  A custom path with one of the
// personal-binding spellings is rejected before any database is opened.
const RESERVED_PATHS = Object.freeze([
  resolve(root, '.local/participant-test-cabinet'),
  resolve(root, '.local/signed-participant-test-cabinet'),
  resolve(root, '.local/nca-personal-bindings'),
  resolve(root, '.local/nca-personal-bindings-initial-backup'),
  resolve(root, '.local/nca-personal-bindings-retained-checkpoint-backup'),
  resolve(root, '.local/nca-personal-bindings-enrollment-backup-r2-20260930T145233Z'),
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function modeOf(value) {
  if (!MODES.has(value)) throw fail('runtime_mode_invalid');
  return value;
}

function expectedKind(mode) {
  return mode === 'signed' ? SIGNED_KIND : UNSIGNED_KIND;
}

function ownerId() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function owned(stat) {
  const uid = ownerId();
  return uid === null || stat.uid === uid;
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

function reservedPath(path) {
  if (RESERVED_PATHS.some(item => inside(item, path) || inside(path, item))) return true;
  return path.split(sep).some(segment => /^(?:nca-)?personal[-_]bindings(?:-|$)/i.test(segment) ||
    /^personal[-_].*checkpoint/i.test(segment));
}

function canonicalPath(value) {
  const requested = resolve(value);
  const suffix = [];
  let cursor = requested;
  for (;;) {
    try {
      const stat = lstatSync(cursor);
      // A requested leaf symlink is never followed. Existing ancestor aliases
      // are canonicalized so overlap checks operate on the real target.
      if (cursor === requested && stat.isSymbolicLink()) throw fail('runtime_directory_symlink');
      let base;
      try { base = realpathSync(cursor); }
      catch { throw fail('runtime_directory_symlink'); }
      return suffix.length ? join(base, ...suffix) : base;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw fail('runtime_parent_required');
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function assertDedicatedPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('runtime_directory_required');
  const requested = resolve(value);
  const path = canonicalPath(value);
  if (reservedPath(requested) || reservedPath(path)) throw fail('runtime_directory_reserved');
  return path;
}

function assertPrivateParent(path) {
  const parentPath = dirname(path);
  let parent;
  try { parent = lstatSync(parentPath); } catch { throw fail('runtime_parent_required'); }
  if (!parent.isDirectory() || parent.isSymbolicLink() || !owned(parent) || (parent.mode & 0o022))
    throw fail('runtime_parent_required');
}

function assertPrivateDirectory(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error?.code === 'ENOENT') throw fail('runtime_directory_required');
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('runtime_directory_required');
  if (!owned(stat) || (stat.mode & 0o077)) throw fail('runtime_directory_private_required');
  return stat;
}

function assertPrivateFile(path, code = 'runtime_file_required') {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error?.code === 'ENOENT') throw fail(code);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o077) || stat.nlink !== 1)
    throw fail(code);
  if (stat.size > MAX_DATABASE_BYTES) throw fail('runtime_size_limit');
  return stat;
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs);
}

function assertNoSidecars(directory) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (existsSync(join(directory, `${STORE_FILE}${suffix}`))) throw fail('runtime_sidecar_present');
  }
}

function inspectStore(directory, mode) {
  const path = join(directory, STORE_FILE);
  const stat = assertPrivateFile(path);
  assertNoSidecars(directory);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON');
    const rows = db.prepare('SELECT singleton, kind FROM participant_store_meta').all();
    if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].kind !== expectedKind(mode))
      throw fail('runtime_kind_mismatch');
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity['integrity_check'] !== 'ok') throw fail('runtime_integrity_failed');
  } finally { db?.close(); }
  return { path, stat };
}

function ensureRuntimeDirectory(path) {
  assertPrivateParent(path);
  try { lstatSync(path); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  assertPrivateDirectory(path);
}

function acquireLease(directory, mode) {
  const path = join(directory, ACTIVE_FILE);
  if (existsSync(path)) throw fail('runtime_active');
  const token = `${process.pid}:${randomUUID()}`;
  try { writeFileSync(path, `${JSON.stringify({ mode, pid: process.pid, token })}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error?.code === 'EEXIST') throw fail('runtime_active');
    throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* the mode is checked by the snapshot path */ }
  return { path, token };
}

function releaseLease(lease) {
  if (!lease) return;
  try {
    const content = readFileSync(lease.path, 'utf8');
    if (content.includes(`"token":"${lease.token}"`)) unlinkSync(lease.path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function port(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw fail('runtime_port_invalid');
  return value;
}

export async function startParticipantRuntime({ mode = 'unsigned', directory,
  port: listenPort = DEFAULT_PARTICIPANT_RUNTIME_PORT, now = Date.now, sdkRoot,
  sdk, javaBin, memoConfiguration } = {}) {
  mode = modeOf(mode);
  listenPort = port(listenPort);
  if (typeof now !== 'function') throw fail('runtime_clock_invalid');
  if (mode === 'signed' && sdk === undefined && (typeof sdkRoot !== 'string' || !sdkRoot.trim()))
    throw fail('runtime_signed_sdk_required');
  if (mode === 'unsigned' && (sdk !== undefined || memoConfiguration !== undefined))
    throw fail('runtime_unsigned_sdk_forbidden');

  const runtimeDirectory = assertDedicatedPath(directory ||
    (mode === 'signed' ? DEFAULT_SIGNED_PARTICIPANT_RUNTIME_DIRECTORY : DEFAULT_PARTICIPANT_RUNTIME_DIRECTORY));
  ensureRuntimeDirectory(runtimeDirectory);
  const lease = acquireLease(runtimeDirectory, mode);
  let stand;
  try {
    stand = mode === 'signed'
      ? await startSignedParticipantWorkspace({ sdkRoot, sdk, javaBin, directory: runtimeDirectory,
        port: listenPort, now, memoConfiguration })
      : await startParticipantWorkspace({ directory: runtimeDirectory, port: listenPort, now });
  } catch (error) {
    releaseLease(lease);
    throw error;
  }

  let closing;
  return {
    ...stand,
    mode,
    directory: runtimeDirectory,
    leasePath: lease.path,
    close: () => closing ||= (async () => {
      try { await stand.close(); }
      finally { releaseLease(lease); }
    })(),
  };
}

function checkedManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('runtime_backup_manifest_invalid');
  const fields = ['schemaVersion', 'mode', 'kind', 'databaseFile', 'databaseBytes', 'databaseSha256', 'sidecars', 'capturedAt'];
  if (Object.keys(value).sort().join(',') !== fields.slice().sort().join(',')) throw fail('runtime_backup_manifest_invalid');
  if (value.schemaVersion !== 1 || value.mode !== 'unsigned' || value.kind !== UNSIGNED_KIND ||
      value.databaseFile !== STORE_FILE || !Number.isSafeInteger(value.databaseBytes) ||
      value.databaseBytes < 1 || value.databaseBytes > MAX_DATABASE_BYTES ||
      typeof value.databaseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.databaseSha256) ||
      !Array.isArray(value.sidecars) || value.sidecars.length !== 0 ||
      !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 0)
    throw fail('runtime_backup_manifest_invalid');
  return value;
}

function safeBackupDirectory(value, { missing = false } = {}) {
  const path = assertDedicatedPath(value);
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o077))
      throw fail('runtime_backup_private_required');
    return path;
  } catch (error) {
    if (error?.code === 'ENOENT' && missing) { assertPrivateParent(path); return path; }
    if (error?.code === 'ENOENT') throw fail('runtime_backup_missing');
    throw error;
  }
}

function assertBackupContents(directory) {
  let entries;
  try { entries = readdirSync(directory).sort(); } catch { throw fail('runtime_backup_missing'); }
  if (entries.join(',') !== [MANIFEST_FILE, STORE_FILE].sort().join(','))
    throw fail('runtime_backup_manifest_invalid');
}

function readStableFile(path, code = 'runtime_file_required', expectedIdentity = null) {
  const before = assertPrivateFile(path, code);
  if (expectedIdentity && !sameIdentity(before, expectedIdentity)) throw fail('runtime_source_changed');
  const bytes = readFileSync(path);
  const after = assertPrivateFile(path, code);
  if (!sameIdentity(before, after) || bytes.length !== before.size || bytes.length !== after.size)
    throw fail('runtime_source_changed');
  return { bytes, identity: before };
}

function writePrivateFile(path, bytes) {
  const buffer = Buffer.from(bytes);
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      (constants.O_NOFOLLOW || 0), 0o600);
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset, null);
      if (!written) throw fail('runtime_file_write_failed');
      offset += written;
    }
    const identity = fstatSync(fd);
    if (!identity.isFile() || !owned(identity) || (identity.mode & 0o077) || identity.nlink !== 1)
      throw fail('runtime_file_required');
    return identity;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function inspectCopiedStore(directory, mode, expectedBytes, expectedDigest) {
  const checked = inspectStore(directory, mode);
  const readback = readStableFile(checked.path, 'runtime_file_required', checked.stat);
  const digest = createHash('sha256').update(readback.bytes).digest('hex');
  if (!readback.bytes.equals(expectedBytes) || digest !== expectedDigest)
    throw fail('runtime_copy_changed');
  return checked;
}

// Internal deterministic fault injection for the focused race regressions.
// It is not used by the runnable command or documented as an operator API.
function invokeTestHook(options, name, payload) {
  const hooks = options?.testOnlyHooks;
  if (hooks === undefined) return;
  if (!hooks || (hooks[name] !== undefined && typeof hooks[name] !== 'function'))
    throw fail('runtime_test_hook_invalid');
  if (hooks[name] === undefined) return;
  hooks[name](payload);
}

// Snapshot only an explicitly stopped, launcher-owned unsigned stand.  The
// destination is new and owner-only; no active SQLite file is copied.
export function snapshotParticipantRuntime({ directory, backupDirectory, mode = 'unsigned', capturedAt = Date.now(),
  testOnlyHooks } = {}) {
  mode = modeOf(mode);
  if (mode !== 'unsigned') throw fail('runtime_signed_backup_requires_key_material');
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) throw fail('runtime_capture_time_invalid');
  const sourceDirectory = assertDedicatedPath(directory || DEFAULT_PARTICIPANT_RUNTIME_DIRECTORY);
  const targetDirectory = safeBackupDirectory(backupDirectory, { missing: true });
  if (inside(sourceDirectory, targetDirectory) || inside(targetDirectory, sourceDirectory)) throw fail('runtime_path_overlap');
  assertPrivateDirectory(sourceDirectory);
  assertPrivateParent(sourceDirectory);
  // Acquire the same O_EXCL marker used by startup. This exclusion spans the
  // inspection and byte capture, closing the launcher-vs-snapshot race.
  const lease = acquireLease(sourceDirectory, 'snapshot');
  try {
    invokeTestHook({ testOnlyHooks }, 'afterLease', { directory: sourceDirectory });
    const source = inspectStore(sourceDirectory, mode);
    const captured = readStableFile(source.path, 'runtime_file_required', source.stat);
    const bytes = captured.bytes;
    const digest = createHash('sha256').update(bytes).digest('hex');
    try { mkdirSync(targetDirectory, { mode: 0o700 }); }
    catch (error) { if (error?.code === 'EEXIST') throw fail('runtime_backup_exists'); throw error; }
    assertPrivateDirectory(targetDirectory);
    writePrivateFile(join(targetDirectory, STORE_FILE), bytes);
    invokeTestHook({ testOnlyHooks }, 'afterDatabaseWrite', { directory: targetDirectory,
      path: join(targetDirectory, STORE_FILE), bytes: Buffer.from(bytes) });
    const manifest = {
      schemaVersion: 1, mode, kind: UNSIGNED_KIND, databaseFile: STORE_FILE,
      databaseBytes: bytes.length, databaseSha256: digest, sidecars: [], capturedAt,
    };
    writePrivateFile(join(targetDirectory, MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
    // Re-open the copy read-only and verify its declared kind and integrity.
    assertBackupContents(targetDirectory);
    inspectCopiedStore(targetDirectory, mode, bytes, digest);
    return { mode, kind: UNSIGNED_KIND, directory: targetDirectory, databaseFile: STORE_FILE,
      databaseBytes: bytes.length, databaseSha256: digest };
  } finally { releaseLease(lease); }
}

// Restore only into a new owner-only directory. Existing destinations are
// never overwritten. Signed restore is intentionally refused until its
// mapping key/MAC material has a separate protected backup contract.
export function restoreParticipantRuntime({ backupDirectory, directory, mode = 'unsigned', testOnlyHooks } = {}) {
  mode = modeOf(mode);
  if (mode !== 'unsigned') throw fail('runtime_signed_restore_requires_key_material');
  const sourceDirectory = safeBackupDirectory(backupDirectory);
  const targetDirectory = assertDedicatedPath(directory || DEFAULT_PARTICIPANT_RUNTIME_DIRECTORY);
  if (inside(sourceDirectory, targetDirectory) || inside(targetDirectory, sourceDirectory)) throw fail('runtime_path_overlap');
  assertPrivateParent(targetDirectory);
  if (existsSync(targetDirectory)) throw fail('runtime_destination_exists');

  const manifestPath = join(sourceDirectory, MANIFEST_FILE);
  const databasePath = join(sourceDirectory, STORE_FILE);
  assertPrivateFile(manifestPath, 'runtime_backup_manifest_missing');
  const checkedSource = inspectStore(sourceDirectory, mode);
  const database = readStableFile(databasePath, 'runtime_backup_database_missing', checkedSource.stat);
  invokeTestHook({ testOnlyHooks }, 'afterSourceCapture', { directory: sourceDirectory,
    path: databasePath, bytes: Buffer.from(database.bytes) });
  assertNoSidecars(sourceDirectory);
  assertBackupContents(sourceDirectory);
  let manifest;
  try { manifest = checkedManifest(JSON.parse(readStableFile(manifestPath, 'runtime_backup_manifest_missing').bytes.toString('utf8'))); }
  catch (error) { if (error?.code === 'runtime_backup_manifest_invalid') throw error; throw fail('runtime_backup_manifest_invalid'); }
  const digest = createHash('sha256').update(database.bytes).digest('hex');
  if (manifest.databaseBytes !== database.bytes.length || digest !== manifest.databaseSha256)
    throw fail('runtime_backup_digest_mismatch');

  mkdirSync(targetDirectory, { mode: 0o700 });
  assertPrivateDirectory(targetDirectory);
  writePrivateFile(join(targetDirectory, STORE_FILE), database.bytes);
  invokeTestHook({ testOnlyHooks }, 'afterDatabaseWrite', { directory: targetDirectory,
    path: join(targetDirectory, STORE_FILE), bytes: Buffer.from(database.bytes) });
  inspectCopiedStore(targetDirectory, mode, database.bytes, digest);
  return { mode, kind: UNSIGNED_KIND, directory: targetDirectory, databaseFile: STORE_FILE,
    databaseBytes: manifest.databaseBytes, databaseSha256: manifest.databaseSha256 };
}

function parseEnvPort(value) {
  if (value === undefined) return DEFAULT_PARTICIPANT_RUNTIME_PORT;
  if (!/^\d+$/.test(value)) throw fail('runtime_port_invalid');
  return port(Number(value));
}

function safeProcessError(error) {
  return /^[a-z0-9_]+$/.test(error?.code || '') ? error.code : 'unavailable';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.env.DALAHOLD_PARTICIPANT_RUNTIME_MODE || 'unsigned';
  const directory = process.env.DALAHOLD_PARTICIPANT_RUNTIME_DIR || undefined;
  try {
    const stand = await startParticipantRuntime({
      mode,
      directory,
      port: parseEnvPort(process.env.DALAHOLD_PARTICIPANT_RUNTIME_PORT),
      ...(mode === 'signed' ? {
        sdkRoot: process.env.NCA_SDK_ROOT,
        javaBin: process.env.NCA_JAVA_BIN || undefined,
        ...(process.env.NCA_TEST_MEMO_WALLET ? { memoConfiguration: {
          walletAddress: process.env.NCA_TEST_MEMO_WALLET, maxFeeLamports: '10000',
        } } : {}),
      } : {}),
    });
    process.stdout.write(`DalaHold ${mode} participant TEST runtime: ${stand.url}\n`);
    const stop = () => stand.close().then(() => process.exit(0), () => process.exit(1));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(`Participant TEST runtime unavailable: ${safeProcessError(error)}.\n`);
    process.exitCode = 1;
  }
}
