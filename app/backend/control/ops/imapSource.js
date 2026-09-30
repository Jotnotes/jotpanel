'use strict';

// A read-only IMAP client, used to look at the server somebody is leaving
// before a single message is copied off it.
//
// This exists because the majority of people who want to move do not have an
// archive. They have a mailbox, a password and a host name that somebody wrote
// down for them years ago, and the first honest thing a panel can do is say
// whether those three work, what is actually in there and how big it is. Every
// migration that goes wrong in public goes wrong because nobody looked first.
//
// It speaks the smallest useful part of the protocol: log in, list the folders,
// ask each one how many messages it holds, log out. It sends no command that
// changes anything on the far side, and it never will, because the far side is
// somebody's live mail server and this panel is a guest on it.
//
// Everything below the connection is a pure function over bytes, so the parsing
// can be tested without a server, which is where the defects in a hand-written
// protocol client actually live.

const net = require('net');
const tls = require('tls');

// A folder list is small. Anything answering in megabytes is either broken or
// hostile, and either way this stops reading rather than filling memory.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_FOLDERS = 2000;
const DEFAULT_TIMEOUT_MS = 30000;

// ── The protocol, as pure functions ────────────────────────────────

// One complete response line, with literals folded into it.
//
// IMAP does not end a line at the first CRLF: a segment ending in {123} means
// the next 123 octets are part of the same line and the line continues after
// them. A reader that splits on CRLF gets folder names with newlines in them
// wrong, which is the classic way this kind of client is written and the
// classic way it breaks on somebody's real mail server.
//
// Buffers are handled as latin1 throughout, so one character is one octet and
// the literal counts line up. Folder names are decoded from modified UTF-7
// afterwards, which is the encoding the protocol actually specifies for them.
function takeLine(buffer) {
  let assembled = '';
  let from = 0;
  for (;;) {
    const end = buffer.indexOf('\r\n', from);
    if (end < 0) return null;
    const segment = buffer.slice(from, end);
    const literal = /\{(\d+)\+?\}$/.exec(segment);
    if (!literal) return { line: assembled + segment, rest: buffer.slice(end + 2) };
    const size = Number(literal[1]);
    const start = end + 2;
    if (size > MAX_RESPONSE_BYTES) throw new Error('the mail server sent a literal larger than this panel will read');
    if (buffer.length < start + size) return null;
    // The literal becomes a quoted string, so one parser below handles both
    // forms rather than two parsers that have to agree with each other.
    assembled += `${segment.slice(0, literal.index)}"${buffer.slice(start, start + size).replace(/([\\"])/g, '\\$1')}"`;
    from = start + size;
  }
}

// A quoted string or a bare atom, starting at `at`. Returns where it ended so
// the caller can carry on along the line.
function readAstring(line, at) {
  let index = at;
  while (index < line.length && line[index] === ' ') index += 1;
  if (index >= line.length) return null;
  if (line[index] === '"') {
    let value = '';
    index += 1;
    while (index < line.length) {
      const character = line[index];
      if (character === '\\' && index + 1 < line.length) { value += line[index + 1]; index += 2; continue; }
      if (character === '"') return { value, next: index + 1 };
      value += character; index += 1;
    }
    return null;
  }
  const start = index;
  while (index < line.length && line[index] !== ' ' && line[index] !== ')') index += 1;
  return { value: line.slice(start, index), next: index };
}

// `* LIST (\HasNoChildren \Trash) "/" "INBOX/Old post"`
function parseListLine(line) {
  const match = /^\*\s+(?:LIST|LSUB|XLIST)\s+\(([^)]*)\)\s*/i.exec(line);
  if (!match) return null;
  const flags = match[1].split(/\s+/).filter(Boolean).map(flag => flag.toLowerCase());
  const delimiter = readAstring(line, match[0].length);
  if (!delimiter) return null;
  const name = readAstring(line, delimiter.next);
  if (!name || !name.value) return null;
  return {
    name: decodeModifiedUtf7(name.value),
    raw_name: name.value,
    delimiter: delimiter.value === 'NIL' ? null : delimiter.value,
    flags,
    // \Noselect and \NonExistent are containers rather than folders. Asking one
    // of them for a message count is an error on every server, so they are
    // carried through the list and skipped by the counting pass.
    selectable: !flags.includes('\\noselect') && !flags.includes('\\nonexistent'),
  };
}

// `* STATUS "INBOX" (MESSAGES 4213 SIZE 918273645)`
function parseStatusLine(line) {
  const match = /^\*\s+STATUS\s+/i.exec(line);
  if (!match) return null;
  const name = readAstring(line, match[0].length);
  if (!name) return null;
  const open = line.indexOf('(', name.next);
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const items = line.slice(open + 1, close).split(/\s+/).filter(Boolean);
  const values = {};
  for (let index = 0; index + 1 < items.length; index += 2) values[items[index].toUpperCase()] = Number(items[index + 1]);
  return {
    name: decodeModifiedUtf7(name.value),
    raw_name: name.value,
    messages: Number.isFinite(values.MESSAGES) ? values.MESSAGES : null,
    bytes: Number.isFinite(values.SIZE) ? values.SIZE : null,
  };
}

// Folder names travel in modified UTF-7 (RFC 3501 §5.1.3), so a French or
// Japanese folder arrives as &AOk-l&AOk-ment rather than as itself. Decoding it
// is the difference between a migration preview somebody trusts and one that
// looks corrupted before it has copied anything.
function decodeModifiedUtf7(value) {
  const text = String(value == null ? '' : value);
  if (!text.includes('&')) return text;
  let out = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '&') { out += text[index]; index += 1; continue; }
    const end = text.indexOf('-', index + 1);
    if (end < 0) { out += text.slice(index); break; }
    const encoded = text.slice(index + 1, end);
    if (encoded === '') { out += '&'; index = end + 1; continue; }
    try {
      const base64 = encoded.replace(/,/g, '/');
      const bytes = Buffer.from(base64 + '==='.slice((base64.length + 3) % 4), 'base64');
      let decoded = '';
      for (let at = 0; at + 1 < bytes.length; at += 2) decoded += String.fromCharCode(bytes.readUInt16BE(at));
      out += decoded;
    } catch { out += text.slice(index, end + 1); }
    index = end + 1;
  }
  return out;
}

// Anything the caller supplies that is going into a command is checked here.
// A carriage return inside a mailbox password is how a client that concatenates
// strings sends a second command nobody asked for, and this client concatenates
// strings, so it refuses the character instead.
function protocolString(value, field) {
  const clean = String(value == null ? '' : value);
  if (!clean) throw new Error(`${field} is required`);
  if (clean.length > 512) throw new Error(`${field} is too long`);
  if (/[\r\n\0]/.test(clean)) throw new Error(`${field} may not contain a line break`);
  return clean;
}

function quote(value) {
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

// ── The connection ─────────────────────────────────────────────────

function connect({ host, port, security, allowUntrusted, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const settled = value => { clearTimeout(timer); resolve(value); };
    const failed = error => { clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => {
      socket.destroy();
      failed(new Error(`${host}:${port} did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    const socket = security === 'tls'
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: !allowUntrusted })
      : net.connect({ host, port });
    socket.once(security === 'tls' ? 'secureConnect' : 'connect', () => settled(socket));
    socket.once('error', error => failed(new Error(describeSocketError(error, host, port))));
  });
}

function describeSocketError(error, host, port) {
  const code = error && error.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${host} does not resolve to an address from this server`;
  if (code === 'ECONNREFUSED') return `nothing is listening on ${host}:${port}`;
  if (code === 'ETIMEDOUT') return `${host}:${port} accepted nothing before the connection timed out, which is usually a firewall`;
  if (code === 'ECONNRESET') return `${host}:${port} closed the connection, which usually means the wrong port or the wrong kind of encryption for it`;
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return `${host} presents a certificate it signed itself. Tick "accept an unverified certificate" if you know the server and want to continue anyway`;
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return `the certificate on ${host} is for a different name (${error.message})`;
  if (code === 'CERT_HAS_EXPIRED') return `the certificate on ${host} has expired`;
  return `${host}:${port} could not be reached: ${error && error.message ? error.message : 'unknown error'}`;
}

// One command, one tagged answer. Untagged lines arriving in between are the
// data, and are handed back with it.
function createSession(socket, timeoutMs) {
  let buffer = '';
  let counter = 0;
  let closed = null;
  const waiters = [];

  socket.setEncoding('latin1');
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_RESPONSE_BYTES) {
      closed = new Error('the mail server sent more than this panel will read in one answer');
      socket.destroy();
    }
    pump();
  });
  socket.on('error', error => { closed = closed || new Error(error.message); pump(); });
  socket.on('close', () => { closed = closed || new Error('the mail server closed the connection'); pump(); });

  function pump() {
    while (waiters.length) {
      const waiter = waiters[0];
      if (closed) { waiters.shift(); waiter.reject(closed); continue; }
      let taken;
      try { taken = takeLine(buffer); } catch (error) { waiters.shift(); waiter.reject(error); continue; }
      if (!taken) return;
      buffer = taken.rest;
      if (waiter.accept(taken.line)) waiters.shift();
    }
  }

  // Reads lines until `done` says this answer is finished.
  function collect(done) {
    return new Promise((resolve, reject) => {
      const lines = [];
      const timer = setTimeout(() => { closed = closed || new Error(`the mail server stopped answering after ${Math.round(timeoutMs / 1000)} seconds`); pump(); }, timeoutMs);
      waiters.push({
        accept(line) {
          lines.push(line);
          if (!done(line)) return false;
          clearTimeout(timer);
          resolve(lines);
          return true;
        },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      pump();
    });
  }

  async function greeting() {
    const [line] = await collect(line => /^\*\s/.test(line));
    if (!/^\*\s+(OK|PREAUTH)\b/i.test(line)) throw new Error(`the mail server refused the connection: ${line.replace(/^\*\s*/, '')}`);
    return line;
  }

  async function send(command, describe) {
    counter += 1;
    const tag = `a${String(counter).padStart(3, '0')}`;
    socket.write(`${tag} ${command}\r\n`);
    const lines = await collect(line => line.startsWith(`${tag} `));
    const final = lines[lines.length - 1];
    const answer = final.slice(tag.length + 1);
    if (!/^OK\b/i.test(answer)) throw new Error(`${describe}: ${answer.replace(/^(NO|BAD)\s*/i, '').trim() || answer}`);
    return { lines: lines.slice(0, -1), answer };
  }

  return { greeting, send, socket };
}

// ── What the panel asks for ────────────────────────────────────────

// Log in, count what is there, log out. Nothing else, and nothing that writes.
async function inspectImapSource(options = {}) {
  const host = protocolString(options.host, 'the mail server name');
  const username = protocolString(options.username, 'the mailbox login');
  const password = protocolString(options.password, 'the mailbox password');
  const security = ['tls', 'starttls', 'plain'].includes(options.security) ? options.security : 'tls';
  const port = Number(options.port) || (security === 'tls' ? 993 : 143);
  const allowUntrusted = options.allowUntrusted === true;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the mail server port must be a number between 1 and 65535');
  if (!/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/.test(host)) throw new Error(`${options.host} is not a host name or address`);

  let socket = await connect({ host, port, security, allowUntrusted, timeoutMs });
  let session = createSession(socket, timeoutMs);
  await session.greeting();

  if (security === 'starttls') {
    await session.send('STARTTLS', `${host}:${port} would not start encryption`);
    socket = await upgrade(socket, { host, allowUntrusted, timeoutMs });
    session = createSession(socket, timeoutMs);
  }

  try {
    await session.send(`LOGIN ${quote(username)} ${quote(password)}`, `${host} refused the login for ${username}`);
    const capability = await session.send('CAPABILITY', `${host} would not report what it supports`).catch(() => ({ lines: [] }));
    const advertised = capability.lines.join(' ').toUpperCase();
    const canSize = advertised.includes('STATUS=SIZE');

    const listed = await session.send('LIST "" "*"', `${host} would not list the folders`);
    const folders = [];
    for (const line of listed.lines) {
      const parsed = parseListLine(line);
      if (parsed) folders.push(parsed);
      if (folders.length >= MAX_FOLDERS) break;
    }
    if (!folders.length) throw new Error(`${username} signed in but the server listed no folders at all, which usually means the login is not the one that owns the mailbox`);

    const counted = [];
    for (const folder of folders) {
      if (!folder.selectable) { counted.push({ ...folder, messages: null, bytes: null, note: 'a container rather than a folder' }); continue; }
      try {
        const status = await session.send(`STATUS ${quote(folder.raw_name)} (MESSAGES${canSize ? ' SIZE' : ''})`, `${host} would not report on ${folder.name}`);
        const parsed = status.lines.map(parseStatusLine).find(Boolean);
        counted.push({ ...folder, messages: parsed ? parsed.messages : null, bytes: parsed ? parsed.bytes : null });
      } catch (error) {
        // One unreadable folder is a fact about that folder, not a failed
        // inspection. It is reported and the rest are still counted.
        counted.push({ ...folder, messages: null, bytes: null, note: error.message });
      }
    }

    await session.send('LOGOUT', 'the mail server would not log out cleanly').catch(() => null);
    const readable = counted.filter(folder => Number.isFinite(folder.messages));
    return {
      host, port, security, username,
      certificate_verified: security === 'plain' ? false : !allowUntrusted,
      folders: counted.map(({ raw_name: _raw, ...rest }) => rest),
      folder_count: counted.length,
      message_count: readable.reduce((total, folder) => total + folder.messages, 0),
      bytes: readable.some(folder => Number.isFinite(folder.bytes)) ? readable.reduce((total, folder) => total + (folder.bytes || 0), 0) : null,
      unreadable: counted.filter(folder => folder.note && folder.selectable).map(folder => ({ folder: folder.name, why: folder.note })),
      // Said here so the screen does not have to know the protocol. Nothing
      // above sends a command that changes anything on the far side.
      read_only: true,
      verified: true,
    };
  } finally {
    try { socket.destroy(); } catch { /* the connection is going away either way */ }
  }
}

function upgrade(socket, { host, allowUntrusted, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { secure.destroy(); reject(new Error(`${host} did not complete encryption within ${Math.round(timeoutMs / 1000)} seconds`)); }, timeoutMs);
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized: !allowUntrusted }, () => { clearTimeout(timer); resolve(secure); });
    secure.once('error', error => { clearTimeout(timer); reject(new Error(describeSocketError(error, host, 'starttls'))); });
  });
}

module.exports = {
  inspectImapSource,
  // Exported for the tests, which is where a hand-written protocol parser has
  // to be exercised, because the alternative is finding out on a customer's
  // live mail server.
  takeLine, readAstring, parseListLine, parseStatusLine, decodeModifiedUtf7, protocolString, quote,
};
