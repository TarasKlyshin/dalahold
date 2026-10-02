import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preparePrivateTestDatabase } from './private-test-store.mjs';

const bytes = Buffer.from('PRIVATE SYNTHETIC TEST STORE\n');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dalahold-private-store-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, leaf: join(root, 'store'), path: join(root, 'store', 'workspace.sqlite') };
}

function createExisting({ leaf, path }, mode = 0o600) {
  mkdirSync(leaf, { mode: 0o700 });
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  chmodSync(path, mode);
}

test('fresh private leaf and empty database are exactly 0700 and 0600', t => {
  const f = fixture(t);
  const path = preparePrivateTestDatabase(f.path);
  assert.equal(path, join(realpathSync(f.root), 'store', 'workspace.sqlite'));
  const directory = lstatSync(f.leaf), file = lstatSync(path);
  assert.equal(directory.isDirectory(), true);
  assert.equal(directory.isSymbolicLink(), false);
  assert.equal(directory.mode & 0o777, 0o700);
  assert.equal(file.isFile(), true);
  assert.equal(file.isSymbolicLink(), false);
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(file.nlink, 1);
  assert.equal(file.size, 0);
  assert.equal(directory.uid, process.getuid());
  assert.equal(file.uid, process.getuid());
});

test('existing safe store preserves bytes, file identity and permissions on repeated preparation', t => {
  const f = fixture(t);
  createExisting(f);
  const before = statSync(f.path);
  const path = preparePrivateTestDatabase(f.path);
  assert.equal(preparePrivateTestDatabase(f.path), path);
  assert.deepEqual(readFileSync(path), bytes);
  const after = statSync(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('insecure existing leaf modes reject without chmod or database creation', t => {
  for (const mode of [0o710, 0o750, 0o755, 0o777]) {
    const f = fixture(t);
    mkdirSync(f.leaf, { mode: 0o700 });
    chmodSync(f.leaf, mode);
    const before = statSync(f.leaf);
    assert.throws(() => preparePrivateTestDatabase(f.path), /private_test_directory_required/);
    assert.equal(statSync(f.leaf).mode, before.mode);
    assert.equal(statSync(f.leaf).ino, before.ino);
    assert.equal(existsSync(f.path), false);
  }
});

test('insecure existing database modes reject without chmod or changing bytes', t => {
  for (const mode of [0o620, 0o640, 0o644, 0o666]) {
    const f = fixture(t);
    createExisting(f, mode);
    const before = statSync(f.path);
    assert.throws(() => preparePrivateTestDatabase(f.path), /private_test_file_required/);
    const after = statSync(f.path);
    assert.equal(after.mode, before.mode);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(readFileSync(f.path), bytes);
    assert.equal(statSync(f.leaf).mode & 0o777, 0o700);
  }
});

test('symlink leaf is refused and its target store stays unchanged', t => {
  const f = fixture(t), target = join(f.root, 'target');
  mkdirSync(target, { mode: 0o700 });
  const targetFile = join(target, 'workspace.sqlite');
  writeFileSync(targetFile, bytes, { mode: 0o600 });
  symlinkSync(target, f.leaf, 'dir');
  assert.throws(() => preparePrivateTestDatabase(f.path), /private_test_directory_required/);
  assert.equal(lstatSync(f.leaf).isSymbolicLink(), true);
  assert.equal(statSync(target).mode & 0o777, 0o700);
  assert.deepEqual(readFileSync(targetFile), bytes);
});

test('symlink database is refused without opening or replacing the target', t => {
  const f = fixture(t), target = join(f.root, 'target.sqlite');
  mkdirSync(f.leaf, { mode: 0o700 });
  writeFileSync(target, bytes, { mode: 0o600 });
  symlinkSync(target, f.path);
  const before = statSync(target);
  assert.throws(() => preparePrivateTestDatabase(f.path));
  assert.equal(lstatSync(f.path).isSymbolicLink(), true);
  assert.equal(statSync(target).ino, before.ino);
  assert.equal(statSync(target).mode, before.mode);
  assert.deepEqual(readFileSync(target), bytes);
});

test('hardlinked database is refused without removing either link or changing bytes', t => {
  const f = fixture(t);
  createExisting(f);
  const second = join(f.root, 'second.sqlite');
  linkSync(f.path, second);
  const before = statSync(f.path);
  assert.equal(before.nlink, 2);
  assert.throws(() => preparePrivateTestDatabase(f.path), /private_test_file_required/);
  assert.equal(statSync(f.path).nlink, 2);
  assert.equal(statSync(second).ino, before.ino);
  assert.equal(statSync(f.path).mode, before.mode);
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.deepEqual(readFileSync(second), bytes);
});

test('group or world writable parent is refused before database creation', t => {
  for (const mode of [0o720, 0o702, 0o770, 0o777]) {
    const f = fixture(t);
    chmodSync(f.root, mode);
    const before = statSync(f.root);
    assert.throws(() => preparePrivateTestDatabase(f.path), /private_test_parent_required/);
    assert.equal(statSync(f.root).mode, before.mode);
    assert.equal(statSync(f.root).ino, before.ino);
    assert.equal(existsSync(f.path), false);
  }
});

test('an owner-controlled nonwritable shared parent permits a private leaf', t => {
  const f = fixture(t);
  chmodSync(f.root, 0o755);
  const path = preparePrivateTestDatabase(f.path);
  assert.equal(statSync(f.root).mode & 0o777, 0o755);
  assert.equal(statSync(f.leaf).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('temporary-directory spelling returns canonical macOS /private/var path', t => {
  const f = fixture(t);
  const path = preparePrivateTestDatabase(f.path);
  assert.equal(path, realpathSync(f.path));
  assert.equal(path, join(realpathSync(f.root), 'store', 'workspace.sqlite'));
  if (process.platform === 'darwin' && f.root.startsWith('/var/')) {
    assert.equal(path.startsWith('/private/var/'), true);
    assert.notEqual(path, f.path);
    assert.equal(preparePrivateTestDatabase(path), path);
  }
});

test('trusted ancestor alias is canonicalized while the final leaf remains a real private directory', t => {
  const f = fixture(t), alias = join(f.root, 'alias'), target = join(f.root, 'target');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, alias, 'dir');
  const requested = join(alias, 'store', 'workspace.sqlite');
  const path = preparePrivateTestDatabase(requested);
  assert.equal(path, join(realpathSync(target), 'store', 'workspace.sqlite'));
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.equal(lstatSync(join(target, 'store')).isSymbolicLink(), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('missing ancestor rejects rather than recursively creating new directory trees', t => {
  const f = fixture(t), ancestor = join(f.root, 'missing');
  assert.throws(() => preparePrivateTestDatabase(join(ancestor, 'store', 'workspace.sqlite')), { code: 'ENOENT' });
  assert.equal(existsSync(ancestor), false);
});

test('a file at the leaf directory or a directory at the database path is refused', t => {
  const f = fixture(t);
  writeFileSync(f.leaf, bytes, { mode: 0o600 });
  assert.throws(() => preparePrivateTestDatabase(f.path), /private_test_directory_required/);
  assert.deepEqual(readFileSync(f.leaf), bytes);
  const g = fixture(t);
  mkdirSync(g.leaf, { mode: 0o700 });
  mkdirSync(g.path, { mode: 0o700 });
  assert.throws(() => preparePrivateTestDatabase(g.path));
  assert.equal(lstatSync(g.path).isDirectory(), true);
});
