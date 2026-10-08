const fs = require('node:fs/promises');
const { writeSafely } = require('./files');

const MAX_GROUPS = 100;
const MAX_NAME_LENGTH = 60;
const MAX_ROUTE_SETTINGS = 1000;
const MAX_ICON_LENGTH = 2048;
const MAX_LINKS = 100;
const LINK_PREFIX = 'link:';

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

// A route's own name and icon, both optional. Returns null when neither is set, so the entry can be dropped.
// `label` names the route mid-sentence in error messages.
function normalizeRouteSetting(input, label = 'the route') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError(`Settings for ${label} must be an object with "name" and "icon"`);
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
  if (!name && !icon) return null;
  return { ...(name && { name }), ...(icon && { icon }) };
}

// Keyed by Traefik router name. Entries for routers Traefik isn't serving are kept, like group members.
function normalizeRouteSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError('"routes" must be an object keyed by router name');
  const entries = Object.entries(input);
  if (entries.length > MAX_ROUTE_SETTINGS) throw new ConfigError(`There can be at most ${MAX_ROUTE_SETTINGS} entries in "routes"`);
  return Object.fromEntries(entries
    .map(([id, setting]) => [id, normalizeRouteSetting(setting, `route "${id}"`)])
    .filter(([, setting]) => setting));
}

function isWebAddress(value) {
  return /^https?:\/\/./i.test(value) && URL.canParse(value) && value.length <= MAX_ICON_LENGTH;
}

// A link to a site that isn't behind Traefik, such as a router's admin page. Groups refer to it as "link:<name>",
// so names are unique, ignoring case.
function normalizeLink(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError(`${label} must be an object with "name" and "url"`);
  const field = key => {
    const value = input[key] ?? '';
    if (typeof value !== 'string') throw new ConfigError(`"${key}" for ${label} must be text`);
    return value.trim();
  };
  const name = field('name');
  const url = field('url');
  const icon = field('icon');
  if (!name) throw new ConfigError(`${label} needs a name`);
  if (name.length > MAX_NAME_LENGTH) throw new ConfigError(`Link names can be at most ${MAX_NAME_LENGTH} characters`);
  if (!isWebAddress(url)) throw new ConfigError(`The address of ${label} must start with http:// or https://`);
  if (icon && !isWebAddress(icon)) throw new ConfigError(`The icon for ${label} must be the http:// or https:// address of an image`);
  return { name, url, ...(icon && { icon }) };
}

function normalizeLinks(input) {
  if (!Array.isArray(input)) throw new ConfigError('"links" must be a list');
  if (input.length > MAX_LINKS) throw new ConfigError(`There can be at most ${MAX_LINKS} links`);
  const names = new Set();
  return input.map((item, index) => {
    const link = normalizeLink(item, `link ${index + 1}`);
    if (names.has(link.name.toLowerCase())) throw new ConfigError(`There's already a link called "${link.name}"`);
    names.add(link.name.toLowerCase());
    return link;
  });
}

function linkId(name) {
  return `${LINK_PREFIX}${name}`;
}

// Saved health results are only a cache, so entries that don't look like one are dropped rather than reported.
function storedHealth(doc) {
  const entries = doc?.health && typeof doc.health === 'object' && !Array.isArray(doc.health) ? Object.entries(doc.health) : [];
  return new Map(entries.filter(([, result]) => result && typeof result.url === 'string' && !Number.isNaN(Date.parse(result.checkedAt))));
}

function parseConfig(text) {
  // An empty file (say, one just created with touch so it can be mounted) means no groups yet.
  if (!text.trim()) return { doc: {}, groups: [], routes: {}, links: [] };
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ConfigError('expected a JSON object with a "groups" list');
  return {
    doc,
    groups: normalizeGroups(doc.groups ?? []),
    routes: normalizeRouteSettings(doc.routes ?? {}),
    links: normalizeLinks(doc.links ?? []),
  };
}

function versionOf(stat) {
  return `${stat.mtimeMs}:${stat.size}`;
}

// The file is re-read whenever it changes on disk, so hand edits show up without a restart.
function createConfigStore({ file }) {
  const empty = { version: null, doc: {}, groups: [], routes: {}, links: [], error: null };
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
  // look unchanged and return the earlier contents.
  async function commit(current, doc, changed = {}) {
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

  // Sets or clears one route's name and icon. Returns the saved setting, or null when both were cleared.
  async function saveRoute(id, input) {
    if (typeof id !== 'string' || !id) throw new ConfigError('Give the router name of the route to change');
    const setting = normalizeRouteSetting(input);
    return queue(async () => {
      const current = await readForChange('routes');
      // fromEntries defines own keys, so even a router named __proto__ is stored as a plain entry.
      const others = Object.entries(current.routes).filter(([key]) => key !== id);
      const routes = Object.fromEntries(setting ? [...others, [id, setting]] : others);
      if (Object.keys(routes).length > MAX_ROUTE_SETTINGS) throw new ConfigError(`There can be at most ${MAX_ROUTE_SETTINGS} entries in "routes"`);
      const { routes: _routes, ...rest } = current.doc;
      await commit(current, Object.keys(routes).length ? { ...current.doc, routes } : rest, { routes });
      return setting;
    });
  }

  // Adds a link, or changes the one called `currentName`. Renaming it also renames it in its group, in the same
  // write, so it doesn't drop out of the group. Returns the saved link.
  async function saveLink(currentName, input) {
    const link = normalizeLink(input, 'the link');
    return queue(async () => {
      const current = await readForChange('links');
      const key = typeof currentName === 'string' ? currentName.toLowerCase() : null;
      const others = current.links.filter(item => item.name.toLowerCase() !== key);
      if (others.some(item => item.name.toLowerCase() === link.name.toLowerCase())) {
        throw new ConfigError(`There's already a link called "${link.name}"`, 409);
      }
      const existing = current.links.find(item => item.name.toLowerCase() === key);
      if (!existing && others.length >= MAX_LINKS) throw new ConfigError(`There can be at most ${MAX_LINKS} links`);
      const links = existing ? current.links.map(item => (item === existing ? link : item)) : [...current.links, link];
      const from = existing && linkId(existing.name);
      const groups = current.groups.map(group => ({ ...group, routes: group.routes.map(id => (id === from ? linkId(link.name) : id)) }));
      await commit(current, { ...current.doc, links, groups }, { links, groups });
      return link;
    });
  }

  // Removes a link and takes it out of its group. Resolves to whether there was one to remove.
  async function deleteLink(name) {
    return queue(async () => {
      const current = await readForChange('links');
      const key = typeof name === 'string' ? name.toLowerCase() : null;
      const existing = current.links.find(item => item.name.toLowerCase() === key);
      if (!existing) return false;
      const links = current.links.filter(item => item !== existing);
      const groups = current.groups.map(group => ({ ...group, routes: group.routes.filter(id => id !== linkId(existing.name)) }));
      const { links: _links, ...rest } = current.doc;
      await commit(current, { ...(links.length ? { ...current.doc, links } : rest), groups }, { links, groups });
      return true;
    });
  }

  // Stores the latest health check of each route beside the groups, so a restart can show them straight away
  // and wait out the interval instead of checking every route again. A file that doesn't parse is left alone.
  async function saveHealth(health) {
    return queue(async () => {
      const current = await read();
      if (current.error) return false;
      await commit(current, { ...current.doc, health });
      return true;
    });
  }

  return { file, read, saveGroups, saveRoute, saveLink, deleteLink, saveHealth };
}

module.exports = { ConfigError, normalizeGroups, normalizeRouteSettings, normalizeLinks, linkId, storedHealth, createConfigStore };
