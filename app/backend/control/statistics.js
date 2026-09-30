'use strict';

const crypto = require('crypto');
const fs = require('fs');

function createStatisticsService({ db, secret, now = () => new Date(), fileSystem = fs } = {}) {
  if (!db || !secret) throw new Error('statistics service requires a database and secret');
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_events (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      site_id         TEXT,
      site_name       TEXT,
      path            TEXT NOT NULL,
      referrer_domain TEXT,
      device          TEXT,
      visitor_hash    TEXT NOT NULL,
      status_code     INTEGER NOT NULL DEFAULT 200,
      ts              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_web_events_user_ts ON web_events (user_id, ts);
    CREATE INDEX IF NOT EXISTS idx_web_events_site_ts ON web_events (site_id, ts);
    CREATE TABLE IF NOT EXISTS web_log_offsets (
      path TEXT PRIMARY KEY,
      inode TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  addColumn(db, 'web_events', 'source', "TEXT NOT NULL DEFAULT 'node'");
  addColumn(db, 'web_events', 'bytes_sent', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'web_events', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'web_events', 'is_pageview', 'INTEGER NOT NULL DEFAULT 1');

  function record({ userId, siteId = null, siteName = null, requestPath = '/', referrer = '', userAgent = '', ip = '', statusCode = 200 }) {
    if (!userId) return;
    const referrerDomain = parseReferrer(referrer);
    const device = classifyDevice(userAgent);
    const visitorHash = crypto.createHmac('sha256', secret).update(`${ip}\0${userAgent}`).digest('hex').slice(0, 32);
    db.prepare(`INSERT INTO web_events
      (id,user_id,site_id,site_name,path,referrer_domain,device,visitor_hash,status_code,ts,source,bytes_sent,is_bot,is_pageview)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomBytes(10).toString('hex'), userId, siteId, siteName,
        String(requestPath || '/').slice(0, 500), referrerDomain, device, visitorHash,
        Number(statusCode) || 200, now().toISOString(), 'node', 0, isBot(userAgent) ? 1 : 0, 1);
  }

  async function ingestAccessLog({ userId, siteId, siteName, path }) {
    let stat;
    try { stat = await fileSystem.promises.stat(path); }
    catch (error) { return { ok: false, path, reason: `${path} cannot be read: ${error.message}`, added: 0 }; }
    if (!stat.isFile()) return { ok: false, path, reason: `${path} is not a readable file`, added: 0 };
    const inode = `${stat.dev}:${stat.ino}`;
    const saved = db.prepare('SELECT inode,byte_offset FROM web_log_offsets WHERE path=?').get(path);
    const start = saved && saved.inode === inode && stat.size >= saved.byte_offset ? saved.byte_offset : 0;
    let carry = Buffer.alloc(0), consumed = start, added = 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO web_events
      (id,user_id,site_id,site_name,path,referrer_domain,device,visitor_hash,status_code,ts,source,bytes_sent,is_bot,is_pageview)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    try {
      for await (const chunk of fileSystem.createReadStream(path, { start })) {
        const data = Buffer.concat([carry, chunk]);
        const dataStart = consumed - carry.length;
        let lineStart = 0;
        for (let i = 0; i < data.length; i += 1) {
          if (data[i] !== 10) continue;
          const event = parseCombinedLogLine(data.subarray(lineStart, i).toString('utf8').replace(/\r$/, ''));
          if (event) {
            const eventId = crypto.createHmac('sha256', secret).update(`${path}\0${inode}\0${dataStart + lineStart}`).digest('hex').slice(0, 20);
            const result = insert.run(eventId, userId, siteId, siteName,
              event.path.slice(0, 500), parseReferrer(event.referrer), classifyDevice(event.userAgent),
              crypto.createHmac('sha256', secret).update(`${event.ip}\0${event.userAgent}`).digest('hex').slice(0, 32),
              event.statusCode, event.ts, 'access_log', event.bytesSent, isBot(event.userAgent) ? 1 : 0,
              isPageView(event.method, event.path) ? 1 : 0);
            added += result.changes;
          }
          lineStart = i + 1;
        }
        consumed += data.length - carry.length;
        carry = data.subarray(lineStart);
      }
      consumed -= carry.length;
      db.prepare(`INSERT INTO web_log_offsets(path,inode,byte_offset,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET inode=excluded.inode,byte_offset=excluded.byte_offset,updated_at=excluded.updated_at`)
        .run(path, inode, consumed, now().toISOString());
      return { ok: true, path, added };
    } catch (error) {
      return { ok: false, path, reason: `${path} cannot be read: ${error.message}`, added: 0 };
    }
  }

  function report(userId, { siteId = null, days = 30, ingestion = [] } = {}) {
    const safeDays = Math.max(1, Math.min(Number(days) || 30, 365));
    const to = now();
    const from = new Date(to.getTime() - safeDays * 86400000);
    const previousFrom = new Date(from.getTime() - safeDays * 86400000);
    const filter = siteId ? ' AND site_id=?' : '';
    const args = siteId ? [userId, from.toISOString(), siteId] : [userId, from.toISOString()];
    const totals = db.prepare(`SELECT COUNT(*) hits,SUM(CASE WHEN is_bot=0 AND is_pageview=1 THEN 1 ELSE 0 END) pageviews,
      COUNT(DISTINCT CASE WHEN is_bot=0 AND is_pageview=1 THEN visitor_hash END) visitors,COUNT(DISTINCT site_id) sites,
      COALESCE(SUM(bytes_sent),0) bandwidth,COALESCE(SUM(is_bot),0) bot_hits
      FROM web_events WHERE user_id=? AND ts>=?${filter}`).get(...args);
    const previousArgs = siteId ? [userId, previousFrom.toISOString(), from.toISOString(), siteId] : [userId, previousFrom.toISOString(), from.toISOString()];
    const previous = db.prepare(`SELECT SUM(CASE WHEN is_bot=0 AND is_pageview=1 THEN 1 ELSE 0 END) pageviews,
      COUNT(DISTINCT CASE WHEN is_bot=0 AND is_pageview=1 THEN visitor_hash END) visitors
      FROM web_events WHERE user_id=? AND ts>=? AND ts<?${filter}`).get(...previousArgs);
    const dailyRows = db.prepare(`SELECT substr(ts,1,10) day,SUM(CASE WHEN is_bot=0 AND is_pageview=1 THEN 1 ELSE 0 END) pageviews,
      COUNT(DISTINCT CASE WHEN is_bot=0 AND is_pageview=1 THEN visitor_hash END) visitors
      FROM web_events WHERE user_id=? AND ts>=?${filter} GROUP BY substr(ts,1,10) ORDER BY day`).all(...args);
    const topPages = db.prepare(`SELECT path,COUNT(*) pageviews,COUNT(DISTINCT visitor_hash) visitors
      FROM web_events WHERE user_id=? AND ts>=? AND is_bot=0 AND is_pageview=1${filter} GROUP BY path ORDER BY pageviews DESC LIMIT 10`).all(...args);
    const sources = db.prepare(`SELECT COALESCE(referrer_domain,'Direct') source,COUNT(*) visits
      FROM web_events WHERE user_id=? AND ts>=? AND is_bot=0${filter} GROUP BY COALESCE(referrer_domain,'Direct') ORDER BY visits DESC LIMIT 8`).all(...args);
    const devices = db.prepare(`SELECT COALESCE(device,'Other') device,COUNT(*) visits
      FROM web_events WHERE user_id=? AND ts>=? AND is_bot=0${filter} GROUP BY COALESCE(device,'Other') ORDER BY visits DESC`).all(...args);
    const sites = db.prepare(`SELECT COALESCE(site_id,'') id,COALESCE(site_name,'Unknown site') name,SUM(CASE WHEN is_bot=0 AND is_pageview=1 THEN 1 ELSE 0 END) pageviews
      FROM web_events WHERE user_id=? AND ts>=? GROUP BY site_id,site_name ORDER BY pageviews DESC`).all(userId, from.toISOString());
    const statuses = db.prepare(`SELECT status_code status,COUNT(*) hits FROM web_events WHERE user_id=? AND ts>=?${filter} GROUP BY status_code ORDER BY hits DESC`).all(...args);
    const hourly = db.prepare(`SELECT substr(ts,12,2) hour,COUNT(*) hits FROM web_events WHERE user_id=? AND ts>=? AND is_bot=0${filter} GROUP BY substr(ts,12,2) ORDER BY hour`).all(...args);
    const entryPages = db.prepare(`SELECT path,COUNT(*) entries FROM web_events WHERE user_id=? AND ts>=? AND is_bot=0 AND is_pageview=1 AND (referrer_domain IS NULL OR lower(referrer_domain)!=lower(site_name))${filter} GROUP BY path ORDER BY entries DESC LIMIT 10`).all(...args);

    return {
      period: { days: safeDays, from: from.toISOString(), to: to.toISOString() },
      totals: {
        pageviews: totals.pageviews,
        visitors: totals.visitors,
        sites: totals.sites,
        pageviews_change_pct: percentChange(totals.pageviews, previous.pageviews),
        visitors_change_pct: percentChange(totals.visitors, previous.visitors),
        hits: totals.hits,
        bandwidth: totals.bandwidth,
        bot_hits: totals.bot_hits,
      },
      daily: fillDays(dailyRows, safeDays, to),
      top_pages: topPages,
      sources,
      devices,
      sites,
      statuses,
      hourly,
      entry_pages: entryPages,
      access_logs: ingestion,
      privacy: 'Unique visitors are counted with a one-way server hash. Raw IP addresses are not stored.',
      verified: ingestion.every(item => item.ok !== false),
      generated_at: now().toISOString(),
    };
  }

  return { record, report, ingestAccessLog };
}

function addColumn(db, table, name, declaration) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}

function parseReferrer(value) {
  if (!value) return null;
  try { return new URL(value).hostname.replace(/^www\./, '').slice(0, 255) || null; }
  catch { return null; }
}

function classifyDevice(ua = '') {
  const text = String(ua).toLowerCase();
  if (isBot(text)) return 'Bot';
  if (/ipad|tablet|kindle/.test(text)) return 'Tablet';
  if (/mobile|iphone|android/.test(text)) return 'Mobile';
  if (text) return 'Desktop';
  return 'Other';
}

function isBot(ua = '') {
  return /bot|spider|crawler|slurp|bingpreview|headless|facebookexternalhit|monitor|uptime/i.test(String(ua));
}

function isPageView(method, requestPath) {
  if (!['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase())) return false;
  const pathname = String(requestPath || '/').split('?')[0];
  return !/\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|mp4|webm|mp3|wav|pdf|zip|xml|txt)$/i.test(pathname);
}

function parseCombinedLogLine(line) {
  const match = String(line).match(/^(\S+) \S+ \S+ \[([^\]]+)] "(\S+) ([^" ]+)(?: HTTP\/[^" ]+)?" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"/);
  if (!match) return null;
  const ts = parseLogDate(match[2]);
  if (!ts) return null;
  return { ip: match[1], ts, method: match[3], path: match[4], statusCode: Number(match[5]), bytesSent: match[6] === '-' ? 0 : Number(match[6]), referrer: match[7] === '-' ? '' : match[7], userAgent: match[8] };
}

function parseLogDate(value) {
  const match = String(value).match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!match) return null;
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[2]);
  if (month < 0) return null;
  const local = Date.UTC(+match[3], month, +match[1], +match[4], +match[5], +match[6]);
  const offset = (+match[8] * 60 + +match[9]) * 60000 * (match[7] === '+' ? 1 : -1);
  return new Date(local - offset).toISOString();
}

function percentChange(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round((current - previous) / previous * 1000) / 10;
}

function fillDays(rows, count, end) {
  const byDay = new Map(rows.map(r => [r.day, r]));
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
    out.push(byDay.get(date) || { day: date, pageviews: 0, visitors: 0 });
  }
  return out;
}

module.exports = { createStatisticsService, parseCombinedLogLine, parseReferrer, classifyDevice, isBot, isPageView, fillDays };
