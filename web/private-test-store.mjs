import { constants, closeSync, openSync, lstatSync, fstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';

// Existing stores are never chmodded/replaced automatically. Owner/mode checks
// protect a local TEST store, not encryption or authenticated multi-user access.
export function preparePrivateTestDatabase(path) {
  path = resolve(path);
  let directory = dirname(path);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if(error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error('private_test_directory_required');
  directory = realpathSync(directory); path = join(directory,basename(path));
  const parent = lstatSync(dirname(directory));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022))
    throw new Error('private_test_parent_required');
  let fd;
  try {
    try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if(error.code !== 'EEXIST') throw error;
      fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) || file.nlink !== 1)
      throw new Error('private_test_file_required');
  } finally { if(fd !== undefined) closeSync(fd); }
  return path;
}
