const fs = require('node:fs/promises');
const { writeSafely, directoryInsteadOfFile } = require('./files');

const MAX_GROUPS = 100;
const MAX_NAME_LENGTH = 60;
const MAX_ROUTE_SETTINGS = 1000;
const MAX_ICON_LENGTH = 2048;

// Thrown for config the user can fix: a bad request body, or a hand-edited file that doesn't parse.
class ConfigError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function checkRouteCount(count) {
  if (count > MAX_ROUTE_SETTINGS) throw new ConfigError(`There can be at most ${MAX_ROUTE_SETTINGS} entries in "routes"`);
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

// A route's own name and icon, and whether it's hidden, all optional. Returns null when none is set, so the entry
// can be dropped. `label` names the route mid-sentence in error messages.
function normalizeRouteSetting(input, label = 'the route') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError(`Settings for ${label} must be an object with "name", "icon" and "hidden"`);
  const field = key => {
    const value = input[key] ?? '';
    if (typeof value !== 'string') throw new ConfigError(`"${key}" for ${label} must be text`);
    return value.trim();
  };
  const name = field('name');
  const icon = field('icon');
  if (name.length > MAX_NAME_LENGTH) throw new ConfigError(`Route names can be at most ${MAX_NAME_LENGTH} characters`);
  if (icon && (!/^https?:\/\/./i.test(icon) || !URL.canParse(icon) || icon.length > MAX_ICON_LENGTH)) {
    throw new ConfigError(`The icon for ${label} must be the http:// or https:// address of an image`);
  }
  const hidden = input.hidden ?? false;
  if (typeof hidden !== 'boolean') throw new ConfigError(`"hidden" for ${label} must be true or false`);
  if (!name && !icon && !hidden) return null;
  return { ...(name && { name }), ...(icon && { icon }), ...(hidden && { hidden }) };
}

// Keyed by Traefik router name. Entries for routers Traefik isn't serving are kept, like group members.
function normalizeRouteSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError('"routes" must be an object keyed by router name');
  const entries = Object.entries(input);
  checkRouteCount(entries.length);
  return Object.fromEntries(entries
    .map(([id, setting]) => [id, normalizeRouteSetting(setting, `route "${id}"`)])
    .filter(([, setting]) => setting));
}

function parseConfig(text) {
  // An empty file (say, one just created with touch so it can be mounted) means no groups yet.
  if (!text.trim()) return { doc: {}, groups: [], routes: {} };
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ConfigError('expected a JSON object with a "groups" list');
  return { doc, groups: normalizeGroups(doc.groups ?? []), routes: normalizeRouteSettings(doc.routes ?? {}) };
}

function versionOf(stat) {
  return `${stat.mtimeMs}:${stat.size}`;
}

// The file is re-read whenever it changes on disk, so hand edits show up without a restart.
function createConfigStore({ file }) {
  const empty = { version: null, doc: {}, groups: [], routes: {}, error: null };
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
      cache = { ...cache, version: null, error: directoryInsteadOfFile(file) };
      return cache;
    }

    const version = versionOf(stat);
    if (version === cache.version) return cache;
    try {
      cache = { version, ...parseConfig(await fs.readFile(file, 'utf8')), error: null };
    } catch (err) {
      // Keep showing the last groups that loaded, so a typo in the file doesn't wipe the page's layout.
      cache = { ...cache, version, error: `${file} is invalid: ${err.message}` };
    }
    return cache;
  }

  // Saves run one at a time, each on top of the file as the previous one left it.
  function queue(task) {
    const run = writing.then(task);
    writing = run.catch(() => {});
    return run;
  }

  // A change made on the page isn't saved over a file that doesn't parse, which would throw away the hand edits.
  async function readForChange(what) {
    const current = await read();
    if (current.error) throw new ConfigError(`${current.error}. Fix the file before changing ${what} here.`, 409);
    return current;
  }

  // Writes `doc` and caches it along with the parsed fields it changed. Caching what was written rather than
  // re-reading it matters: two saves of the same size within the file system's timestamp resolution would otherwise
  // look unchanged and return the earlier contents. Older versions saved health checks here, which are no longer
  // kept, so any left over are dropped.
  async function commit(current, { health: _health, ...doc }, changed = {}) {
    // A change that leaves the file as it was, such as saving a route's name unchanged, isn't written: that would
    // only wear the disk, and reformat a file edited by hand.
    if (JSON.stringify(doc) === JSON.stringify(current.doc)) return;
    try {
      await writeSafely(file, `${JSON.stringify(doc, null, 2)}\n`);
    } catch (err) {
      throw new ConfigError(`Can't write ${file} (${err.code || err.message}). Check that the container's node user (UID 1000) can write to it.`, 500);
    }
    cache = { ...current, ...changed, version: versionOf(await fs.stat(file)), doc, error: null };
  }

  async function saveGroups(input) {
    const groups = normalizeGroups(input);
    return queue(async () => {
      const current = await readForChange('groups');
      await commit(current, { ...current.doc, groups }, { groups });
      return groups;
    });
  }

  // Sets or clears one route's name, icon and whether it's hidden. A field left out of `input` keeps its saved value,
  // so hiding a route doesn't need its name and icon. Returns the saved setting, or null when all were cleared.
  async function saveRoute(id, input) {
    if (typeof id !== 'string' || !id) throw new ConfigError('Give the router name of the route to change');
    normalizeRouteSetting(input);
    return queue(async () => {
      const current = await readForChange('routes');
      const setting = normalizeRouteSetting({ ...current.routes[id], ...input });
      // fromEntries defines own keys, so even a router named __proto__ is stored as a plain entry.
      const others = Object.entries(current.routes).filter(([key]) => key !== id);
      const routes = Object.fromEntries(setting ? [...others, [id, setting]] : others);
      checkRouteCount(Object.keys(routes).length);
      const { routes: _routes, ...rest } = current.doc;
      await commit(current, Object.keys(routes).length ? { ...current.doc, routes } : rest, { routes });
      return setting;
    });
  }

  return { file, read, saveGroups, saveRoute };
}

module.exports = { ConfigError, normalizeGroups, normalizeRouteSettings, createConfigStore };
