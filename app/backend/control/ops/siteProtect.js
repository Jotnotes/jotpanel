'use strict';

const crypto = require('crypto');

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_PATTERN = /^\{SHA\}[A-Za-z0-9+/]{27}=$/;
const URL_PATH_PATTERN = /^[A-Za-z0-9/_\-.]+$/;
const FILE_PATH_PATTERN = /^\/[A-Za-z0-9/._-]+$/;

function validatePassword(password) {
  if (typeof password !== 'string') throw new Error('A password must be text');
  if (password.length < 10) throw new Error('A password must be at least 10 characters');
  if (/[\r\n\0]/.test(password)) throw new Error('A password must be written on one line and cannot contain a null character');
  return password;
}

// {SHA} is deliberately the format nginx supports using only Node's crypto
// module. The root-owned mode-0640 credentials file is the security boundary;
// changing the hash scheme needs a reviewed, maintained implementation.
function hashPassword(password) {
  validatePassword(password);
  return `{SHA}${crypto.createHash('sha1').update(password, 'utf8').digest('base64')}`;
}

function verifyPassword(password, hash) {
  if (typeof hash !== 'string') return false;
  const expected = hashPassword(password);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(hash, 'utf8');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw new Error('A username must start with a letter or number and contain no more than 64 letters, numbers, dots, underscores or hyphens');
  }
  return username;
}

function validateHash(hash) {
  if (typeof hash !== 'string' || !SHA_PATTERN.test(hash)) {
    throw new Error('A password hash must be a valid nginx {SHA} hash');
  }
  return hash;
}

function compareUsernames(left, right) {
  if (left.username < right.username) return -1;
  if (left.username > right.username) return 1;
  return 0;
}

function requireEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('The password entries must be an array');
  return entries;
}

function renderHtpasswd(entries) {
  requireEntries(entries);
  const seen = new Set();
  const checked = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Every password entry must contain a username and a hash');
    }
    const username = validateUsername(entry.username);
    const hash = validateHash(entry.hash);
    if (seen.has(username)) throw new Error(`The username ${username} appears more than once`);
    seen.add(username);
    return { username, hash };
  }).sort(compareUsernames);

  // Stable order makes the same credentials render to the same bytes and keeps
  // deployment diffs about changed passwords rather than shuffled lines.
  return checked.length
    ? `${checked.map(entry => `${entry.username}:${entry.hash}`).join('\n')}\n`
    : '';
}

function parseHtpasswd(contents) {
  if (typeof contents !== 'string') throw new Error('The htpasswd file contents must be text');
  const entries = [];
  const skipped = [];

  for (const rawLine of contents.split('\n')) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const separator = rawLine.indexOf(':');
    if (separator < 0) {
      skipped.push(rawLine);
      continue;
    }
    const username = rawLine.slice(0, separator);
    const hash = rawLine.slice(separator + 1);
    if (!USERNAME_PATTERN.test(username) || !SHA_PATTERN.test(hash)) {
      skipped.push(rawLine);
      continue;
    }
    entries.push({ username, hash });
  }

  entries.sort(compareUsernames);
  return { entries, skipped };
}

function normalizeUrlPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error('The protected path must be a URL path beginning with /');
  }
  if (!URL_PATH_PATTERN.test(value)) {
    throw new Error(`${value || 'The protected path'} contains characters that are not allowed in a site path`);
  }
  const normalized = value.replace(/\/+$/, '') || '/';
  if (normalized.split('/').includes('..')) throw new Error(`${value} is not a path inside the site`);
  return normalized;
}

function validateFilePath(value, label) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error(`${label} must be an absolute filesystem path`);
  }
  if (value.split('/').includes('..')) throw new Error(`${value} is not a safe filesystem path`);
  if (!FILE_PATH_PATTERN.test(value)) {
    throw new Error(`${label} contains characters nginx cannot safely read as a path`);
  }
  return value;
}

function validateRealm(value) {
  if (typeof value !== 'string') throw new Error('The authentication realm must be text');
  if (/["\\\r\n\0]/.test(value)) {
    throw new Error('The authentication realm cannot contain a quote, backslash, newline or null character');
  }
  return value;
}

function renderAuthLocation(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Authentication settings must be provided as an object');
  }
  const protectedPath = normalizeUrlPath(options.path);
  const authFilePath = validateFilePath(options.authFilePath, 'The htpasswd file path');
  const realm = validateRealm(options.realm === undefined ? 'Restricted' : options.realm);
  const phpSocketPath = options.phpSocketPath == null
    ? null
    : validateFilePath(options.phpSocketPath, 'The PHP socket path');
  const auth = `${' '.repeat(2)}auth_basic "${realm}";\n${' '.repeat(2)}auth_basic_user_file ${authFilePath};\n`;

  if (protectedPath === '/') {
    return {
      scope: 'server',
      text: `  # Managed by jotpanel-ops. Edit through the panel.\n${auth}`,
    };
  }

  // The trailing slash keeps /admin from matching /administrator. ^~ prevents
  // the server's broader PHP regex from winning and bypassing authentication.
  let text = `  # Managed by jotpanel-ops. Edit through the panel.\n`
    + `  location ^~ ${protectedPath}/ {\n`
    + `    auth_basic "${realm}";\n`
    + `    auth_basic_user_file ${authFilePath};\n`;

  if (phpSocketPath) {
    // ^~ also suppresses the outer PHP handler, so PHP execution has to be
    // restored inside the protected location with authentication explicit.
    text += `    location ~ \\.php$ {\n`
      + `      auth_basic "${realm}";\n`
      + `      auth_basic_user_file ${authFilePath};\n`
      + `      include snippets/fastcgi-php.conf;\n`
      + `      fastcgi_pass unix:${phpSocketPath};\n`
      + `    }\n`;
  }

  text += `  }\n`;
  return { scope: 'location', text };
}

function addOrReplaceUser(entries, username, hash) {
  requireEntries(entries);
  validateUsername(username);
  validateHash(hash);
  return [
    ...entries.filter(entry => entry && entry.username !== username).map(entry => ({ ...entry })),
    { username, hash },
  ];
}

function removeUser(entries, username) {
  requireEntries(entries);
  validateUsername(username);
  return entries
    .filter(entry => entry && entry.username !== username)
    .map(entry => ({ ...entry }));
}

module.exports = {
  hashPassword,
  verifyPassword,
  renderHtpasswd,
  parseHtpasswd,
  renderAuthLocation,
  addOrReplaceUser,
  removeUser,
};

/*
const hash = hashPassword('a long password');
const entries = addOrReplaceUser([], 'alice', hash);
const contents = renderHtpasswd(entries);
const parsed = parseHtpasswd(contents);
verifyPassword('a long password', parsed.entries[0].hash); // true
*/
