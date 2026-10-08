const fs = require('node:fs/promises');
const path = require('node:path');

// Errors that mean the file can't be replaced, though it may still be writable: a file bind-mounted on its own
// (rename gives EBUSY, EXDEV or EPERM) or a directory the container can't write to (EACCES, EPERM or EROFS).
const CANNOT_REPLACE = new Set(['EBUSY', 'EXDEV', 'EPERM', 'EACCES', 'EROFS']);

// Writing beside the file and renaming it over the top means a reader never sees half a file. That isn't
// possible for a file bind-mounted on its own, or one in a directory the container can't write to, so an
// existing file is overwritten in place instead. Any other failure, such as a full disk, is passed on without
// touching the file, because overwriting it would truncate the only good copy and then fail the same way.
async function writeSafely(file, text) {
  const tmp = `${file}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (!CANNOT_REPLACE.has(err.code)) throw err;
    const previous = await fs.readFile(file, 'utf8').catch(() => null);
    if (previous == null) throw err;
    try {
      await fs.writeFile(file, text);
    } catch (overwriteErr) {
      // The overwrite truncated the file before failing, so put the old contents back if there's room.
      await fs.writeFile(file, previous).catch(() => {});
      throw overwriteErr;
    }
  }
}

module.exports = { writeSafely };
