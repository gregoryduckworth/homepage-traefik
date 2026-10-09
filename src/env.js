const path = require('node:path');
const { parseEntryPointPorts } = require('./traefik');

// A missing, mistyped or tiny interval would otherwise poll back to back, so it falls back to the default or is
// raised to the minimum.
function readSeconds(env, name, { fallback, min }) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`${name}=${raw} isn't a number of seconds, so ${fallback} is used`);
    return fallback;
  }
  if (value < min) {
    console.warn(`${name}=${raw} is below the minimum, so ${min} is used`);
    return min;
  }
  return value;
}

// A port that isn't a whole number from 1 to 65535 would otherwise crash the server as it starts.
function readPort(env, fallback = 3000) {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 1 && value <= 65535) return value;
  console.warn(`PORT=${raw} isn't a port number from 1 to 65535, so ${fallback} is used`);
  return fallback;
}

// The sources in FRAME_ANCESTORS, such as "https://dash.example.com" or "*", go straight into a header, so anything
// that would end the directive or the header is refused.
function readFrameAncestors(env, fallback = "'self'") {
  const raw = (env.FRAME_ANCESTORS || '').trim();
  if (!raw) return fallback;
  if (/[;,\r\n]/.test(raw)) {
    console.warn(`FRAME_ANCESTORS=${raw} should be a space-separated list of sites, so only the homepage itself may frame it`);
    return fallback;
  }
  return raw;
}

// Everything the server takes from its environment. A value it can't use is warned about and replaced by its default.
function readSettings(env) {
  const port = readPort(env);
  const frameAncestors = readFrameAncestors(env);
  const pollSeconds = readSeconds(env, 'POLL_INTERVAL_SECONDS', { fallback: 30, min: 5 });
  const healthSeconds = readSeconds(env, 'HEALTHCHECK_INTERVAL_SECONDS', { fallback: 60, min: 10 });
  const { ports: entryPointPorts, invalid: invalidPorts } = parseEntryPointPorts(env.ENTRYPOINT_PORTS);
  if (invalidPorts.length) console.warn(`Ignoring ${invalidPorts.join(', ')} in ENTRYPOINT_PORTS: each entry should be <entry point>:<port>, such as websecure:8443`);
  const timeoutSeconds = readSeconds(env, 'HEALTHCHECK_TIMEOUT_SECONDS', { fallback: 10, min: 1 });
  return {
    port,
    frameAncestors,
    traefikUrl: env.TRAEFIK_API_URL || 'http://traefik:8080',
    pollSeconds,
    healthSeconds,
    title: env.HOMEPAGE_TITLE || 'Routes',
    version: env.HOMEPAGE_VERSION || null,
    entryPointPorts,
    configFile: path.resolve(env.CONFIG_FILE || 'config/homepage.json'),
    healthOptions: {
      timeoutMs: timeoutSeconds * 1000,
      address: env.HEALTHCHECK_ADDRESS || undefined,
    },
  };
}

module.exports = { readSettings, readSeconds, readPort, readFrameAncestors };
