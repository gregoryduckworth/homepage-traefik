const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_GROUPS = 100;
const MAX_NAME_LENGTH = 60;
// Errors that mean the file can't be replaced, though it may still be writable: a file bind-mounted on its own
// (rename gives EBUSY, EXDEV or EPERM) or a directory the container can't write to (EACCES, EPERM or EROFS).
const CANNOT_REPLACE = new Set(['EBUSY', 'EXDEV', 'EPERM', 'EACCES', 'EROFS']);

// Thrown for config the user can fix: a bad request body, or a hand-edited file that doesn't parse.
class ConfigError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// A route belongs to at most one group; later duplicates are dropped so a hand edit can't show a route twice.
function normalizeGroups(input) {
  if (!Array.isArray(input)) throw new ConfigError('"groups" must be a list');
  if (input.length > MAX_GROUPS) throw new ConfigError(`There can be at most ${MAX_GROUPS} groups`);

  const names = new Set();
  const assigned = new Set();
  return input.map((group, index) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new ConfigError(`Group ${index + 1} must be an object`);
    const name = typeof group.name === 'string' ? group.name.trim() : '';
    if (!name) throw new ConfigError(`Group ${index + 1} needs a name`);
    if (name.length > MAX_NAME_LENGTH) throw new ConfigError(`Group names can be at most ${MAX_NAME_LENGTH} characters`);
    if (names.has(name.toLowerCase())) throw new ConfigError(`There's already a group called "${name}"`);
    names.add(name.toLowerCase());

    const routes = group.routes ?? [];
    if (!Array.isArray(routes) || !routes.every(id => typeof id === 'string' && id)) {
      throw new ConfigError(`"routes" in group "${name}" must be a list of router names`);
    }
    const unique = routes.filter(id => !assigned.has(id));
    unique.forEach(id => assigned.add(id));
    return { name, routes: unique };
  });
}

// Saved health results are only a cache, so entries that don't look like one are dropped rather than reported.
function storedHealth(doc) {
  const entries = doc?.health && typeof doc.health === 'object' && !Array.isArray(doc.health) ? Object.entries(doc.health) : [];
  return new Map(entries.filter(([, result]) => result && typeof result.url === 'string' && !Number.isNaN(Date.parse(result.checkedAt))));
}

function parseConfig(text) {
  // An empty file (say, one just created with touch so it can be mounted) means no groups yet.
  if (!text.trim()) return { doc: {}, groups: [] };
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ConfigError('expected a JSON object with a "groups" list');
  return { doc, groups: normalizeGroups(doc.groups ?? []) };
}

// The file is re-read whenever it changes on disk, so hand edits show up without a restart.
function createConfigStore({ file }) {
  const empty = { version: null, doc: {}, groups: [], error: null };
  let cache = empty;
  let writing = Promise.resolve();

  async function read() {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (err) {
      cache = err.code === 'ENOENT' ? empty : { ...cache, version: null, error: `Can't read ${file} (${err.code})` };
      return cache;
    }

    if (stat.isDirectory()) {
      cache = {
        ...cache,
        version: null,
        error: `${file} is a directory, not a file. Docker creates a directory when the file you mount doesn't exist on the host, or is in a folder Docker can't see: create the file (an empty one is fine), remove the directory Docker made and recreate the container`,
      };
      return cache;
    }

    const version = `${stat.mtimeMs}:${stat.size}`;
    if (version === cache.version) return cache;
    try {
      cache = { version, ...parseConfig(await fs.readFile(file, 'utf8')), error: null };
    } catch (err) {
      // Keep showing the last groups that loaded, so a typo in the file doesn't wipe the page's layout.
      cache = { ...cache, version, error: `${file} is invalid: ${err.message}` };
    }
    return cache;
  }

  // Writing beside the file and renaming it over the top means a reader never sees half a file. That isn't
  // possible for a file bind-mounted on its own, or one in a directory the container can't write to, so an
  // existing file is overwritten in place instead. Any other failure, such as a full disk, is passed on without
  // touching the file, because overwriting it would truncate the only good copy and then fail the same way.
  async function write(text) {
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

  async function saveGroups(input) {
    const groups = normalizeGroups(input);
    const run = writing.then(async () => {
      const current = await read();
      if (current.error) throw new ConfigError(`${current.error}. Fix the file before changing groups here.`, 409);
      const doc = { ...current.doc, groups };
      try {
        await write(`${JSON.stringify(doc, null, 2)}\n`);
      } catch (err) {
        throw new ConfigError(`Can't write ${file} (${err.code || err.message}). Check that the container's node user (UID 1000) can write to it.`, 500);
      }
      // Cache what was written rather than re-reading it: two saves of the same size within the file system's
      // timestamp resolution would otherwise look unchanged and return the earlier groups.
      const stat = await fs.stat(file);
      cache = { version: `${stat.mtimeMs}:${stat.size}`, doc, groups, error: null };
      return groups;
    });
    writing = run.catch(() => {});
    return run;
  }

  // Stores the latest health check of each route beside the groups, so a restart can show them straight away
  // and wait out the interval instead of checking every route again. A file that doesn't parse is left alone.
  async function saveHealth(health) {
    const run = writing.then(async () => {
      const current = await read();
      if (current.error) return false;
      const doc = { ...current.doc, health };
      await write(`${JSON.stringify(doc, null, 2)}\n`);
      const stat = await fs.stat(file);
      cache = { ...current, version: `${stat.mtimeMs}:${stat.size}`, doc };
      return true;
    });
    writing = run.catch(() => {});
    return run;
  }

  return { file, read, saveGroups, saveHealth };
}

module.exports = { ConfigError, normalizeGroups, storedHealth, createConfigStore };
