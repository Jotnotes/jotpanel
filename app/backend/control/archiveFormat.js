'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 100000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeArchivePath(name) {
  const raw = String(name || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw)) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`);
  }
  const normal = path.posix.normalize(raw);
  if (normal === '..' || normal.startsWith('../') || normal.includes('/../')) {
    throw new Error(`Archive path escapes its package: ${raw}`);
  }
  return normal.replace(/^\/+/, '');
}

function dosTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Create a standards-compliant ZIP using stored entries (no compression). */
function createZip(entries, { date = new Date() } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosTime(date);

  for (const entry of entries) {
    const name = safeArchivePath(entry.name);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`${name} is too large for one portable package entry`);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8);      // stored
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // Unix, ZIP 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const out = Buffer.concat([...localParts, ...centralParts, end]);
  if (out.length > MAX_ARCHIVE_BYTES) throw new Error('Portable package exceeds the 1 GB safety limit');
  return out;
}

function readZip(buffer, limits = {}) {
  const maxArchive = limits.maxArchiveBytes || MAX_ARCHIVE_BYTES;
  const maxEntry = limits.maxEntryBytes || MAX_ENTRY_BYTES;
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > maxArchive) throw new Error('Archive exceeds the configured safety limit');
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('Not a ZIP archive');

  const min = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP directory is missing');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count > (limits.maxEntries || MAX_ENTRIES)) throw new Error('Archive contains too many entries');

  const entries = new Map();
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`ZIP directory entry ${i + 1} is corrupt`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const encoding = (flags & 0x0800) ? 'utf8' : 'latin1';
    const name = safeArchivePath(buffer.toString(encoding, nameStart, nameStart + nameLen));
    cursor = nameStart + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (size > maxEntry) throw new Error(`${name} exceeds the per-entry safety limit`);
    if (![0, 8].includes(method)) throw new Error(`${name} uses unsupported ZIP compression method ${method}`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${name} has a corrupt local header`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`${name} is truncated`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: maxEntry });
    if (data.length !== size) throw new Error(`${name} expanded to an unexpected size`);
    if (crc32(data) !== expectedCrc) throw new Error(`${name} failed its CRC check`);
    if (entries.has(name)) throw new Error(`Archive contains duplicate entry ${name}`);
    entries.set(name, data);
  }
  return entries;
}

function parseTarNumber(buffer) {
  const text = buffer.toString('utf8').replace(/\0.*$/, '').trim();
  return text ? parseInt(text, 8) : 0;
}

function parsePax(data) {
  const attrs = {};
  let cursor = 0;
  const text = data.toString('utf8');
  while (cursor < text.length) {
    const space = text.indexOf(' ', cursor);
    if (space < 0) break;
    const length = Number(text.slice(cursor, space));
    if (!length) break;
    const record = text.slice(space + 1, cursor + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) attrs[record.slice(0, eq)] = record.slice(eq + 1);
    cursor += length;
  }
  return attrs;
}

function readTar(buffer, limits = {}) {
  const maxEntry = limits.maxEntryBytes || MAX_ENTRY_BYTES;
  const maxEntries = limits.maxEntries || MAX_ENTRIES;
  const entries = new Map();
  let cursor = 0;
  let longName = null;
  let pax = {};

  while (cursor + 512 <= buffer.length) {
    const header = buffer.subarray(cursor, cursor + 512);
    if (header.every(byte => byte === 0)) break;
    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const type = String.fromCharCode(header[156] || 48);
    const size = parseTarNumber(header.subarray(124, 136));
    const dataStart = cursor + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error(`TAR entry ${rawName || '(unnamed)'} is truncated`);
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '');
    } else if (type === 'x' || type === 'g') {
      pax = { ...pax, ...parsePax(data) };
    } else {
      const combined = longName || pax.path || (prefix ? `${prefix}/${rawName}` : rawName);
      longName = null;
      pax = {};
      if ((type === '0' || type === '\0') && combined) {
        const name = safeArchivePath(combined);
        if (size > maxEntry) throw new Error(`${name} exceeds the per-entry safety limit`);
        if (!entries.has(name)) entries.set(name, Buffer.from(data));
        if (entries.size > maxEntries) throw new Error('Archive contains too many entries');
      }
    }
    cursor = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readArchiveFile(filePath, limits = {}) {
  const stat = fs.statSync(filePath);
  if (stat.size > (limits.maxArchiveBytes || MAX_ARCHIVE_BYTES)) {
    throw new Error('Archive exceeds the configured safety limit');
  }
  let buffer = fs.readFileSync(filePath);
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    return { format: 'zip', entries: readZip(buffer, limits) };
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer = zlib.gunzipSync(buffer, { maxOutputLength: limits.maxExpandedBytes || MAX_ARCHIVE_BYTES });
    return { format: 'tar.gz', entries: readTar(buffer, limits) };
  }
  if (buffer.length >= 265 && buffer.toString('ascii', 257, 262) === 'ustar') {
    return { format: 'tar', entries: readTar(buffer, limits) };
  }
  throw new Error('Unsupported archive. Use a JotPanel ZIP or a cPanel, Plesk, or DirectAdmin ZIP/TAR package.');
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_BYTES,
  crc32,
  sha256,
  safeArchivePath,
  createZip,
  readZip,
  readTar,
  readArchiveFile,
};
