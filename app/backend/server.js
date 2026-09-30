/**
 * JotPanel backend — server.js (hardened, multi-tenant)
 * npm install express better-sqlite3 bcryptjs jsonwebtoken multer cors
 *             helmet express-rate-limit express-validator
 */

'use strict';

const express      = require('express');
const Database     = require('better-sqlite3');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const multer       = require('multer');
const { readArchiveFile } = require('./control/archiveFormat');
const { parseCpanelArchive } = require('./control/ops/cpanelArchive');
const { planFromCpanel } = require('./control/ops/cpanelPlan');
const { migrationPlan } = require('./control/ops/catalogue');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const http         = require('http');
const { createProvisioningService } = require('./provisioning');
const { createMockProvisioningAdapter } = require('./provisioning/mockAdapter');
const { createNativeProvisioningAdapter } = require('./provisioning/nativeAdapter');
const { detectDemoAction } = require('./provisioning/demoBridge');
const assistantProposals = require('./control/assistantProposals');
const echoProposals = require('./control/echoProposals');
const opsCatalogue = require('./control/ops/catalogue');
const { buildPanelEchoPrompt } = require('./control/echoPanelPrompt');
const { createActionStore } = require('./control/actionStore');
const { createProjectLedger } = require('./control/projectLedger');
const { createResidentGateway, createUnderstanding, candidatesFor, interpret: interpretRequest, ROLE_ROUTES, TASK_ROLE } = require('./control/residentGateway');
const { prepareOutbound, assertClean, hostedBody, scrubSecrets } = require('./control/egressGuard');
const supervisor = require('./control/supervisor');
const { runWithFailover } = require('./control/failover');
const { createJobRunner } = require('./control/jobRunner');
const { createRoutingFit } = require('./control/routingFit');
const { createConversationGuard } = require('./control/residentConversation');
const { createPortabilityService } = require('./control/portability');
const { createUsageService } = require('./control/usage');
const { createScheduledJobsService } = require('./control/scheduledJobs');
const { createLicenseClient } = require('./control/licenseClient');
const { createLocalEngineSecurity } = require('./control/localEngineSecurity');
const { createByogService, looksLikeDeviceToken } = require('./control/byog');
const { siteCertificateHealth } = require('./control/certificates');
const { createStatisticsService } = require('./control/statistics');
const { createWebmailClient } = require('./control/webmailClient');
const { translate: translateMessage } = require('./control/messages');
const { createServerOpsService } = require('./control/serverOps');
const { createOwnershipService, HIERARCHY: ROLE_RANK, TOP_TWO: OWNERSHIP_TOP_TWO } = require('./control/ownership');
const { createApiKeyService, looksLikeApiKey } = require('./control/apiKeys');
const { redact: redactSecrets, holdsSecret, isSecretName } = require('./control/secrets');
const { createProviderKeyService } = require('./control/providerKeys');
const { mountKeyVaultRoutes } = require('./control/keyVaultRoutes');
const { createTwoFactorService } = require('./control/twoFactor');
const { createPasskeyService } = require('./control/passkeys');
const { createAccountRecoveryService } = require('./control/accountRecovery');
const { createRecoveryCeremony } = require('./control/recoveryCeremony');
const { isLocalRequest, refusalReason: notLocalBecause } = require('./control/localRequest');
const storageRoots = require('./control/storageRoots');
const workspaceStorage = require('./control/workspaceStorage');
const workspaceFiles = require('./control/workspaceFiles');
const { panelDatabasePath } = require('./control/panelSettings');
const { createEntitlementsBackend } = require('./control/ops/entitlementsBackend');
const { createAccountsBackend } = require('./control/ops/accountsBackend');
const { siteOwnershipByIdentity, siteStorageBytes, databaseOwnershipByIdentity, mailboxCountsByDomain, backupCountsByDomain } = require('./control/tenantMetrics');
const { createEntitlementsService } = require('./control/entitlements');
const { createOpsEngine } = require('./control/ops/engine');
const { createIntegrationsBackend } = require('./control/ops/integrationsBackend');
const { createHostBackend, siteAccessLogPaths } = require('./control/ops/hostBackend');
const { createNativeStackBackend } = require('./control/ops/nativeStackBackend');
const { createBackupHealthStore, createBackupHealthBackend } = require('./control/backupHealth');
const QRCodeSvg    = require('qrcode-svg');

// ── Config ────────────────────────────────────────────────────────
const PORT        = process.env.PORT       || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET not set'); })();
const ADMIN_KEY   = process.env.ADMIN_KEY  || (() => { throw new Error('ADMIN_KEY not set'); })();
// Field-encryption secret. Defaults to JWT_SECRET so existing rows keep decrypting;
// Set JOTPANEL_ENCRYPT_SECRET on a FRESH install only. ARCA_ENCRYPT_SECRET is
// the permanent legacy read name; changing the value orphans encrypted rows.
const ENCRYPT_SECRET = (process.env.JOTPANEL_ENCRYPT_SECRET ?? process.env.ARCA_ENCRYPT_SECRET) || JWT_SECRET;

// Constant-time admin-key check (a plain !== leaks length/prefix timing)
function isAdminKey(k) {
  if (typeof k !== 'string' || !k) return false;
  const a = Buffer.from(k), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const DOMAIN      = process.env.DOMAIN     || 'localhost';
// The language this machine answers in when the request expresses no preference
// — a hosting company in Brazil ships a Portuguese box. A person's own choice
// still wins over it, which is the whole reason there are two settings.
const DOMAIN_LANGUAGE = ((process.env.JOTPANEL_LANGUAGE ?? process.env.ARCA_LANGUAGE) || '').slice(0, 2).toLowerCase();
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const DATA_DIR    = (process.env.JOTPANEL_DATA_DIR ?? process.env.ARCA_DATA_DIR) || path.join(__dirname, 'data');
const MAX_UPLOAD  = parseInt(process.env.MAX_UPLOAD_MB || '100') * 1024 * 1024;

// ── Bootstrap ─────────────────────────────────────────────────────
[{ name: 'uploads', target: UPLOADS_DIR }, { name: 'data', target: DATA_DIR }].forEach(({ target: p }) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// The workspace's private store lives under the uploads tree, and the entire
// three-state model rests on that tree being somewhere the web server does not
// serve. That is true of the default layout and it would stop being true if
// UPLOADS_DIR were ever pointed under the site root, on a box where the disk is
// bigger there or a migration put it there by hand. Nothing would fail: the
// panel would carry on writing private files straight into a document root.
//
// So it is checked against the real paths, and a box that fails it stops. This
// is the one class of misconfiguration where continuing is worse than not
// starting, because what continuing does is publish somebody's private files
// and say nothing about it. The check compares resolved paths in both
// directions, so it cannot fire on a layout that is merely unusual.
try {
  workspaceStorage.assertOutsideDocroots(UPLOADS_DIR, [(process.env.JOTPANEL_OPS_SITE_ROOT ?? process.env.ARCA_OPS_SITE_ROOT) || '/srv/jotpanel-sites']);
} catch (error) {
  console.error(`[storage] refusing to start: ${error.message}`);
  console.error('[storage] set UPLOADS_DIR to a directory no web server serves, then start again.');
  process.exit(1);
}

// ── Database ──────────────────────────────────────────────────────
const PANEL_DB_PATH = panelDatabasePath(DATA_DIR);
const db = new Database(PANEL_DB_PATH);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA secure_delete=ON;

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    plan        TEXT DEFAULT 'starter',
    subdomain   TEXT UNIQUE,
    storage_gb  INTEGER DEFAULT 10,
    created_at  TEXT DEFAULT (datetime('now')),
    suspended   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS files (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    size       INTEGER DEFAULT 0,
    mime       TEXT,
    folder     TEXT DEFAULT 'root',
    disk_path  TEXT,
    added_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS journal (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    title      TEXT,
    body       TEXT,
    locked     INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pub_folders (
    id       TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL,
    name     TEXT NOT NULL,
    parent   TEXT,
    site     TEXT DEFAULT 'default',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pub_files (
    id        TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL,
    name      TEXT NOT NULL,
    size      INTEGER DEFAULT 0,
    mime      TEXT,
    folder    TEXT DEFAULT 'root',
    site      TEXT DEFAULT 'default',
    disk_path TEXT,
    added_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY,
    data    TEXT DEFAULT '{}',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS beneficiaries (
    id       TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL,
    name     TEXT NOT NULL,
    email    TEXT,
    relation TEXT,
    access   TEXT DEFAULT 'view',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS deadmans (
    user_id     TEXT PRIMARY KEY,
    freq        INTEGER DEFAULT 60,
    grace       INTEGER DEFAULT 14,
    last_checkin TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    action     TEXT NOT NULL,
    ip         TEXT,
    details    TEXT,
    ts         TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_files_user    ON files(user_id);
  CREATE INDEX IF NOT EXISTS idx_journal_user  ON journal(user_id);
  CREATE INDEX IF NOT EXISTS idx_pub_files_user ON pub_files(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_log(user_id);
`);

// ── App setup ─────────────────────────────────────────────────────
const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      // No 'unsafe-inline' here. The old comment claimed the inline WebOS
      // needed it, but index.html carries no inline script — the UI loads as a
      // module from /main.jsx (dev) or /assets (build). Allowing inline script
      // was the single biggest hole in this policy, because the session token
      // lives in localStorage and any injected script could read it.
      scriptSrc:   ["'self'"],
      // Style keeps it: index.html has a real inline <style> block, and an
      // injected stylesheet cannot exfiltrate a token the way script can.
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'blob:'],
      // The resident voice arrives as a blob the page plays; without this the
      // desktop falls silent with nothing in the log but a CSP line in the
      // browser.
      mediaSrc:    ["'self'", 'blob:'],
      connectSrc:  ["'self'", 'https://api.anthropic.com', 'https://api.openai.com',
                    'https://api.groq.com', 'https://api.mistral.ai'],
      frameSrc:    ["'self'"],
      objectSrc:   ["'none'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Remove fingerprinting
app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS — locked to your domain only.
//
// The decision and the answer are two separate things here, and conflating them
// is what made a refusal read as a broken panel. Handing the cors middleware an
// Error sends it to Express's error handler, which answers 500, so a policy
// working exactly as intended looked like the server falling over. It is a
// refusal, so it says 403 and says which origin was refused.
function originAllowed(origin) {
  if (!origin) return true; // same-origin, curl, server to server
  // Local dev runs the frontend over http://localhost. Production stays locked
  // to the allowlist below.
  if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  const allowed = [
    `https://${DOMAIN}`,
    `https://app.${DOMAIN}`,
    new RegExp(`https://[a-z0-9-]+\\.${DOMAIN.replace('.', '\\.')}$`),
  ];
  return allowed.some(p => typeof p === 'string' ? p === origin : p.test(origin));
}

app.use((req, res, next) => {
  if (originAllowed(req.headers.origin)) return next();
  // A preflight is answered rather than left to time out, because a browser
  // reporting "no response" hides the reason from whoever has to fix it.
  res.status(403).json({
    error: `The origin ${req.headers.origin} is not allowed to call this panel.`,
    code: 'origin_not_allowed',
  });
});

app.use(cors({ origin: (origin, cb) => cb(null, originAllowed(origin)), credentials: true }));

app.use(express.json({ limit: '6mb' })); // room for photo attachments to Echo (downscaled client-side)

// Every request carries the language its answer should be in. It is attached
// here rather than looked up in each handler, because a message that forgets to
// ask is a message in English, and that failure is invisible until somebody who
// does not read English hits it.
app.use((req, res, next) => { req.t = (english, values) => translateMessage(req, english, values, DOMAIN_LANGUAGE); next(); });
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// A body the panel could not parse is the caller's mistake, not the server
// falling over, and it was answering "Internal error" with a 500. That is the
// same defect as the CORS refusal: a decision about a bad request reported as
// the panel being broken, which sends whoever is debugging it to the wrong
// place entirely. It says what was wrong with the body instead.
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: `The request body is not valid JSON: ${error.message}`, code: 'malformed_json' });
  }
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({ error: req.t('The request body is larger than this panel accepts.'), code: 'body_too_large' });
  }
  return next(error);
});

// ── Rate limiters ─────────────────────────────────────────────────
// Ten *failures* in fifteen minutes, not ten requests. Counting successes as
// well locks out the person who is getting it right: somebody signing in on a
// phone and a laptop, or a small office behind one address, reaches ten
// perfectly good sign-ins in an afternoon and is then told to wait. A brute
// force is made of failures, so failures are what this counts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts — wait 15 minutes' },
  standardHeaders: true, legacyHeaders: false,
});

// The two-factor management routes sit behind a valid session already, so the
// thing being guarded there is a code being guessed rather than a door being
// tried. Kept separate so setting 2FA up does not spend the sign-in budget.
const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts — wait 15 minutes' },
  standardHeaders: true, legacyHeaders: false,
});

// One bucket per signed-in person, and one per address for everybody else.
//
// This used to be 120 requests a minute counted per IP across the whole of
// /api/, which meant every signed-in user behind one address shared it. An
// office of five people on one connection shared 120 requests a minute between
// them, and a panel screen makes six to eight readings as it opens, so the
// fifteenth screen load in a minute was refused with "Rate limit exceeded" for
// everybody in the building. Measured on 2026-08-28 by
// `scripts/verify-concurrency.js`: at ten concurrent sessions from one address
// 63 per cent of requests were refused, while the machine itself was still
// answering and nowhere near its own limit. That is a defence eating customers.
//
// So the key is the account when there is a valid session, and the address when
// there is not. An anonymous caller is bounded exactly as before. A signed-in
// one gets a budget of their own, generous for a person with several tabs open
// and still small enough to bound a runaway script. Many sessions of one
// account share one bucket, which is the point: the limit is per person.
const identityKey = req => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const claim = jwt.verify(header.slice(7), JWT_SECRET);
      if (claim && !claim.purpose && claim.id) return `user:${claim.id}`;
    } catch { /* not a session, so it falls through to the address */ }
  }
  return `ip:${req.ip}`;
};

// Both budgets are settings, because the right number depends on the box and on
// who is on it, and an operator running a busy machine should not have to edit
// the source to change them. The defaults are what ships.
const API_LIMIT_USER = Number((process.env.JOTPANEL_API_RATE_LIMIT ?? process.env.ARCA_API_RATE_LIMIT) || 300);
const API_LIMIT_ANON = Number((process.env.JOTPANEL_API_RATE_LIMIT_ANON ?? process.env.ARCA_API_RATE_LIMIT_ANON) || 120);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: req => (identityKey(req).startsWith('user:') ? API_LIMIT_USER : API_LIMIT_ANON),
  keyGenerator: identityKey,
  message: { error: 'Rate limit exceeded' },
  standardHeaders: true, legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { error: 'Upload rate limit exceeded' },
});

app.use('/api/login',    authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/',         apiLimiter);

// ── Remote deploy leg (FTP/SFTP) — OFF by default ─────────────────
// Every /api/deploy/* route opens an outbound connection to a host, port and
// credential the caller supplies. On a public box with open sign-up that is an
// SSRF and port-scanning primitive run from our own IP, it puts the server's
// address reputation at risk, and it makes us the custodian of other people's
// server passwords. So it is closed unless a deployment opts in.
//
// Set JOTPANEL_DEPLOY_PUSH=1 to enable: on a self-host or trusted-tenant install
// where the operator owns the targets, and when demonstrating the
// build → Save to site → deploy-queue → push chain on a booked call.
const DEPLOY_PUSH_ENABLED = (process.env.JOTPANEL_DEPLOY_PUSH ?? process.env.ARCA_DEPLOY_PUSH) === '1';
app.use('/api/deploy', (req, res, next) => {
  if (DEPLOY_PUSH_ENABLED) return next();
  return res.status(403).json({ error: req.t('Remote deploy is disabled on this deployment.') });
});

// ── Helpers ───────────────────────────────────────────────────────
const uid = () => crypto.randomBytes(8).toString('hex');

// `req` is optional. Some things worth recording happen with nobody asking:
// a migration at boot, a scheduled job, a reaper. This used to read
// `req.headers` before the try block, so calling it without a request threw
// out of whatever was being recorded rather than recording it, which makes the
// audit trail hardest to write exactly where there is no user to blame.
function audit(userId, action, req, details = '') {
  const headers = (req && req.headers) || {};
  const ip = headers['x-real-ip'] || headers['x-forwarded-for'] || (req && req.ip) || 'this machine';
  try {
    db.prepare('INSERT INTO audit_log (user_id,action,ip,details) VALUES (?,?,?,?)')
      .run(userId || null, action, ip, details);
  } catch {}
}

// ── Auth middleware ───────────────────────────────────────────────
// Where a machine credential is allowed to reach.
//
// Default deny, by path, and a list rather than a rule: a key is accepted only
// on the surfaces that have been looked at and found to be scope-checked. Every
// other route in this file was written for a signed-in person and refuses a key
// even if the key's own scopes would have allowed the capability, because "the
// scope list did not mention it" is not the same sentence as "this route was
// reviewed for machines".
const KEY_ROUTES = [
  /^\/api\/panel\/server\/(capabilities|read|propose)\b/,
  /^\/api\/control\/actions\b/,
  /^\/api\/organizations\/[^/]+\/(entitlements|usage)\b/,
  /^\/api\/provisioning\b/,
  /^\/api\/me$/,
];

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: req.t('No token') });
  const presented = h.slice(7);

  // A machine credential. It carries the identity of the person who made it and
  // can never do more than they could; the scopes on it only narrow. Checked
  // before the JWT path because the two token shapes are told apart by their
  // own prefix rather than by trying one and falling through.
  if (looksLikeApiKey(presented)) {
    const key = apiKeys.verify(presented);
    if (!key) return res.status(401).json({ error: req.t('That API key is not valid, or it has been revoked.') });
    if (!KEY_ROUTES.some(pattern => pattern.test(req.path))) {
      audit(key.identityId, 'api_key_route_refused', req, `${key.prefix}: ${req.method} ${req.path}`);
      return res.status(403).json({ error: req.t('An API key cannot be used on this part of the panel.') });
    }
    const holder = db.prepare('SELECT id, name, email, suspended FROM users WHERE id=?').get(key.identityId);
    if (!holder || holder.suspended) return res.status(403).json({ error: req.t('Account suspended') });
    req.user = { id: holder.id, name: holder.name, email: holder.email };
    req.apiKey = key;
    return next();
  }

  try {
    const claim = jwt.verify(presented, JWT_SECRET);
    // A token that carries a purpose is a ticket for one step of something,
    // not a session. The two-factor challenge is signed with the same secret
    // because it has to be verified by this same process, and without this
    // line it would be accepted here as a working login: the password step
    // would hand back something that skips the second factor entirely, which
    // is the whole feature undone. Live testing found exactly that, on a
    // /api/me call that answered 200 with the challenge as its bearer token.
    if (claim.purpose) return res.status(401).json({ error: req.t('That is not a sign-in token') });
    req.user = claim;
    // Check not suspended
    const u = db.prepare('SELECT suspended FROM users WHERE id=?').get(req.user.id);
    if (!u || u.suspended) {
      return res.status(403).json({ error: req.t('Account suspended') });
    }
    // And they have an organization, whatever created them. This never decides
    // which identity is the operator: on a box with no memberships at all it
    // does nothing, because that question is answered at startup in creation
    // order and not by whoever signs in first.
    try { ownership.ensureMembershipForExisting(req.user.id); } catch { /* a read that fails must not refuse a sign-in */ }
    next();
  } catch {
    res.status(401).json({ error: req.t('Invalid token') });
  }
}

// The bootstrap surface's gate. Two locks, and the order matters for what gets
// written down: a request that never came from this machine is refused before
// the key is looked at, so a scan cannot use the difference between "wrong key"
// and "right key, wrong place" to learn that it guessed right.
//
// This gate is the second defence rather than the first. The routes behind it
// are mounted on their own express app listening on 127.0.0.1 and are not part
// of the app nginx proxies or the recovery port serves, so nothing off this
// machine reaches them to be refused. Both are kept because they fail
// differently: the listener survives somebody adding a route to the wrong app,
// and this survives somebody pointing a proxy at the bootstrap port.
function adminAuth(req, res, next) {
  if (!isLocalRequest(req)) {
    audit(null, 'bootstrap_auth_refused', req, `${req.method} ${req.originalUrl}: ${notLocalBecause(req)}`);
    return res.status(403).json({ error: req.t('This is administered on the machine itself, not over the network') });
  }
  if (!isAdminKey(req.headers['x-admin-key'])) {
    audit(null, 'admin_auth_fail', req);
    return res.status(403).json({ error: req.t('Forbidden') });
  }
  next();
}

// ── Who the operator is ───────────────────────────────────────────
//
// A shared key is a password, not an identity. Everything it protects is
// protected equally by anybody holding it, it cannot be revoked for one person,
// and the record cannot say who used it: `admin_auth_fail` is the only thing
// the audit log can write, because there is nobody to name.
//
// The panel already knows who the operator is. `ownership.js` ranks every
// identity, and server-scope operations have been refused to everyone below the
// top two since the authorization work landed. This is the same answer, applied
// to the console, so the hoster's own tenant list is reached by signing in
// rather than by pasting a key into a browser's local storage.
//
// The key is kept where a caller genuinely has no identity: `/admin/ops` and
// `/admin/ai-health` are polled by monitoring, and a probe cannot sign in.
function isOperatorIdentity(identityId) {
  try {
    const membership = ownership.getMembership(identityId);
    return !!membership && membership.rank >= OWNERSHIP_TOP_TWO;
  } catch { return false; }
}

// Signed in, and the account that runs this box.
function operatorOnly(req, res, next) {
  auth(req, res, () => {
    if (!isOperatorIdentity(req.user.id)) {
      audit(req.user.id, 'operator_surface_refused', req, req.originalUrl);
      return res.status(403).json({ error: req.t('That is the account that runs this box, and this one is not it') });
    }
    next();
  });
}

// For the two machine-readable routes: an operator signing in, or a monitoring
// probe with the key. Tried in that order, so a real identity is preferred and
// recorded wherever there is one.
function operatorOrKey(req, res, next) {
  if (isAdminKey(req.headers['x-admin-key'])) return next();
  return operatorOnly(req, res, next);
}

// Whether the caller happens to be the operator, asked without turning the
// question into a requirement. Used where a route already answers everybody
// and only the amount of detail changes, so an operator is not made to paste a
// shared key into a browser to read their own machine's settings.
function operatorRequest(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const claim = jwt.verify(header.slice(7), JWT_SECRET);
    if (!claim || claim.purpose) return null;
    const id = claim.id || claim.sub;
    if (!id || !isOperatorIdentity(id)) return null;
    // A suspended account is refused everywhere else, so it is refused here.
    const holder = db.prepare('SELECT suspended FROM users WHERE id=?').get(id);
    return holder && !holder.suspended ? id : null;
  } catch { return null; }
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

// ── Multer (file uploads) ─────────────────────────────────────────
const ALLOWED_MIME = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/svg+xml',
  'application/pdf','text/plain','text/html','text/css','application/javascript',
  'application/json','application/zip','application/x-zip-compressed','application/gzip','application/x-gzip','application/x-tar','audio/mpeg','audio/wav','audio/ogg',
  'video/mp4','video/webm','application/octet-stream',
]);

// Private by default. Every upload route that does not say otherwise gets the
// private directory, because the failure that matters is a file becoming public
// by accident and never the other way round. `publishedStorage` below is the
// deliberate exception and it is used by exactly one route.
// A failed upload must fail the upload, not the panel.
//
// multer calls this outside any route's try/catch, so anything thrown here is
// an uncaught exception and the process goes down. On 2026-08-29 a regression
// box hit EACCES making the account's private directory and the panel restarted
// four times, taking every other signed-in person with it each time. One
// customer's upload could do that to everybody.
//
// The permission fault itself is fixed in hostBackend's rootFor, and this stays
// because the next thing that goes wrong on that path should also be one bad
// request rather than an outage: a full disk, a read-only mount, a quota.
const storage = multer.diskStorage({
  destination(req, file, cb) {
    try { cb(null, storageRoots.ensureRoot(UPLOADS_DIR, req.user.id, storageRoots.PRIVATE)); }
    catch (error) { cb(error); }
  },
  filename(req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    cb(null, `${Date.now()}_${uid().slice(0,6)}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD, files: 20 },
  fileFilter(req, file, cb) {
    cb(null, ALLOWED_MIME.has(file.mimetype));
  }
});

// The one storage that writes where the internet can read. Used by
// `POST /api/pub/files` and nowhere else, and named so that a future route
// reaching for `upload` gets the private directory by default rather than by
// remembering to.
const publishedStorage = multer.diskStorage({
  destination(req, file, cb) {
    try { cb(null, storageRoots.ensureRoot(UPLOADS_DIR, req.user.id, storageRoots.PUBLISHED)); }
    catch (error) { cb(error); }
  },
  filename(req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    cb(null, `${Date.now()}_${uid().slice(0,6)}_${safe}`);
  }
});

const publishedUpload = multer({
  storage: publishedStorage,
  limits: { fileSize: MAX_UPLOAD, files: 20 },
  fileFilter(req, file, cb) {
    cb(null, ALLOWED_MIME.has(file.mimetype));
  }
});

// ── Storage quota check ───────────────────────────────────────────
function checkQuota(req, res, next) {
  const u  = db.prepare('SELECT storage_gb FROM users WHERE id=?').get(req.user.id);
  const gb = u?.storage_gb || 10;
  const used = db.prepare('SELECT COALESCE(SUM(size),0) as total FROM files WHERE user_id=?').get(req.user.id);
  if (used.total >= gb * 1024 * 1024 * 1024) {
    return res.status(413).json({ error: `Storage quota exceeded (${gb}GB)` });
  }
  next();
}

// ── Serve frontend ────────────────────────────────────────────────
// One build, two shells. A panel install serves the standalone control panel
// at the root: no desktop, no windows, no assistant. A full Arca install
// serves the desktop. Both are the same screens underneath, which is what
// makes the upgrade a change of shell rather than a migration.
const SHELL = (process.env.JOTPANEL_SHELL ?? process.env.ARCA_SHELL) === 'panel' ? 'panel' : 'desktop';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRODUCT_NAME = SHELL === 'desktop' ? 'JotNotes Navigator' : 'JotPanel';
if (SHELL === 'panel') {
  app.get('/', (req, res, next) => {
    const entry = path.join(PUBLIC_DIR, 'panel.html');
    if (!fs.existsSync(entry)) return next();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(entry);
  });
}
// ── Host administration, on its own address ───────────────────────
//
// `/hoster` rather than `/admin`, because `/admin` is already this server's
// machine-readable namespace: `/admin/ops`, `/admin/tenants` and `/admin/api/*`
// all answer JSON there, and hanging a page off the same prefix means every
// future deep link in the surface is one rename away from shadowing an API
// route. Two namespaces that look alike is how that mistake gets made twice.
//
// Serving the page is not access. Nothing here asks who the caller is, and it
// must not: this hands back a bundle of HTML and JavaScript that then goes and
// asks the server who it is talking to, and every reading behind it is refused
// on its own by `operatorOnly` or by the ownership ledger. Gating the file
// would only hide the door, and hiding a door is not a lock.
app.get(['/hoster', '/hoster/*'], (req, res, next) => {
  const entry = path.join(PUBLIC_DIR, 'hoster.html');
  if (!fs.existsSync(entry)) return next();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(entry);
});

app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: '1h',
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// ── WHO MAY OPEN AN ACCOUNT ───────────────────────────────────────
//
// Whether a stranger may create an account on this machine is the hosting
// company's decision, and until now it was nobody's: `/api/register` answered
// the whole internet with no setting anywhere to close it. On a hosting
// company's box that is a public sign-up form on the panel their customers log
// into.
//
// Two modes, and the default is the safe one.
//
//   closed        Accounts arrive through the hoster: `account.create` in the
//                 catalogue, a reseller taking a customer on, or a billing
//                 integration holding a scoped API key. This is the default,
//                 including on every box that upgrades into this code without
//                 anybody setting anything.
//   public_paid   The hoster has deliberately opened sign-up. A visitor may
//                 create an identity and go on into a paid flow. It gets them
//                 an identity and nothing else: no package, so every
//                 entitlement reads zero, which is the engine's own answer for
//                 an organization nobody has provisioned rather than a rule
//                 written twice.
//
// There is deliberately no free-hosting mode. Granting resources is what a
// package does, and packages are assigned by whoever provides for the account.
//
// This is asked by three routes, not one. `/api/register` is the obvious door;
// `/api/auth/magic` created an account for any address that asked for a
// sign-in link, and `/api/auth/demo` minted a whole tenant to anybody who
// posted to it. Closing one of three would have been theatre.
const REGISTRATION_MODES = new Set(['closed', 'public_paid']);

function registrationMode() {
  try {
    const row = db.prepare("SELECT data FROM routing_table WHERE id=2").get();
    const cfg = row ? JSON.parse(row.data) : {};
    const mode = cfg && typeof cfg.registrationMode === 'string' ? cfg.registrationMode : 'closed';
    return REGISTRATION_MODES.has(mode) ? mode : 'closed';
  } catch {
    // A settings row that cannot be read is not permission to open the door.
    return 'closed';
  }
}

// Every public account-creation path asks this, and a refusal is recorded with
// which door it came to, because "somebody tried to sign up while sign-up was
// closed" is worth seeing on a box that is being scanned.
function publicSignupAllowed(req, door) {
  if (registrationMode() === 'public_paid') return true;
  audit(null, 'public_signup_refused', req, `${door}: registration is closed on this server`);
  return false;
}

// ── AUTH ──────────────────────────────────────────────────────────
app.post('/api/register',
  [
    body('name').trim().isLength({ min:2, max:100 }).withMessage('Name 2–100 chars'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min:8 }).withMessage('Password min 8 chars'),
  ],
  validate,
  (req, res) => {
    if (!publicSignupAllowed(req, 'POST /api/register')) {
      return res.status(403).json({
        error: req.t('This server does not take public sign-ups. Your hosting provider creates the account.'),
      });
    }
    const { name, email, password } = req.body;
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email))
      return res.status(409).json({ error: req.t('Email already registered') });

    const id   = uid();
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT INTO users (id,name,email,password) VALUES (?,?,?,?)').run(id, name, email, hash);
    // An organization of their own, now rather than at the next restart. The
    // backfill that used to be the only thing writing memberships runs once, at
    // startup, so anybody who signed up after it had no organization at all:
    // nothing they made could be claimed to them and no reseller could take
    // them on as a customer, because there was nothing to take on.
    ownership.ensureMembership(id);
    usageService.recordLifecycle(id, 'created', 'password registration');
    db.prepare('INSERT INTO pub_folders (id,user_id,name,parent,site) VALUES (?,?,?,?,?)').run('root_'+id, id, 'root', null, 'default');
    db.prepare('INSERT INTO settings (user_id,data) VALUES (?,?)').run(id, '{}');

    const token = jwt.sign({ id, name, email }, JWT_SECRET, { expiresIn: '30d' });
    // An identity and nothing else. No package is assigned here on purpose, so
    // `effectiveEntitlement` answers `missing` and every limit reads zero until
    // the hoster's own flow provisions them. Said out loud in the record
    // because "signed up" and "was given hosting" are two events and this is
    // only the first.
    audit(id, 'register', req, 'public sign-up: identity created, no package assigned');
    res.json({ token, user: { id, name, email, plan: 'starter' }, provisioned: false });
  }
);

app.post('/api/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  validate,
  async (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);

    // Constant-time compare to prevent timing attacks
    const hash = user?.password || '$2a$12$invalidhashpadding000000000000000000000000000000000000000';
    // Awaited rather than sync, and this is a concurrency fix rather than a
    // style preference. bcryptjs is pure JavaScript, so `compareSync` holds the
    // event loop for the whole hash: at cost 12 on one core that is well over a
    // second during which this process answers nobody. Measured on the live box
    // on 2026-08-28, in docs/CONCURRENCY_VERIFICATION.md. The async form yields
    // between rounds, so a sign-in still costs the same second of processor and
    // stops being a second in which the panel is deaf. The cost factor is not
    // reduced: making the hash cheaper is the wrong end of this problem.
    // Wrapped, because the sync call used to throw on a hash the library cannot
    // read and Express turned that into a 500. An async handler that rejects
    // instead leaves the request hanging with no answer at all, so a hash that
    // cannot be read is treated as what it is: not a successful sign-in.
    let ok = false;
    try { ok = (await bcrypt.compare(password, hash)) && !!user; } catch { ok = false; }

    if (!ok) {
      audit(null, 'login_fail', req, email);
      return res.status(401).json({ error: req.t('Invalid credentials') });
    }
    if (user.suspended) return res.status(403).json({ error: req.t('Account suspended') });

    // The password was right. If this account has a second factor, that is
    // half the answer and not a session: what comes back is a short-lived
    // ticket that is good for one thing, proving the second factor, and is
    // signed with its own purpose so it cannot be presented anywhere a real
    // session token is accepted.
    if (twoFactor.isEnabled(user.id)) {
      const challenge = jwt.sign({ id: user.id, purpose: 'two_factor' }, JWT_SECRET, { expiresIn: '5m' });
      audit(user.id, 'login_password_ok_awaiting_code', req);
      return res.json({ two_factor_required: true, challenge });
    }

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    audit(user.id, 'login', req);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan }, two_factor: twoFactorPosture(user.id) });
  }
);

// The second half of a sign-in. The ticket says which account, the code or
// recovery code says it is really them, and only then is a session issued.
// Rate limited the same as the password step, because six digits with no
// limiter is a number an attacker can simply count to.
app.post('/api/login/2fa', authLimiter, (req, res) => {
  let claim;
  try { claim = jwt.verify(String(req.body?.challenge || ''), JWT_SECRET); } catch { claim = null; }
  if (!claim || claim.purpose !== 'two_factor' || !claim.id) {
    return res.status(401).json({ error: req.t('That sign-in has expired. Enter your password again.') });
  }
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(claim.id);
  if (!user) return res.status(401).json({ error: req.t('That sign-in has expired. Enter your password again.') });
  if (user.suspended) return res.status(403).json({ error: req.t('Account suspended') });

  const supplied = String(req.body?.code || '').trim();
  const isRecovery = !/^\d{6}$/.test(supplied.replace(/\s/g, ''));
  const checked = isRecovery ? twoFactor.useRecoveryCode(user.id, supplied) : twoFactor.checkCode(user.id, supplied);
  if (!checked.ok) {
    audit(user.id, isRecovery ? 'login_recovery_code_failed' : 'login_code_failed', req, checked.reason);
    return res.status(401).json({ error: checked.reason });
  }

  const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  audit(user.id, isRecovery ? 'login_with_recovery_code' : 'login', req,
    isRecovery ? `${checked.recovery_codes_left} recovery codes left` : 'code accepted');
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, plan: user.plan },
    two_factor: { ...twoFactorPosture(user.id), used_recovery_code: isRecovery },
  });
});

// What the panel needs to know about this account's second factor without
// asking a second time: whether it is on, and whether this account is one the
// product expects to have it. An account that can change the machine is one
// of the top two roles, so that is what "expected" means here. It is reported
// rather than enforced at the door, deliberately: switching enforcement on
// before somebody has enrolled locks the owner out of their own server, and
// the honest place for that decision is the hoster, not this line of code.
function twoFactorPosture(userId) {
  const membership = ownership.getMembership(userId);
  const rank = membership ? membership.rank : 0;
  return { ...twoFactor.status(userId), expected: rank >= ROLE_RANK.reseller, role: membership?.role || null };
}

// ── TWO-FACTOR AUTHENTICATION ─────────────────────────────────────
// ── PASSKEYS ──────────────────────────────────────────────────────
//
// Registration needs a session, which is the migration path: everybody on this
// box today has a password, so they sign in the way they always have and add a
// passkey from inside. Nothing removes the password, and nothing is switched to
// passkey-first, because saying "passkey-first" while a password still opens
// every account would be a claim rather than a fact.
const passkeyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts' } });

app.get('/api/passkeys', auth, (req, res) => {
  res.json({
    available: passkeys.available(),
    unavailable_reason: passkeys.available() ? null : passkeys.whyUnavailable(),
    credentials: passkeys.listFor(req.user.id),
    // What else opens this account, so the screen can say whether removing the
    // last passkey is safe rather than finding out when it is refused.
    has_password: !!db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id)?.password,
  });
});

app.post('/api/passkeys/register/options', auth, passkeyLimiter, async (req, res) => {
  try {
    const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(req.user.id);
    res.json(await passkeys.registrationOptions({ userId: user.id, userName: user.email }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/passkeys/register/verify', auth, passkeyLimiter, async (req, res) => {
  try {
    const stored = await passkeys.verifyRegistration({
      userId: req.user.id, response: req.body?.response, name: req.body?.name,
    });
    audit(req.user.id, 'passkey_registered', req, `${stored.name}`);
    res.json({ ok: true, passkey: { id: stored.id, name: stored.name } });
  } catch (error) {
    audit(req.user.id, 'passkey_registration_failed', req, error.message);
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/passkeys/:id', auth, (req, res) => {
  const holder = db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
  const outcome = passkeys.remove({
    userId: req.user.id, id: req.params.id, accountHasOtherLogin: !!holder?.password,
  });
  if (!outcome.ok) return res.status(400).json({ error: outcome.reason });
  audit(req.user.id, 'passkey_removed', req, outcome.name);
  res.json({ ok: true });
});

app.patch('/api/passkeys/:id', auth, (req, res) => {
  const outcome = passkeys.rename({ userId: req.user.id, id: req.params.id, name: req.body?.name });
  if (!outcome.ok) return res.status(400).json({ error: outcome.reason });
  audit(req.user.id, 'passkey_renamed', req, outcome.name);
  res.json({ ok: true, name: outcome.name });
});

// Signing in with one. No email is asked for and none is accepted: the
// authenticator says which credential it used and the account is looked up from
// that, so this route cannot be used to ask whether an address banks here.
app.post('/api/auth/passkey/options', authLimiter, async (req, res) => {
  try { res.json(await passkeys.authenticationOptions()); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/auth/passkey/verify', authLimiter, async (req, res) => {
  try {
    const result = await passkeys.verifyAuthentication({ response: req.body?.response });
    const user = db.prepare('SELECT id,name,email,plan,suspended FROM users WHERE id=?').get(result.userId);
    if (!user) return res.status(401).json({ error: req.t('That passkey is not registered here') });
    // A suspended account is refused here exactly as it is at the password
    // door. A second way in must not be a way around suspension.
    if (user.suspended) {
      audit(user.id, 'passkey_login_refused', req, 'account suspended');
      return res.status(403).json({ error: req.t('Account suspended') });
    }
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    audit(user.id, 'passkey_login', req, result.name);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } });
  } catch (error) {
    audit(null, 'passkey_login_failed', req, error.message);
    res.status(401).json({ error: error.message });
  }
});

// ── ACCOUNT RECOVERY CODES ────────────────────────────────────────
//
// The set you keep in case everything else is gone. Distinct from the
// two-factor codes, which answer the phone rather than the account: see the
// comment at the top of `control/accountRecovery.js` for why having both is
// not duplication.
//
// Generating them is offered to a signed-in account and nothing else. The
// ceremony that *spends* one, to recover an account nobody can sign into, is
// deliberately not built yet: it belongs with hoster-assisted recovery, and
// half a recovery path is worse than none because it looks like a way back in.
app.get('/api/recovery-codes', auth, (req, res) => res.json(accountRecovery.status(req.user.id)));

app.post('/api/recovery-codes', auth, twoFactorLimiter, (req, res) => {
  const holder = db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
  // Re-authentication before minting the thing that can replace every other
  // credential. An account with no password reaches this having signed in with
  // a passkey, which is itself a fresh proof, so there is nothing to re-ask.
  if (holder?.password) {
    if (!req.body?.password || !bcrypt.compareSync(req.body.password, holder.password)) {
      audit(req.user.id, 'recovery_codes_refused', req, 'password not confirmed');
      return res.status(403).json({ error: req.t('Confirm your password to generate recovery codes') });
    }
  }
  const existing = accountRecovery.status(req.user.id);
  const issued = accountRecovery.generate(req.user.id);
  audit(req.user.id, existing.generated ? 'recovery_codes_regenerated' : 'recovery_codes_generated', req,
    `${issued.count} codes${existing.generated ? `, replacing a set with ${existing.codes_left} unused` : ''}`);
  // Shown once. Named the same way a generated mailbox password is, because it
  // is the same promise: the panel cannot show them again.
  res.json({
    deliver_once: {
      what: 'Account recovery codes',
      codes: issued.codes,
      note: 'Each code works once. Keep them somewhere that is not this machine and not the device you sign in with.',
    },
    count: issued.count,
  });
});

// ── RECOVERY CEREMONY ─────────────────────────────────────────────
//
// Two keys and neither opens alone: the user spends a recovery code, the
// hosting company that provides for that account approves, and what comes back
// is a short ticket good only for enrolling a new passkey. See
// `control/recoveryCeremony.js` for why it is shaped this way.

// Opening one. Rate-limited and deliberately opaque: the same answer whether
// the address exists, whether the code was right, and whether a request was
// actually made, so this cannot be used to find out who banks here.
app.post('/api/recovery/request', authLimiter, (req, res) => {
  try {
    recovery.open({ email: req.body?.email, code: req.body?.code, ip: req.ip });
  } catch (error) {
    audit(null, 'recovery_request_error', req, error.message);
  }
  res.json({ ok: true, message: 'If that account exists and the code was right, your hosting provider has been asked to approve.' });
});

// The queue, narrowed by the ownership engine to the accounts this signed-in
// provider actually provides for.
app.get('/api/recovery/pending', auth, (req, res) => {
  res.json({ requests: recovery.pending(req.user.id) });
});

// Approving. The approver gets confirmation and the ticket for delivery to the
// customer; they never receive a session, a password or the recovery code.
app.post('/api/recovery/:id/approve', auth, (req, res) => {
  const outcome = recovery.approve({ requestId: req.params.id, approverIdentityId: req.user.id });
  if (!outcome.ok) return res.status(403).json({ error: outcome.reason });
  audit(req.user.id, 'recovery_approved_by', req, req.params.id);
  res.json({
    ok: true,
    deliver_once: {
      what: 'Recovery ticket',
      ticket: outcome.ticket,
      note: 'Give this to the account holder. It expires shortly and works once, and it only lets them add a passkey.',
    },
    expires_at: outcome.expires_at,
  });
});

// Spending the ticket: it buys a registration challenge and nothing else. No
// session is issued here, so a stolen ticket cannot be used to read the
// account, only to attempt an enrolment that the next call must complete.
app.post('/api/recovery/enrol/options', authLimiter, async (req, res) => {
  const claim = recovery.redeem({ ticket: req.body?.ticket });
  if (!claim.ok) return res.status(403).json({ error: claim.reason });
  try {
    const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(claim.userId);
    const options = await passkeys.registrationOptions({ userId: user.id, userName: user.email });
    // The ticket is spent, so the challenge itself carries the authority for
    // the one enrolment that follows. It expires in five minutes like any other.
    audit(user.id, 'recovery_enrolment_started', req, claim.requestId);
    res.json({ options, user: { email: user.email } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Completing it. The challenge was issued against this account by the call
// above, and `verifyRegistration` refuses a challenge raised for anybody else,
// so the account is decided by the ticket rather than by anything in this body.
app.post('/api/recovery/enrol/verify', authLimiter, async (req, res) => {
  try {
    const challenge = req.body?.response?.response?.clientDataJSON
      ? JSON.parse(Buffer.from(req.body.response.response.clientDataJSON, 'base64url').toString('utf8')).challenge
      : null;
    const pending = challenge && db.prepare("SELECT user_id FROM webauthn_challenges WHERE challenge=? AND kind='registration'").get(challenge);
    if (!pending) return res.status(403).json({ error: req.t('That enrolment was not started here') });
    const stored = await passkeys.verifyRegistration({
      userId: pending.user_id, response: req.body.response, name: req.body?.name || 'Recovered passkey',
    });
    audit(pending.user_id, 'recovery_completed', req, `new passkey ${stored.name}`);
    res.json({ ok: true, passkey: { id: stored.id, name: stored.name }, sign_in: 'Now sign in with your new passkey.' });
  } catch (error) {
    audit(null, 'recovery_enrolment_failed', req, error.message);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/2fa', auth, (req, res) => res.json(twoFactorPosture(req.user.id)));

// Setting it up. Hands back the secret, the otpauth:// URI and a QR image the
// panel can show without reaching for anything outside this machine. Nothing
// is switched on here: see control/twoFactor.js for why.
app.post('/api/2fa/setup', auth, twoFactorLimiter, (req, res) => {
  try {
    const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(req.user.id);
    const { secret, uri } = twoFactor.beginEnrolment(user.id, user.email);
    audit(user.id, 'two_factor_setup_started', req);
    res.json({ secret, uri, qr_svg: new QRCodeSvg({ content: uri, padding: 2, width: 220, height: 220, ecl: 'M', container: 'svg', join: true }).svg() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Confirming it, which is the moment it becomes real. The recovery codes come
// back once and are hashed on the way in, so there is nothing to show twice.
app.post('/api/2fa/confirm', auth, twoFactorLimiter, (req, res) => {
  try {
    const result = twoFactor.confirmEnrolment(req.user.id, req.body?.code);
    audit(req.user.id, 'two_factor_enabled', req, `${result.recovery_codes.length} recovery codes issued`);
    res.json(result);
  } catch (e) {
    audit(req.user.id, 'two_factor_confirm_failed', req, e.message);
    res.status(400).json({ error: e.message });
  }
});

// Turning it off needs the account password again and a live code or a
// recovery code. Somebody sitting at a session left open has one of those and
// not the other, which is the whole point of the second factor.
app.post('/api/2fa/disable', auth, twoFactorLimiter, (req, res) => {
  const user = db.prepare('SELECT id,password FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body?.password || ''), user?.password || '$2a$12$invalidhashpadding000000000000000000000000000000000000000')) {
    audit(req.user.id, 'two_factor_disable_failed', req, 'password wrong');
    return res.status(401).json({ error: req.t('That password is not right') });
  }
  try {
    const result = twoFactor.disable(req.user.id, req.body?.code);
    audit(req.user.id, 'two_factor_disabled', req);
    res.json(result);
  } catch (e) {
    audit(req.user.id, 'two_factor_disable_failed', req, e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/2fa/recovery-codes', auth, twoFactorLimiter, (req, res) => {
  try {
    const result = twoFactor.regenerateRecoveryCodes(req.user.id, req.body?.code);
    audit(req.user.id, 'two_factor_recovery_codes_replaced', req);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT id,name,email,plan,created_at,storage_gb FROM users WHERE id=?').get(req.user.id);
  // Answered here so a shell can decide what to draw, rather than each surface
  // discovering it by being refused. It is derived from the ownership ledger on
  // every request and is not stored on the account, so it cannot go stale and
  // nothing in a request can claim it.
  res.json({ ...user, is_operator: isOperatorIdentity(req.user.id) });
});

// ── SETTINGS ──────────────────────────────────────────────────────
// ── MAGIC LINK AUTH ──────────────────────────────────────────────────────────
// What is stored is the hash of the link, so the table cannot be read back into
// a working sign-in. The token itself exists only in the URL the person was
// sent, exactly as an issued API key exists only in the copy they were shown.
const magicHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
db.exec(`
  -- The token column holds the SHA-256 of the link, never the link. A row read
  -- out of this table used to be a working sign-in as that person; now it is a
  -- hash that cannot be turned back into a link. Same shape as api_keys.
  CREATE TABLE IF NOT EXISTS magic_tokens (
    token      TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0
  );
`);

const MAGIC_LIMITER = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many requests' } });

// POST /api/auth/magic  — send sign-in link
app.post('/api/auth/magic', MAGIC_LIMITER, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: req.t('Valid email required') });

  // A sign-in link signs you in. It used to create the account first if the
  // address had none, with an empty password column and no organization, which
  // made this a second public registration door that no setting could close and
  // that nobody had described as registration. It is a sign-in route now: an
  // address with no account here gets no account made for it.
  //
  // The answer is deliberately the same either way. Saying "no such account"
  // turns this into a way to ask the panel which of a list of addresses banks
  // here, and a hosting company's customer list is worth having.
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) {
    audit(null, 'magic_requested_unknown', req, email);
    return res.json({ ok: true });
  }

  const token   = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT OR REPLACE INTO magic_tokens (token,email,expires_at,used) VALUES (?,?,?,0)').run(magicHash(token), email, expires);

  const domain   = process.env.DOMAIN || 'localhost:3000';
  // JOTPANEL_PUBLIC_ORIGIN is the deployment's real public URL, and it wins. The
  // `app.<domain>` fallback below only fits installs that happen to follow that
  // subdomain convention; anywhere else it mints links to a host that does not
  // exist, and the failure is invisible until someone clicks one. Same pattern
  // as the PhoneDrop base URL further down.
  const origin   = ((process.env.JOTPANEL_PUBLIC_ORIGIN ?? process.env.ARCA_PUBLIC_ORIGIN) || `https://app.${domain}`).replace(/\/$/, '');
  const magicUrl = `${origin}/?magic=${token}`;

  // This used to answer {ok:true} in every case: with no mail server it logged
  // the link to the console, and when sending threw it caught, logged and said
  // ok anyway. On a freshly installed panel, which configures no SMTP, that
  // meant the only visible way in reported success and sent nothing. A sign-in
  // route that cannot tell you it failed is worse than one that is absent.
  const canSend = !!process.env.SMTP_HOST;
  const development = process.env.NODE_ENV !== 'production';
  if (canSend) {
    try {
      const nm = require('nodemailer');
      const t  = nm.createTransport({ host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || 587), secure: process.env.SMTP_PORT === '465', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
      await t.sendMail({
        from: process.env.SMTP_FROM || `${PRODUCT_NAME} <noreply@${domain}>`, to: email,
        subject: `Your ${PRODUCT_NAME} sign-in link`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px"><div style="font-size:24px;font-weight:800;margin-bottom:28px">${PRODUCT_NAME}</div><p style="font-size:15px;margin:0 0 24px">Click below to sign in. Expires in 15 minutes.</p><a href="${magicUrl}" style="display:inline-block;padding:14px 28px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Sign in to ${PRODUCT_NAME} &rarr;</a></div>`,
      });
    } catch (e) {
      console.error('[magic] email failed:', e.message);
      audit(user.id, 'magic_send_failed', req, email);
      return res.status(502).json({ error: `The sign-in link could not be sent: ${e.message}` });
    }
  } else if (development) {
    // Local development has no mail server and does not need one; the link is
    // returned below and printed here.
    console.log('[magic-link]', magicUrl);
  } else {
    return res.status(503).json({ error: req.t('This server has no mail service configured, so it cannot send a sign-in link. Sign in with your password, or connect a mail service first.') });
  }

  audit(user.id, 'magic_requested', req, email);
  const devLink = development ? { devLink: magicUrl } : {};
  res.json({ ok: true, ...devLink });
});

// What the sign-in screen is allowed to offer, asked before anyone is signed
// in. A password always works, because the installer creates the owner with
// one. A sign-in link only works where the box has been given a mail service,
// so the screen can stop offering recovery it cannot perform. Deliberately
// says whether mail is configured and nothing about what it is.
app.get('/api/auth/options', (req, res) => {
  // `registration` is here so the sign-in screen stops offering a "create an
  // account" link on a server that will refuse it. It reports the setting and
  // nothing about who is on the box.
  // `passkey` says whether this server can offer one at all, which depends on
  // it having a domain rather than an address, and `passkey_enrolled` says
  // whether anybody here has actually registered one. The sign-in screen needs
  // both: offering the button on a box where no passkey exists sends somebody
  // into a browser prompt that can only fail.
  const enrolled = (() => {
    try { return db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials').get().n > 0; }
    catch { return false; }
  })();
  res.json({
    password: true,
    magic_link: !!process.env.SMTP_HOST,
    passkey: passkeys.available(),
    passkey_enrolled: passkeys.available() && enrolled,
    passkey_unavailable_reason: passkeys.available() ? null : passkeys.whyUnavailable(),
    registration: registrationMode(),
    demo: (process.env.JOTPANEL_DEMO_TENANTS ?? process.env.ARCA_DEMO_TENANTS) === 'on',
  });
});

// GET /api/auth/magic?token=xxx  — verify token; a session, or the two-factor
// challenge when the account has a second factor (control/magicSignIn.js).
app.get('/api/auth/magic', require('./control/magicSignIn').createMagicSignIn({ db, magicHash, jwt, JWT_SECRET, twoFactor: { isEnabled: id => twoFactor.isEnabled(id) }, audit }));

// GET /api/auth/magic/status used to hand a session to anyone who named an
// address whose last link had been used. Gone; the link itself signs in.
app.get('/api/auth/magic/status', (req, res) => res.status(410).json({ verified: false }));

// Sweep expired demo tenants. A demo account is a throwaway by definition, so
// it and everything it made are deleted outright rather than archived. Runs on
// demo entry because that is the only time the table grows, which keeps this to
// one cheap query on a path that is already writing.
const DEMO_TTL_HOURS = (() => { const h = parseFloat((process.env.JOTPANEL_DEMO_TTL_HOURS ?? process.env.ARCA_DEMO_TTL_HOURS) || '6'); return isNaN(h) ? 6 : h; })();
const DEMO_USER_TABLES = ['ai_usage', 'audit_log', 'beneficiaries', 'deadmans', 'deploy_credentials',
  'files', 'journal', 'magic_tokens', 'mail_accounts', 'provisioning_accounts', 'pub_files', 'pub_folders',
  'settings', 'site_members', 'sites', 'workspaces', 'account_lifecycle', 'usage_snapshots',
  'control_actions', 'scheduled_jobs', 'scheduled_job_runs', 'web_events'];
function reapDemoTenants() {
  try {
    const stale = db.prepare(
      `SELECT id FROM users WHERE email LIKE 'demo+%@arca.internal'
         AND created_at < datetime('now', ?)`).all(`-${DEMO_TTL_HOURS} hours`);
    for (const { id } of stale) {
      // Provider keys are scoped rather than keyed by user_id, so the table
      // sweep below cannot reach them and they are deleted by scope here.
      db.prepare("DELETE FROM provider_keys WHERE scope_kind='identity' AND scope_id=?").run(id);
      db.prepare("DELETE FROM provider_key_policy WHERE scope_kind='identity' AND scope_id=?").run(id);

      // Their uploads live on disk under the account id, so the row delete
      // alone would leave the files behind for as long as the box lives.
      if (/^[A-Za-z0-9_-]+$/.test(id)) {
        try { fs.rmSync(path.join(UPLOADS_DIR, id), { recursive: true, force: true }); } catch {}
      }
      for (const t of DEMO_USER_TABLES) {
        try { db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(id); } catch {}
      }
      db.prepare('DELETE FROM users WHERE id=?').run(id);
    }
    if (stale.length) console.log(`[demo] reaped ${stale.length} expired demo tenant(s)`);
  } catch (e) { console.error('[demo] reap failed', e.message); }
}

// POST /api/auth/demo — keyless entry for the "Try Arca" concierge link. A
// stranger will not survive type-an-email-and-click-devLink, so this hands
// back a JWT immediately. Capped low (see aiCapUSD below) since it is
// reachable with no credentials.
//
// Every visitor gets their OWN throwaway tenant. This used to be one shared
// account, which meant a file uploaded in one demo was sitting in Files for
// the next stranger who opened the link, and two people demoing at once were
// editing each other's desktop. Isolation is the honest default and it is
// also what makes "upload a photo and watch it land" showable at all. The
// accounts are swept after JOTPANEL_DEMO_TTL_HOURS.
const DEMO_LIMITER = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many requests' } });
app.post('/api/auth/demo', DEMO_LIMITER, (req, res) => {
  // The third door, and the widest: this made a real user row, a provisioning
  // scope and a signed token for anybody who posted to it, with nothing but a
  // rate limit in front. It belongs to the marketing site's "try it" button,
  // not to a hosting company's panel, so it is off unless the box is
  // deliberately running demos. `JOTPANEL_DEMO_TENANTS=on` is its own switch rather
  // than the registration mode, because a hoster who opens paid sign-up has not
  // asked for throwaway tenants as well.
  if ((process.env.JOTPANEL_DEMO_TENANTS ?? process.env.ARCA_DEMO_TENANTS) !== 'on') {
    audit(null, 'demo_entry_refused', req, 'demo tenants are not enabled on this server');
    return res.status(403).json({ error: req.t('This server is not running demo accounts.') });
  }
  reapDemoTenants();
  const email = `demo+${uid()}@arca.internal`;
  // Demo brain is a session-start choice: set JOTPANEL_CONCIERGE_BRAIN=frontier
  // (plus a platform provider key) for talk-the-talk quality, leave it unset
  // for the free Resident. Either way the hard spend cap below is enforced by
  // the normal monthly-cap path and re-pinned on every demo entry so the env
  // var stays the source of truth even for an existing demo tenant.
  const demoCap = (() => { const c = parseFloat((process.env.JOTPANEL_DEMO_CAP_USD ?? process.env.ARCA_DEMO_CAP_USD) || '1'); return isNaN(c) ? 1 : c; })();
  const id = uid();
  // subdomain stays NULL because it carries a UNIQUE constraint and every
  // visitor would otherwise be fighting for the name 'guest'.
  db.prepare('INSERT INTO users (id,name,email,password,plan) VALUES (?,?,?,?,?)').run(id, 'Guest', email, '', 'starter');
  usageService.recordLifecycle(id, 'created', 'demo tenant');
  const user = { id, name: 'Guest', email, plan: 'starter' };
  try {
    db.prepare('INSERT INTO settings (user_id,data) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data')
      .run(user.id, JSON.stringify({ aiCapUSD: demoCap }));
    // Approval cards should read guest.jotnotes.com rather than a hex user id.
    // The scope row is written here explicitly, since the fallback in
    // buildProvisioningAccountContext derives the name from the subdomain and
    // that is deliberately empty on a demo tenant.
    const pd = 'guest.jotnotes.com';
    db.prepare(`INSERT INTO provisioning_accounts (user_id,cpanel_user,primary_domain,domains,allowed_dns_zones)
                VALUES (?,?,?,?,?)`).run(user.id, 'guest', pd, JSON.stringify([pd]), JSON.stringify([pd]));
  } catch (e) { console.error('[demo] tenant setup', e.message); }
  // The token must not outlive the account it names, or a visitor comes back
  // to a valid JWT pointing at a row the reaper has already deleted.
  const jwtToken = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET,
    { expiresIn: Math.max(1, Math.round(DEMO_TTL_HOURS * 3600)) });
  audit(user.id, 'demo_entry', req);
  res.json({ token: jwtToken, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } });
});


// ── AI ROUTING TABLE ──────────────────────────────────────────────
// Stored in DB as a single JSON row. Admin can update via PATCH.
// Frontend fetches on load — all users get updates without a redeploy.

db.exec(`
  CREATE TABLE IF NOT EXISTS routing_table (
    id      INTEGER PRIMARY KEY DEFAULT 1,
    data    TEXT NOT NULL,
    updated TEXT NOT NULL
  );
`);

// GET /api/routing — public, no auth needed (routing table is not sensitive)
app.get('/api/routing', (req, res) => {
  const row = db.prepare('SELECT data FROM routing_table WHERE id=1').get();
  if (!row) return res.json({}); // empty = use client defaults
  try { res.json(JSON.parse(row.data)); } catch { res.json({}); }
});

// PATCH /api/routing — the operator, or somebody already on the machine.
//
// This decides which model answers which kind of request for every account on
// the box. It was the shared key and nothing else, with no record of the change
// and no caller in the product: the panel reads the table and has never written
// it. Both doors are now attributable, one to a person and one to the machine.
app.patch('/api/routing', (req, res) => {
  const operator = operatorRequest(req);
  const local = isLocalRequest(req) && isAdminKey(req.headers['x-admin-key']);
  if (!operator && !local) return res.status(403).json({ error: req.t('Forbidden') });
  const data = req.body;
  if (typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: req.t('Expected JSON object') });
  const json = JSON.stringify(data);
  const now  = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO routing_table (id,data,updated) VALUES (1,?,?)').run(json, now);
  audit(operator, 'routing_table_changed', req, operator ? `${Object.keys(data).length} task route(s)` : `${Object.keys(data).length} task route(s), from this machine`);
  res.json({ ok: true, updated: now });
});

// Settings is a free-form blob, and a free-form blob that is returned whole is
// a place where the next person's secret leaks by default. That is exactly how
// provider keys ended up readable. So nothing whose NAME says secret goes in or
// comes out of here, judged by the one rule in control/secrets.js rather than
// by a list kept up to date by hand. A credential belongs in a store built for
// one, not in a preferences bag.
function withoutSecretFields(value) {
  if (Array.isArray(value)) return value.map(withoutSecretFields);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [name, held] of Object.entries(value)) {
    if (isSecretName(name)) continue;
    out[name] = withoutSecretFields(held);
  }
  return out;
}

app.get('/api/settings', auth, (req, res) => {
  const row = db.prepare('SELECT data FROM settings WHERE user_id=?').get(req.user.id);
  let blob = {};
  try { blob = row ? JSON.parse(row.data) : {}; } catch { blob = {}; }
  res.json(withoutSecretFields(blob));
});

app.put('/api/settings', auth, (req, res) => {
  const clean = withoutSecretFields(req.body || {});
  const refused = holdsSecret(req.body || {});
  db.prepare('INSERT INTO settings (user_id,data) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data').run(req.user.id, JSON.stringify(clean));
  res.json({ ok: true, refused_secret_fields: refused });
});

// ── FILE VAULT ────────────────────────────────────────────────────
// The vault is the files product: My Files, Public, Shared and Trash, and which
// place a file is in is decided by the disk rather than by a column.
//
// `control/workspaceFiles.js` is the model. My Files is the account's private
// root and Public is its published root, both from `storageRoots`, which has
// owned that split since before this product was scoped. Making a file public is
// a move between those two directories, and nothing else.
//
// This has nothing to do with websites. The hosting product is a different thing
// that already exists, and the website builder is a third thing that already
// exists and has a folder per site in it. If a reader finds themselves wanting a
// site picker here, the thing they are looking for is the Builder.
//
// `shared` cannot be reported yet, because a share is a signed link and links
// are the next step. `placeOf` already takes the count of live links, so that
// step wires a number in rather than changing anything here.
function workspacePlaceOf(row, options = {}) {
  return workspaceFiles.placeFor(UPLOADS_DIR, row, options);
}

// The address a public file has, built in one place so the row that links to it
// and the record that mentions it are the same string. A configured base wins,
// because a box behind a proxy knows its own name better than a request header
// does, and the request is the fallback rather than the source.
function publicBase(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function workspaceRow(req, row) {
  const place = workspacePlaceOf(row);
  return {
    id: row.id, name: row.name, size: row.size, mime: row.mime,
    folder: row.folder, added_at: row.added_at,
    place,
    reach: workspaceFiles.reachability(place),
    public_url: place === workspaceFiles.PUBLIC ? workspaceFiles.publicUrlFor(publicBase(req), req.user.id, row) : null,
    deleted_at: row.deleted_at || null,
  };
}

const FILE_COLUMNS = 'id,name,size,mime,folder,added_at,disk_path,deleted_at';

app.get('/api/files', auth, (req, res) => {
  const rows = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE user_id=?`).all(req.user.id)
    .map(row => ({ ...row, user_id: req.user.id }));
  const shown = rows.map(row => workspaceRow(req, row));
  // A place asked for is a filter and never an instruction. The row still says
  // where it actually is, so a screen asking for Public and being handed a file
  // that is not public shows it correctly rather than being told what it wanted
  // to hear.
  const wanted = String(req.query.place || '').trim();
  res.json(wanted ? shown.filter(f => f.place === wanted) : shown);
});

app.post('/api/files', auth, checkQuota, uploadLimiter, upload.array('files'), (req, res) => {
  const folder   = req.body.folder || 'root';
  const inserted = [];
  for (const f of req.files || []) {
    const id = uid();
    db.prepare('INSERT INTO files (id,user_id,name,size,mime,folder,disk_path) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.user.id, f.originalname, f.size, f.mimetype, folder, f.path);
    inserted.push({ id, name: f.originalname, size: f.size, mime: f.mimetype, folder });
  }
  audit(req.user.id, 'upload', req, `${inserted.length} files`);
  res.json(inserted);
});

app.get('/api/files/:id/download', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: req.t('Not found') });
  res.download(row.disk_path, row.name);
});

app.patch('/api/files/:id', auth,
  [body('name').trim().isLength({ min:1, max:255 })], validate,
  (req, res) => {
    db.prepare('UPDATE files SET name=? WHERE id=? AND user_id=?').run(req.body.name, req.params.id, req.user.id);
    res.json({ ok: true });
  }
);

// ── Public, private, Trash ────────────────────────────────────────
//
// Four routes, and between them they are the whole product. Everything here
// refuses before it moves anything, because a check that runs after the bytes
// are somewhere new has described what happened rather than prevented it.

function ownedFile(req) {
  const row = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE id=? AND user_id=?`)
    .get(req.params.id, req.user.id);
  return row ? { ...row, user_id: req.user.id } : null;
}

// The entitlement, resolved server side against the organization this account
// belongs to. A metric nobody has assigned reads as off inside `mayMakePublic`,
// which is the direction that matters: the opposite default puts every account's
// files on the internet on a box whose plan ladder has not been filled in.
function mayMakePublic(userId) {
  let entitlement = null;
  let registered = false;
  try {
    // Whether this box's plan ladder carries the metric at all. It does not
    // today, because the workspace entitlement rows are step 5 and are not
    // built, and gating on a metric that cannot exist refuses every account on
    // every box for ever while nothing fails or logs. Asked of the entitlements
    // registry rather than a list kept here, so the day the row is added this
    // starts being enforced with nothing to remember.
    registered = workspaceFiles.entitlementInForce(entitlements.enabledMetrics(), workspaceFiles.ENTITLEMENTS.makePublic);
    const membership = ownership.getMembership(userId);
    if (registered && membership) entitlement = entitlements.effectiveEntitlement(membership.orgId, workspaceFiles.ENTITLEMENTS.makePublic);
  } catch { entitlement = null; }
  return workspaceFiles.mayMakePublic(entitlement, { registered });
}

function moveFile(req, res, to) {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: req.t('Not found') });

  if (to === workspaceFiles.PUBLIC) {
    const verdict = mayMakePublic(req.user.id);
    if (!verdict.allowed) {
      audit(req.user.id, 'workspace_make_public_refused', req, `${row.name}: ${verdict.reason}`);
      return res.status(403).json({ error: verdict.reason });
    }
  }

  let plan;
  try { plan = workspaceFiles.planMove({ uploadsDir: UPLOADS_DIR, userId: req.user.id, row, to }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (!plan.ok) {
    audit(req.user.id, 'workspace_move_refused', req, `${row.name}: ${plan.reason}`);
    return res.status(plan.status).json({ error: plan.reason });
  }
  if (plan.noop) return res.json({ ok: true, file: workspaceRow(req, row) });

  // The bytes move first and the row follows, in that order and not the other
  // way round. A row updated before a move that then fails says the file is
  // public when it is not, or private when it is sitting in the served
  // directory, and the second of those is a private file on the open internet.
  try {
    storageRoots.ensureRoot(UPLOADS_DIR, req.user.id, to === workspaceFiles.PUBLIC ? storageRoots.PUBLISHED : storageRoots.PRIVATE);
    fs.renameSync(plan.move.from, plan.move.to);
  } catch (error) {
    // Across filesystems a rename fails, so copy and unlink, and only unlink
    // once the copy has read back at the size it was written.
    try {
      fs.copyFileSync(plan.move.from, plan.move.to);
      if (fs.statSync(plan.move.to).size !== fs.statSync(plan.move.from).size) throw new Error('the copy did not read back at the size it was written');
      fs.unlinkSync(plan.move.from);
    } catch (fallback) {
      try { if (fs.existsSync(plan.move.to)) fs.unlinkSync(plan.move.to); } catch {}
      audit(req.user.id, 'workspace_move_failed', req, `${row.name}: ${fallback.message}`);
      return res.status(500).json({ error: req.t('That file could not be moved. Nothing has changed.') });
    }
  }
  db.prepare('UPDATE files SET disk_path=? WHERE id=? AND user_id=?').run(plan.move.to, row.id, req.user.id);
  audit(req.user.id, plan.audit.action, req, plan.audit.details);
  res.json({ ok: true, file: workspaceRow(req, { ...row, disk_path: plan.move.to }) });
}

app.post('/api/files/:id/public', auth, (req, res) => moveFile(req, res, workspaceFiles.PUBLIC));
app.post('/api/files/:id/private', auth, (req, res) => moveFile(req, res, workspaceFiles.MY_FILES));

// Deleting puts something in the Trash and removes nothing. A desktop that loses
// a file the moment Delete is pressed is a desktop nobody trusts with anything.
app.delete('/api/files/:id', auth, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: req.t('Not found') });
  // A public file cannot go to the Trash while it is public. Deleting the row
  // would leave the bytes in the served directory with nothing pointing at them,
  // which is a file on the open internet the customer believes is gone. Not a
  // permission problem, so not a 403: it is an ordering problem, and the
  // sentence says the order.
  const refusal = workspaceFiles.refusalForTrash(workspacePlaceOf(row));
  if (refusal) {
    audit(req.user.id, 'workspace_trash_refused', req, `${row.name} is public`);
    return res.status(409).json({ error: refusal });
  }
  if (row.deleted_at) return res.json({ ok: true, file: workspaceRow(req, row) });
  const at = new Date().toISOString();
  db.prepare('UPDATE files SET deleted_at=? WHERE id=? AND user_id=?').run(at, row.id, req.user.id);
  audit(req.user.id, 'workspace_trashed', req, row.name);
  res.json({ ok: true, file: workspaceRow(req, { ...row, deleted_at: at }) });
});

app.post('/api/files/:id/restore', auth, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: req.t('Not found') });
  if (!row.deleted_at) return res.json({ ok: true, file: workspaceRow(req, row) });
  db.prepare('UPDATE files SET deleted_at=NULL WHERE id=? AND user_id=?').run(row.id, req.user.id);
  audit(req.user.id, 'workspace_restored', req, row.name);
  res.json({ ok: true, file: workspaceRow(req, { ...row, deleted_at: null }) });
});

// The only thing in this product that cannot be undone, which is why it is the
// only thing the screen asks about first.
//
// `planEmptyTrash` decides what may be removed, and the check that matters is
// that every path is inside this account's own directories. A row carrying a
// path from before the storage split, or one somebody has edited, must not turn
// this into an arbitrary unlink, so such a row is kept and reported rather than
// obeyed.
app.post('/api/files/trash/empty', auth, (req, res) => {
  const rows = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE user_id=? AND deleted_at IS NOT NULL`)
    .all(req.user.id);
  const plan = workspaceFiles.planEmptyTrash({ uploadsDir: UPLOADS_DIR, userId: req.user.id, rows });
  let removed = 0;
  for (const item of plan.remove) {
    try { fs.unlinkSync(item.path); } catch {}
    db.prepare('DELETE FROM files WHERE id=? AND user_id=?').run(item.id, req.user.id);
    removed++;
  }
  audit(req.user.id, 'workspace_trash_emptied', req,
    `${removed} removed${plan.kept.length ? `, ${plan.kept.length} kept because their location is outside this account` : ''}`);
  res.json({ ok: true, removed, kept: plan.kept.length });
});

// ── PHONEDROP DROP POINT ──────────────────────────────────────────
// A tokenized, no-login upload path: the desktop asks for a session and
// shows the QR, the phone scans it and gets a one-purpose upload page, the
// photo lands in the same vault the desktop is already watching. The token
// is the only credential — random, short-lived, bound to one account and
// replaced whenever a new QR goes up. This powers the demo set piece and is
// equally the real PhoneDrop path.
const DROP_TTL_MS = 30 * 60 * 1000;
const dropSessions = new Map(); // token → { userId, url, created }

const DROP_PAGE = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'drop.html'), 'utf8'); }
  catch { return '<h1>PhoneDrop is not available</h1>'; }
})();

function dropAuth(req, res, next) {
  const s = dropSessions.get(req.params.token);
  if (!s || Date.now() - s.created > DROP_TTL_MS) {
    dropSessions.delete(req.params.token);
    return res.status(404).json({ error: req.t('This drop link has expired. Ask Echo for a fresh code.') });
  }
  req.user = { id: s.userId };
  req.dropSession = s;
  next();
}

app.post('/api/drop/session', auth, (req, res) => {
  // One live session per user; a fresh QR replaces the previous one.
  for (const [t, s] of dropSessions) if (s.userId === req.user.id) dropSessions.delete(t);
  const token = crypto.randomBytes(16).toString('hex');
  const base = ((process.env.JOTPANEL_PUBLIC_ORIGIN ?? process.env.ARCA_PUBLIC_ORIGIN) || req.headers.origin || `http://${req.headers.host}`).replace(/\/$/, '');
  const url = `${base}/api/drop/${token}`;
  dropSessions.set(token, { userId: req.user.id, url, created: Date.now() });
  audit(req.user.id, 'drop_session', req);
  res.json({ token, url, expiresInMs: DROP_TTL_MS });
});

app.get('/api/drop/:token', dropAuth, (req, res) => {
  res.type('html').send(DROP_PAGE);
});

app.get('/api/drop/:token/qr.svg', dropAuth, (req, res) => {
  const svg = new QRCodeSvg({ content: req.dropSession.url, padding: 3, width: 240, height: 240, color: '#0f1220', background: '#ffffff', ecl: 'M' }).svg();
  res.type('image/svg+xml').send(svg);
});

app.post('/api/drop/:token/files', dropAuth, checkQuota, uploadLimiter, upload.array('files'), (req, res) => {
  const inserted = [];
  for (const f of req.files || []) {
    const id = uid();
    db.prepare('INSERT INTO files (id,user_id,name,size,mime,folder,disk_path) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.user.id, f.originalname, f.size, f.mimetype, 'photos', f.path);
    inserted.push({ id, name: f.originalname, size: f.size, mime: f.mimetype, folder: 'photos' });
  }
  if (!inserted.length) return res.status(400).json({ error: req.t('No file received (is it an allowed type?)') });
  audit(req.user.id, 'phonedrop_upload', req, `${inserted.length} files`);
  res.json(inserted);
});

// ── JOURNAL ───────────────────────────────────────────────────────
app.get('/api/journal', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM journal WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id));
});

app.post('/api/journal', auth,
  [body('title').optional().trim().isLength({ max:500 }), body('body').optional()],
  validate,
  (req, res) => {
    const id = uid();
    db.prepare('INSERT INTO journal (id,user_id,title,body) VALUES (?,?,?,?)').run(id, req.user.id, req.body.title||'', req.body.body||'');
    res.json({ id, title: req.body.title, body: req.body.body });
  }
);

app.put('/api/journal/:id', auth, (req, res) => {
  db.prepare("UPDATE journal SET title=?,body=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
    .run(req.body.title||'', req.body.body||'', req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/journal/:id', auth, (req, res) => {
  db.prepare('DELETE FROM journal WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── PUBLISHER ─────────────────────────────────────────────────────
app.get('/api/pub/folders', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM pub_folders WHERE user_id=? AND site=?').all(req.user.id, req.query.site||'default'));
});

app.post('/api/pub/folders', auth,
  [body('name').trim().isLength({ min:1, max:200 })], validate,
  (req, res) => {
    const id = uid();
    db.prepare('INSERT INTO pub_folders (id,user_id,name,parent,site) VALUES (?,?,?,?,?)')
      .run(id, req.user.id, req.body.name, req.body.parent||null, req.body.site||'default');
    res.json({ id, name: req.body.name });
  }
);

app.get('/api/pub/files', auth, (req, res) => {
  res.json(db.prepare('SELECT id,name,size,mime,folder,site,added_at FROM pub_files WHERE user_id=? AND site=?').all(req.user.id, req.query.site||'default'));
});

// Publishing. This is the route whose files the internet can read, so it is the
// route that writes into the published directory, and it is the only one.
app.post('/api/pub/files', auth, checkQuota, uploadLimiter, publishedUpload.array('files'), (req, res) => {
  const folder = req.body.folder || 'root';
  const site   = req.body.site   || 'default';
  const inserted = [];
  for (const f of req.files || []) {
    const id = uid();
    db.prepare('INSERT INTO pub_files (id,user_id,name,size,mime,folder,site,disk_path) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.user.id, f.originalname, f.size, f.mimetype, folder, site, f.path);
    inserted.push({ id, name: f.originalname, size: f.size, folder, site });
  }
  res.json(inserted);
});

app.delete('/api/pub/files/:id', auth, (req, res) => {
  const row = db.prepare('SELECT disk_path FROM pub_files WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: req.t('Not found') });
  try { fs.unlinkSync(row.disk_path); } catch {}
  db.prepare('DELETE FROM pub_files WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Serve published sites.
//
// These are user-authored pages served from the SAME ORIGIN as the desktop,
// which without the header below is an account-takeover path: user A publishes
// a page carrying a script, user B visits it while signed in, and that script
// reads localStorage on this origin — including arca_jwt — because it is same
// origin. The `sandbox` directive drops the page into an opaque origin, so its
// scripts still run and the page renders normally, but it can no longer reach
// this origin's storage, cookies or the signed-in session at all.
//
// Trade-off, and it is the right one: a published page cannot use localStorage
// for its own purposes either. Static sites do not care. If a published site
// ever legitimately needs storage, the answer is a separate origin, never
// allow-same-origin here.
app.get('/sites/:userId/:site/*', (req, res) => {
  const { userId, site } = req.params;
  const filePath = req.params[0] || 'index.html';
  const row = db.prepare("SELECT disk_path FROM pub_files WHERE user_id=? AND site=? AND name=? ORDER BY added_at DESC LIMIT 1")
    .get(userId, site, path.basename(filePath));
  if (!row) return res.status(404).send('Not found');
  // The row said this file is published. This asks the disk whether it is
  // actually inside the account's published directory, and sends nothing if it
  // is not. Two answers to the same question on purpose: the query is what
  // finds the file, and this is what makes "private files are never served" a
  // property of the layout rather than of that query staying correct forever.
  // A 404 rather than a 403, because a caller probing for private files should
  // not be told the difference between one that is not there and one that is.
  const served = storageRoots.servedPathFor(UPLOADS_DIR, userId, row.disk_path);
  if (!served) {
    audit(null, 'published_file_refused', req, `${userId}/${site}: row points outside the published directory`);
    return res.status(404).send('Not found');
  }
  // Replaces the app-wide policy for this response only. Deliberately
  // permissive about what the page may load, since it is someone's real
  // website, and absolute about what it may touch here.
  res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-modals");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    statisticsService.record({
      userId,
      siteId: `published:${site}`,
      siteName: site,
      requestPath: `/${filePath}`,
      referrer: req.headers.referer || '',
      userAgent: req.headers['user-agent'] || '',
      ip: req.headers['x-real-ip'] || req.ip || '',
      statusCode: 200,
    });
  } catch (error) { console.error('[statistics]', error.message); }
  res.sendFile(served);
});

// ── A PUBLIC FILE ─────────────────────────────────────────────────
//
// What Public means, served. The id is in the address deliberately: keying a
// public file on its name alone means two files called `invoice.pdf` collide and
// the loser is whichever the query happened to order second, which is one
// customer's file quietly serving another's content.
//
// Two answers to the same question, on purpose. The row is what finds the file,
// and `servedPathFor` is what makes "files in My Files are never served" a
// property of the directory layout rather than of this query staying correct
// forever. A row from before the storage split, a `..` that survived somewhere,
// a symlink out of the published directory, or a future bug reading the wrong
// column all fail the second check.
//
// A 404 rather than a 403 throughout, because somebody probing for private files
// should not be told the difference between one that is not there and one that
// is private.
//
// Nothing here executes. The panel streams bytes and there is no interpreter
// anywhere near them, which is the one place this is better than putting a file
// on a website rather than merely different.
app.get('/p/:userId/:fileId/:name', (req, res) => {
  const { userId, fileId } = req.params;
  const row = db.prepare('SELECT id,name,mime,disk_path,deleted_at FROM files WHERE id=? AND user_id=?')
    .get(fileId, userId);
  if (!row || row.deleted_at) return res.status(404).send('Not found');
  const served = storageRoots.servedPathFor(UPLOADS_DIR, userId, row.disk_path);
  if (!served) return res.status(404).send('Not found');
  // Sent as an attachment-safe download rather than rendered in this origin. A
  // public file is somebody else's content on our address, so it must not be
  // able to run script against this origin's cookies or session. The existing
  // published-site route sandboxes for the same reason; this one has no reason
  // to render at all, so it does not.
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${String(row.name).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.sendFile(served);
});

// ── LEGACY / DEAD MAN'S SWITCH ────────────────────────────────────
app.get('/api/legacy', auth, (req, res) => {
  const sw  = db.prepare('SELECT * FROM deadmans WHERE user_id=?').get(req.user.id);
  const ben = db.prepare('SELECT * FROM beneficiaries WHERE user_id=?').all(req.user.id);
  res.json({ switch: sw || { freq:60, grace:14, last_checkin:new Date().toISOString() }, beneficiaries: ben });
});

app.post('/api/legacy/checkin', auth, (req, res) => {
  db.prepare("INSERT INTO deadmans (user_id,last_checkin) VALUES (?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET last_checkin=datetime('now')").run(req.user.id);
  audit(req.user.id, 'checkin', req);
  res.json({ ok: true, checkedIn: new Date().toISOString() });
});

app.put('/api/legacy/switch', auth, (req, res) => {
  db.prepare("INSERT INTO deadmans (user_id,freq,grace) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET freq=excluded.freq,grace=excluded.grace")
    .run(req.user.id, req.body.freq||60, req.body.grace||14);
  res.json({ ok: true });
});

app.post('/api/legacy/beneficiaries', auth,
  [body('name').trim().isLength({ min:1, max:200 }), body('email').optional().isEmail()],
  validate,
  (req, res) => {
    const id = uid();
    db.prepare('INSERT INTO beneficiaries (id,user_id,name,email,relation,access) VALUES (?,?,?,?,?,?)')
      .run(id, req.user.id, req.body.name, req.body.email||'', req.body.relation||'', req.body.access||'view');
    res.json({ id, ...req.body });
  }
);

app.delete('/api/legacy/beneficiaries/:id', auth, (req, res) => {
  db.prepare('DELETE FROM beneficiaries WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});


// ── DEPLOY & CREDENTIAL VAULT ────────────────────────────────────────────────
// Stores FTP/SFTP credentials encrypted per user.
// Executes file transfer server-side (browser cannot open raw TCP connections).

db.exec(`
  CREATE TABLE IF NOT EXISTS deploy_credentials (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    label      TEXT NOT NULL,
    protocol   TEXT NOT NULL DEFAULT 'sftp',
    host       TEXT NOT NULL,
    port       INTEGER NOT NULL DEFAULT 22,
    username   TEXT NOT NULL,
    password   TEXT,
    remote_dir TEXT NOT NULL DEFAULT '/public_html',
    created_at TEXT NOT NULL
  );
`);

// Encrypt/decrypt credential fields using AES-256-GCM
// scrypt is deliberately slow (~tens of ms of CPU per call), so derive each key once and cache it
const _fieldKeys = new Map();
function fieldKey(secret) {
  let k = _fieldKeys.get(secret);
  if (!k) { k = crypto.scryptSync(secret, 'arca-deploy-salt', 32); _fieldKeys.set(secret, k); }
  return k;
}
function encryptField(text, secret) {
  if (!text) return "";
  const iv  = crypto.randomBytes(12);
  const key = fieldKey(secret);
  const c   = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptField(b64, secret) {
  if (!b64) return "";
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const key = fieldKey(secret);
    const d   = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return ""; }
}

function decryptPortableCredential(value, secret, label) {
  if (!value) return '';
  const plaintext = decryptField(value, secret);
  if (!plaintext) throw new Error(`${label} could not be decrypted, so the account package was not created`);
  return plaintext;
}

// ── Native control-plane services ─────────────────────────────────
// The full action body is encrypted because proposals can contain mailbox
// passwords, commands and archive paths. The small clear-text columns are only
// what the queue needs to filter and label work.
const ACTION_ENCRYPT_SECRET = ENCRYPT_SECRET + '_control_actions';
const MAIL_ENCRYPT_SECRET = ENCRYPT_SECRET + '_mail';
const LICENSE_ENCRYPT_SECRET = ENCRYPT_SECRET + '_panel_license';
const actionStore = createActionStore({
  db,
  protect: value => encryptField(value, ACTION_ENCRYPT_SECRET),
  unprotect: value => decryptField(value, ACTION_ENCRYPT_SECRET),
});
// The Resident's project ledger (Stage 1). Bodies are encrypted like actions;
// dispatches left in flight by a previous process are marked interrupted here.
const projectLedger = createProjectLedger({
  db,
  protect: value => encryptField(value, ENCRYPT_SECRET + '_project_ledger'),
  unprotect: value => decryptField(value, ENCRYPT_SECRET + '_project_ledger'),
  audit: (userId, action, details) => audit(userId, action, null, details),
});
const LEDGER_RUN_ID = crypto.randomBytes(8).toString('hex');
const routingFit = createRoutingFit({ db });
// The Resident's own reading of each turn: plain rules, then the local model
// inside the latency budget (decision 6: about 2s on a GPU, 8s on CPU).
const residentGateway = createResidentGateway({
  ledger: projectLedger,
  runId: LEDGER_RUN_ID,
  understand: createUnderstanding({
    callModel: async (system, text) => {
      const resident = await getResident();
      if (!resident.available || !resident.chatModel) throw new Error('no local model');
      const out = await callProvider({ providerId: 'ollama', model: resident.chatModel, key: '', system, messages: [{ role: 'user', content: text }], maxTokens: 40 });
      return out.text;
    },
    budgetMs: async () => Number(process.env.JOTPANEL_RESIDENT_BUDGET_MS ?? process.env.ARCA_RESIDENT_BUDGET_MS) || ((await getResident()).accel === 'gpu' ? 2000 : 8000),
  }),
});
// The record is kept for every turn, and a failure to keep it is logged rather
// than allowed to stop the answer (decision 6: the Resident never blocks).
function residentDispatch(turn, route, options) {
  if (!turn) return null;
  try { return residentGateway.dispatch(turn, route, options); }
  catch (error) { console.error('[resident] dispatch record', error.message); return null; }
}
function residentFinish(turn, dispatchId, result = {}) {
  if (!turn || !dispatchId) return;
  try { residentGateway.finish(turn, dispatchId, result); }
  catch (error) { console.error('[resident] finish record', error.message); }
}
{
  const interrupted = projectLedger.recoverInterrupted({ runId: LEDGER_RUN_ID });
  const check = projectLedger.verify();
  console.log(`[ledger] ${check.items} items, ${check.events} events, ${check.ok ? 'view matches log' : `PROBLEMS: ${check.problems.slice(0, 3).join('; ')}`}${interrupted.length ? `, ${interrupted.length} dispatches marked interrupted` : ''}`);
}
const usageService = createUsageService({ db });
const statisticsService = createStatisticsService({ db, secret: ENCRYPT_SECRET + '_web_statistics' });
const scheduledJobs = createScheduledJobsService({ db, actionStore });
const licenseClient = createLicenseClient({
  db,
  dataDir: DATA_DIR,
  encrypt: value => encryptField(value, LICENSE_ENCRYPT_SECRET),
  decrypt: value => decryptField(value, LICENSE_ENCRYPT_SECRET),
});
const apiKeys = createApiKeyService({ db });

// Registration is a condition of using OUR service, not of using the panel.
//
// This gate used to sit at the top of the chat route, above the fork that
// decides who answers. So a customer who had pasted their own Anthropic key —
// a key that lives in their vault, on their box, and never touches anything of
// ours — was still refused until they had registered with JotNotes. The
// installer's own first page says "The panel installs and works without
// registration", and that was not true of the one feature people came for.
//
// The fork already exists: with a thinking URL configured the panel proxies to
// the hosted service, and without one it answers from the panel's own prompt
// with the person's own key. Registration follows that fork now. Steve, 2026-09-25.
// Which models this panel has actually called successfully, per person and
// provider. Separate from the catalogue (what a model is) and from discovery
// (what a key can reach), because "we have proved this works" is a different
// claim from either and must not be inferred from them.
db.exec(`
  CREATE TABLE IF NOT EXISTS provider_model_tests (
    user_id     TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id    TEXT NOT NULL,
    tested_at   TEXT NOT NULL,
    PRIMARY KEY (user_id, provider_id, model_id)
  )
`);

const { createModelCatalogue } = require('./control/modelCatalogue');
const { createProviderModels } = require('./control/providerModels');
const { offerFor } = require('./control/modelOffer');
// Updatable without a release: an operator drops model-catalogue.json into the
// data directory and the panel picks it up at boot.
const modelCatalogue = createModelCatalogue({ dataDir: DATA_DIR, log: (...a) => console.log(...a) });
const providerModels = createProviderModels();
for (const problem of modelCatalogue.problems()) console.warn('[catalogue]', problem);

const { createThinkingGate } = require('./control/thinkingGate');
const thinkingAccessForRequest = createThinkingGate({ licenseClient });

// Provider keys. Not in the settings blob any more: they were stored there in
// clear text and `GET /api/settings` handed them straight back, so anything
// holding a session could read a customer's key and every database backup
// carried it. See control/providerKeys.js.
const providerKeys = createProviderKeyService({ db, secret: ENCRYPT_SECRET });

// Move whatever a box is already carrying. Runs once because it empties the
// field it reads, and it is deliberately not conditional on a version marker:
// the cost of running it on an already-clean box is one query.
(function moveProviderKeysOutOfSettings() {
  let moved = 0;
  let rows = [];
  try { rows = db.prepare('SELECT user_id, data FROM settings').all(); } catch { return; }
  for (const row of rows) {
    let blob;
    try { blob = JSON.parse(row.data || '{}'); } catch { continue; }
    if (!blob || typeof blob !== 'object' || !blob.aiKeys || typeof blob.aiKeys !== 'object') continue;
    for (const [providerId, held] of Object.entries(blob.aiKeys)) {
      const value = held && typeof held.key === 'string' ? held.key.trim() : '';
      if (!value) continue;
      try {
        providerKeys.put({ kind: 'identity', id: row.user_id }, providerId, value,
          { label: 'moved out of settings', by: 'migration' });
        moved++;
      } catch { /* a key that will not store is a key that stops being readable, which is the point */ }
    }
    delete blob.aiKeys;
    db.prepare('UPDATE settings SET data=? WHERE user_id=?').run(JSON.stringify(blob), row.user_id);
  }
  if (moved) console.log(`[keys] moved ${moved} provider key(s) out of settings and into the vault`);
})();
const localEngineSecurity = createLocalEngineSecurity({ actionStore });
// BYOG — the model on the user's own machine, reached over a link that machine
// dials out on. `audit` is passed rather than imported so pairing and revoking
// land in the same log as everything else a person does to their account.
const byog = createByogService({ db, audit: (userId, action, _req, details) => audit(userId, action, { headers: {}, ip: 'byog' }, details) });
const portability = createPortabilityService({
  db,
  actionStore,
  uploadsDir: UPLOADS_DIR,
  importsDir: path.join(DATA_DIR, 'imports'),
  decryptDeploy: value => decryptPortableCredential(value, ENCRYPT_SECRET, 'A deploy credential'),
  encryptDeploy: value => encryptField(value, ENCRYPT_SECRET),
  decryptMail: value => decryptPortableCredential(value, MAIL_ENCRYPT_SECRET, 'A mail credential'),
  encryptMail: value => encryptField(value, MAIL_ENCRYPT_SECRET),
});

// ── Server operations engine ──────────────────────────────────────
// JotPanel owns the panel. Native stacks cover databases, websites, certificates
// and mail through the privileged named-job service; the unprivileged host
// backend supplies reads such as processes and logs. There is no panel below
// this one.
const opsBackends = [createNativeStackBackend()];
opsBackends.push(createHostBackend({
  env: process.env,
  fileRootFor: ctx => (ctx && ctx.accountId ? path.join(UPLOADS_DIR, String(ctx.accountId)) : null),
}));
// The Integration Manager, as a backend rather than a system beside one, so a
// vendor is reached down the same proposed-approved-executed-verified path a
// local change already uses. It needs to call the engine it is part of, which
// is a knot only in the order things are constructed: nothing calls through
// here until a request arrives, long after the engine exists.
let opsEngine;
const integrationsBackend = createIntegrationsBackend({
  db,
  protect: value => encryptField(value, ENCRYPT_SECRET + '_integrations'),
  unprotect: value => decryptField(value, ENCRYPT_SECRET + '_integrations'),
  local: {
    run: (capability, params, ctx) => opsEngine.run(capability, params, ctx),
    has: capability => opsEngine.has(capability),
    reasonFor: capability => opsEngine.reasonFor(capability),
  },
});
opsBackends.push(integrationsBackend);
opsEngine = createOpsEngine({ backends: opsBackends });

const privilegedOps = opsBackends[0].client;
// `administersOrg` is handed to ownership rather than worked out inside it: the
// answer lives in the entitlements hierarchy, and ownership.js deliberately
// knows nothing about packages. Read at call time, not at construction, because
// entitlements is built a few lines below this.
const ownership = createOwnershipService({
  db,
  administersOrg: (actorOrgId, targetOrgId) => entitlements.getSubtreeOrgIds(actorOrgId).includes(targetOrgId),
});
const backupHealth = createBackupHealthStore({ db });

// Telling somebody a backup broke.
//
// Delivery goes through the transactional email capability the Integration
// Manager already has, rather than a mail client of its own: the operator
// connects an SMTP provider once and everything that needs to send uses it. If
// nothing is connected, the incident is still opened and still shows in the
// grid, and the reason it could not be delivered is recorded on it. A panel
// that swallowed the failure to warn would be worse than one that never tried.
const BACKUP_ALERT_TO = (process.env.JOTPANEL_BACKUP_ALERT_TO ?? process.env.ARCA_BACKUP_ALERT_TO) || (process.env.JOTPANEL_OWNER_EMAIL ?? process.env.ARCA_OWNER_EMAIL) || null;

async function deliverBackupNotice(incident, kind) {
  const to = BACKUP_ALERT_TO || db.prepare('SELECT email FROM users ORDER BY created_at LIMIT 1').get()?.email;
  if (!to) return { sent: false, reason: 'this panel has nobody to tell: no operator address is configured' };
  const where = incident.domain ? `${incident.account_name_snapshot} (${incident.domain})` : incident.account_name_snapshot;
  const subject = kind === 'resolved'
    ? `Backups are working again for ${where}`
    : `Backup ${incident.stage === 'offsite' ? 'offsite copy ' : ''}failed for ${where}`;
  // Enough to act on and nothing that would be a leak if the mail went astray:
  // which account, which site, which stage, how long, and what to look at. No
  // paths, no commands, no credentials, no unredacted error output.
  const text = kind === 'resolved'
    ? [`Backups for ${where} are verifying again.`, '',
      `The problem that started at ${incident.opened_at} is closed after ${incident.occurrences} failed run(s).`,
      '', `Open ${DOMAIN} and look at Backup health for the detail.`].join('\n')
    : [`A backup for ${where} did not complete.`, '',
      `What failed: ${incident.stage || 'the backup'}`,
      `Reason: ${incident.failure_summary || 'no reason was recorded'}`,
      `Failed runs so far: ${incident.occurrences}`,
      `First seen: ${incident.opened_at}`,
      '',
      incident.stage === 'offsite'
        ? 'The copy on this machine was made and verified, so there is something to restore from. What is missing is the copy off the machine.'
        : 'There may be no usable recovery point from this run.',
      '', `Open ${DOMAIN} and look at Backup health for the detail.`].join('\n');
  try {
    const sent = await opsEngine.run('capability.email.transactional.send', { to, subject, text, from: `jotpanel@${DOMAIN}` }, {});
    const data = sent?.data || {};
    if (data.verified === false) return { sent: false, reason: 'the mail server did not accept the recipient' };
    return { sent: true, to };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

// Called wherever a backup run reaches a terminal state. Opens or closes the
// incident, then delivers only if the noise rules say this one has earned a
// message. Never throws into the caller: failing to send a warning must not
// also fail the thing that was trying to warn.
async function noteBackupOutcome(outcome) {
  try {
    if (outcome.ok) {
      const closed = backupHealth.recordSuccess({ accountId: outcome.accountId, domain: outcome.domain, runId: outcome.runId });
      if (closed.notify && closed.closed.length) {
        const result = await deliverBackupNotice(closed.closed[0], 'resolved');
        backupHealth.markNotified(closed.closed[0].id, result.sent ? null : result.reason);
      }
      return;
    }
    const { incident, notify } = backupHealth.recordFailure(outcome);
    if (!incident || !notify) return;
    const result = await deliverBackupNotice(incident, 'failed');
    backupHealth.markNotified(incident.id, result.sent ? null : result.reason);
  } catch (error) {
    console.error('[backup-health] an incident could not be recorded:', error.message);
  }
}
opsBackends.push(createBackupHealthBackend({ store: backupHealth }));
// Named after the machine, so an authenticator app showing several servers
// says which one each code belongs to rather than listing "Arca" four times.
const twoFactor = createTwoFactorService({ db, issuer: `${PRODUCT_NAME} (${DOMAIN})`, secret: ENCRYPT_SECRET });
const passkeys = createPasskeyService({ db });
const accountRecovery = createAccountRecoveryService({ db });
const recovery = createRecoveryCeremony({
  db, ownership, accountRecovery,
  audit: (userId, action, req, details) => audit(userId, action, req, details),
});
try { recovery.sweep(); } catch { /* a sweep that fails must not stop a boot */ }
// Answered once at start rather than per request: whether this installation can
// offer passkeys at all depends on whether it has a domain, and that does not
// change while the process is running.
if (passkeys.available()) {
  console.log(`[jotpanel] Passkeys enabled for ${passkeys.relyingParty().rpID}`);
} else {
  console.log(`[jotpanel] Passkeys unavailable: ${passkeys.whyUnavailable()}`);
}
try { passkeys.sweepChallenges(); } catch { /* a sweep that fails must not stop a boot */ }
// The assistant's spend, read out of its own ledger rather than copied into a
// second one. A microunit is a millionth of a dollar, which is what the metric
// is declared in, because a currency held as a float and summed over thousands
// of calls stops adding up.
function aiSpendMicrounits(orgIds, monthKey) {
  if (!orgIds.length) return 0;
  const placeholders = orgIds.map(() => '?').join(',');
  const row = db.prepare(`SELECT COALESCE(SUM(u.cost),0) AS total FROM ai_usage u
    JOIN memberships m ON m.identity_id = u.user_id
    WHERE m.org_id IN (${placeholders}) AND substr(u.ts,1,7)=? AND u.byok=0`).get(...orgIds, monthKey);
  return Math.round((row?.total || 0) * 1e6);
}

const entitlements = createEntitlementsService({
  db,
  runPrivilegedJob: (job, params) => privilegedOps.run(job, params),
  aiSpendReader: aiSpendMicrounits,
});

// Reseller administration joins the same execution path as everything else.
// Pushed after the engine was built rather than before, because this backend
// needs the two services above and they need `privilegedOps`, which the engine's
// own first backend owns. The engine walks this array on every resolve, so a
// backend added here is picked up on the next refresh rather than missed.
opsBackends.push(createEntitlementsBackend({ entitlements, ownership }));
// The account lifecycle joins it too. Creating a customer, stopping one and
// starting one again existed only on the `/admin/api` router, which is gated on
// a shared key: the same password for everybody holding it, so it can never
// mean "this reseller, for these customers and no others". A provider needs
// those three and they belong on the path that asks who is asking.
// `setSitesSuspended` is a hoisted declaration further down this file; it is
// only ever called long after the module has finished loading.
opsBackends.push(createAccountsBackend({
  db, ownership, entitlements, bcrypt,
  newId: uid,
  setSitesSuspended: (userId, suspended) => setSitesSuspended(userId, suspended),
  recordLifecycle: (userId, event, reason) => usageService.recordLifecycle(userId, event, reason),
}));
opsEngine.refresh();

// Who holds this machine's capacity, and when. See control/ownerBootstrap.js:
// the operator's organization is the entitlement root, and it has to be marked
// at the two moments a machine can arrive at having an operator, because the
// boot below runs before the installer has created one.
const { ensureEntitlementRoot: markEntitlementRoot } = require('./control/ownerBootstrap');
function ensureEntitlementRoot() { return markEntitlementRoot({ db, entitlements }); }

// Migration, run at boot, idempotent: every organization that already exists
// but has no parent link yet is linked under the root above and given an
// immutable, unlimited "Legacy" package. Without this, shipping entitlements
// would retroactively block every account that already exists the moment it
// next tried to create anything, the spec's own migration step 4, done here
// rather than deferred, because the alternative is every existing
// demo/customer account silently losing the ability to grow.
(function migrateEntitlements() {
  const root = ensureEntitlementRoot();
  if (!root) return; // no membership has ever been written yet — nothing to migrate
  const operator = { org_id: root.orgId };

  const orgs = db.prepare('SELECT DISTINCT org_id FROM memberships').all().map(r => r.org_id);
  const unmigrated = orgs.filter(orgId => orgId !== operator.org_id && !entitlements.getDirectParent(orgId));
  if (!unmigrated.length) return;

  let legacyPkg = db.prepare(`SELECT id FROM packages WHERE owner_org_id=? AND name='Legacy Unlimited'`).get(operator.org_id);
  if (!legacyPkg) {
    const limits = entitlements.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: true }));
    legacyPkg = entitlements.createPackage({ ownerOrgId: operator.org_id, name: 'Legacy Unlimited', description: 'Migration-only: every account that existed before packages shipped. Not for new assignments.', limits, actorIdentityId: 'migration' });
  }
  for (const orgId of unmigrated) {
    entitlements.linkOrganizations(operator.org_id, orgId, 'migration');
    entitlements.assignPackage({ parentOrgId: operator.org_id, targetOrgId: orgId, packageId: legacyPkg.id, actorIdentityId: 'migration' });
  }
})();

const serverOps = createServerOpsService({
  engine: opsEngine,
  actionStore,
  ownership,
  entitlements,
  backupHealth,
  onBackupOutcome: noteBackupOutcome,
  // Whose record an unattended run belongs in when the domain carries no
  // ownership claim of its own. The operator is the honest answer: it is their
  // machine and their schedule, and a run nobody can see is the problem this is
  // here to fix.
  operatorAccountId: () => {
    try {
      const row = db.prepare("SELECT id FROM users WHERE plan='owner' ORDER BY created_at LIMIT 1").get();
      return row ? row.id : null;
    } catch { return null; }
  },
  uploadDir: path.join(DATA_DIR, 'dumps'),
  // Where a foreign archive waits between being read and being applied. Same
  // area and same sweep as the dump uploads beside it.
  migrationDir: path.join(DATA_DIR, 'migrations'),
  oneshotResult: instance => privilegedOps.run('oneshot.result', { instance }),
  // So an action the watcher settles lands in the owner's audit trail too, not
  // only in this process's journal. There is no request behind these: nobody
  // was present, which is exactly why they have to be written down.
  audit: (userId, action, req, details) => audit(userId, action, req, details),
  // The privileged service is ordered before the panel, but "started" and
  // "listening" are not the same instant, and after a reboot they are further
  // apart than usual. Giving it a minute to answer is the difference between
  // reading a real result and recording that we could not look.
  waitForService: async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await privilegedOps.probe()).ok) return true;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return false;
  },
});
console.log(`[server-ops] engines: ${opsBackends.map(b => b.name).join(', ')}`);

// Anything left mid-execution by a process that is no longer running is
// resolved before the panel is much use, so the owner never reads a record that
// says approved and never executed about work the machine has already done.
serverOps.reconcile()
  .then(summary => { if (summary.checked) console.log(`[server-ops] reconciled ${summary.checked} interrupted action(s):`, summary); })
  .catch(error => console.error('[server-ops] the interrupted-action pass failed:', error.message));

// Scheduled backups run whether or not this process is up, so their journal is
// collected at boot and then periodically. Without this a 3am failure waits for
// somebody to open a screen before anyone can know about it.
const INGEST_UNATTENDED_MS = 10 * 60 * 1000;
function collectUnattendedRuns(why) {
  serverOps.ingestUnattendedRuns()
    .then(summary => { if (summary.ingested) console.log(`[server-ops] recorded ${summary.ingested} unattended backup run(s) (${why})`); })
    .catch(error => console.error('[server-ops] the unattended-run pass failed:', error.message));
}
collectUnattendedRuns('boot');
setInterval(() => collectUnattendedRuns('timer'), INGEST_UNATTENDED_MS).unref();
console.log(`[shell] serving the ${SHELL === 'panel' ? 'standalone control panel' : 'JotNotes Navigator desktop'} at /`);

scheduledJobs.start();

// Files from before private and published were two directories. Each one is
// moved into the directory its own table implies and its row is updated in the
// same transaction, so a file that moves without its row cannot be left behind
// as something the panel has lost track of. A box with nothing to move does
// nothing and says nothing, which is what makes it safe at every start.
(function relocateLegacyUploads() {
  try {
    const rows = [
      ...db.prepare('SELECT id, user_id, disk_path FROM files').all().map(r => ({ ...r, published: false })),
      ...db.prepare('SELECT id, user_id, disk_path FROM pub_files').all().map(r => ({ ...r, published: true })),
    ];
    const plan = storageRoots.planRelocation({ uploadsDir: UPLOADS_DIR, rows });
    if (!plan.length) return;
    let moved = 0;
    for (const step of plan) {
      try {
        fs.mkdirSync(path.dirname(step.to), { recursive: true, mode: 0o750 });
        db.transaction(() => {
          fs.renameSync(step.from, step.to);
          db.prepare(`UPDATE ${step.table === 'pub_files' ? 'pub_files' : 'files'} SET disk_path=? WHERE id=?`).run(step.to, step.id);
        })();
        moved++;
      } catch (error) {
        console.error(`[storage] could not relocate ${step.id}: ${error.message}`);
      }
    }
    console.log(`[storage] moved ${moved} of ${plan.length} file(s) into private/published directories`);
    audit(null, 'storage_roots_split', null, `${moved} of ${plan.length} legacy file(s) relocated`);
  } catch (error) {
    console.error('[storage] relocation pass failed:', error.message);
  }
})();
localEngineSecurity.start(finding => {
  try {
    db.prepare('INSERT INTO audit_log (action,details) VALUES (?,?)')
      .run('local_engine_unsafe', finding.reason);
  } catch {}
});

// What the panel is allowed to see of an action. The rule is the shared one in
// control/secrets.js: this used to keep its own copy, and the copy was missing
// `credential`, which is how a provider's key reached the browser.
//
// This hides; it does not remove. The store itself scrubs the spent secret out
// of the body when the action becomes terminal, so by the time most actions are
// read there is nothing here left to hide.
function publicControlAction(action) {
  if (!action) return null;
  return redactSecrets(JSON.parse(JSON.stringify(action)));
}

// Server operations run against the owner's own account scope and never
// against anything named in a request body.
function opsContext(req) {
  const account = buildProvisioningAccountContext(req.user.id);
  // Worked out here from the signed identity, never read off the request. A
  // backend that needs to know whether it is answering the operator asks this
  // and nothing else, so there is no shape of request body that can claim it.
  let isOperator = false;
  try {
    const membership = ownership.getMembership(req.user.id);
    isOperator = !!membership && membership.rank >= OWNERSHIP_TOP_TWO;
  } catch { isOperator = false; }
  return {
    accountId: req.user.id,
    isOperator,
    // What this particular caller is allowed to reach. A person is allowed
    // everything their ownership allows; a key is allowed the intersection of
    // that and its own scopes, read off the stored row and never off the
    // request. Absent for a person, which reads as "not narrowed".
    permits: req.apiKey ? req.apiKey.permits : null,
    keyId: req.apiKey ? req.apiKey.id : null,
    cpanelUser: account.cpanelUser,
    panelUser: process.env.HESTIA_USER_ACCOUNT || account.cpanelUser,
    primaryDomain: account.primaryDomain,
    domains: account.domains,
  };
}

// ── CONTROL ACTIONS ──────────────────────────────────────────────
// One durable list for voice actions and panel actions. Approval and rejection
// are generic; execution remains type-specific so an approved label can never
// be swapped into an arbitrary operation.
app.get('/api/control/actions', auth, (req, res) => {
  const actions = actionStore.list({ userId: req.user.id, limit: req.query.limit || 250 }).map(publicControlAction);
  res.json({ durable: true, actions });
});

// "What executed on this machine that no person approved?" The honest answer to
// that question is the point of recording unattended runs at all, so it is a
// query rather than something to be reconstructed by eye from a mixed list.
// It reports what ran and what was due and did not run as two separate things,
// because conflating "ran" with "was scheduled" is how a silent failure hides.
// Collect the scheduled-run journal now rather than waiting for the timer.
//
// The sweep runs at boot and every ten minutes, which is right for a machine
// nobody is watching and wrong for a person who has just been told a backup
// failed and wants to see it. It is also what makes the scheduled path
// testable: without it, proving a scheduled offsite copy means sleeping for up
// to ten minutes and hoping. It only reads a journal this machine wrote and
// records what is already there, so it changes nothing that was not going to
// happen anyway.
app.post('/api/control/actions/unattended/collect', auth, async (req, res) => {
  try {
    const summary = await serverOps.ingestUnattendedRuns();
    audit(req.user.id, 'unattended_runs_collected', req, `${summary.ingested || 0} run(s)`);
    res.json({ ok: true, ...summary });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/control/actions/unattended', auth, (req, res) => {
  const rows = actionStore.list({ userId: req.user.id, kind: 'server_ops.backup.unattended', limit: req.query.limit || 250 });
  const runs = rows.map(publicControlAction);
  res.json({
    durable: true,
    basis: 'unattended_schedule',
    note: 'These ran automatically under a stored schedule. No person approved any of them, and none of them is recorded as approved.',
    ran: runs.filter(action => action.executionResult?.outcome !== 'not_started'),
    dueButDidNotRun: runs.filter(action => action.executionResult?.outcome === 'not_started'),
  });
});

// "Has this operation ever run here, and did anybody check?" asked as a
// question rather than reconstructed from the list above.
//
// The list is capped at a thousand rows, newest first, which is right for a
// screen and wrong for this: a session that runs several hundred proofs pushes
// the earlier ones past the cap, and an operation proved in June then reads as
// never run. The checklist is built from that answer, so its total could fall
// on a day when nothing regressed, which is exactly the kind of number that
// teaches people to stop reading it.
//
// One grouped query, one row per operation, no window. Scoped to the caller in
// the same way the list is: this is a cheaper way to ask the same question, not
// a wider one.
app.get('/api/control/actions/summary', auth, (req, res) => {
  const operations = actionStore.summarizeByKind({ userId: req.user.id, prefix: req.query.prefix || null });
  res.json({ durable: true, horizon: 'none: this is grouped, not paged', operations });
});

app.post('/api/control/actions/:id/approve', auth, (req, res) => {
  try {
    const existing = actionStore.get(req.params.id);
    if (!existing || existing.accountId !== req.user.id) return res.status(404).json({ error: req.t('Not found') });
    // A credential the panel generated because nobody had a form to type one
    // into. The person may replace it on the way through approval, which is
    // where a password belongs: typed by its owner, into the panel, on their
    // own authenticated request, and never into a conversation.
    if (req.body?.secrets && String(existing.kind).startsWith('server_ops.')) {
      for (const [name, value] of Object.entries(req.body.secrets)) {
        serverOps.supplySecret(req.params.id, req.user.id, name, value);
        audit(req.user.id, 'server_op_secret_chosen', req, `${existing.label}: ${name} chosen by the owner`);
      }
    }
    // A key is not a person, and an approval is the one place in this product
    // where that distinction is the whole point. A key may approve only if it
    // was issued with `control.approve`, and what is written down is the key,
    // never the name of whoever created it: a machine's decision wearing a
    // person's name is worse than no record at all, which is the same rule the
    // unattended-run recorder holds.
    if (req.apiKey && !req.apiKey.permits('control.approve')) {
      audit(req.user.id, 'api_key_approval_refused', req, `${req.apiKey.prefix}: ${existing.label}`);
      return res.status(403).json({ error: req.t('This key is not scoped to approve actions. Add control.approve to it, or have a person approve this one.') });
    }
    const approvedBy = req.apiKey ? `api_key:${req.apiKey.prefix}` : req.user.id;
    const action = actionStore.approve(req.params.id, { approvedBy, confirmText: req.body?.confirmText });
    audit(req.user.id, 'control_action_approved', req, `${action.label}${req.apiKey ? ` (by key ${req.apiKey.prefix})` : ''}`);
    res.json({ ok: true, action: publicControlAction(action) });
  } catch (error) {
    audit(req.user.id, 'control_action_approval_failed', req, error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/control/actions/:id/reject', auth, (req, res) => {
  try {
    const existing = actionStore.get(req.params.id);
    if (!existing || existing.accountId !== req.user.id) return res.status(404).json({ error: req.t('Not found') });
    const action = actionStore.reject(req.params.id, { rejectedBy: req.user.id, reason: req.body?.reason || 'Rejected by owner' });
    audit(req.user.id, 'control_action_rejected', req, action.label);
    res.json({ ok: true, action: publicControlAction(action) });
  } catch (error) {
    audit(req.user.id, 'control_action_rejection_failed', req, error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/control/actions/:id/execute', auth, async (req, res) => {
  const action = actionStore.get(req.params.id);
  if (!action || action.accountId !== req.user.id) return res.status(404).json({ error: req.t('Not found') });
  try {
    let result;
    if (action.kind.startsWith('scheduled_job.')) result = await scheduledJobs.execute(action.id, req.user.id);
    else if (action.kind.startsWith('server_ops.')) result = await serverOps.execute(action.id, req.user.id, opsContext(req));
    else if (action.kind === 'local_engine.secure') result = await localEngineSecurity.executeFix(action.id, req.user.id);
    else return res.status(400).json({ error: req.t('Use the operation-specific execute endpoint for this action.') });
    audit(req.user.id, 'control_action_executed', req, action.label);
    // Credentials a migration had to generate, because the archive it read
    // carries hashes this machine cannot reuse. They are handed back beside the
    // action rather than inside it: the action is what gets recorded, and these
    // are shown to the owner once and kept nowhere. Without this the accounts
    // exist and nobody can sign in to any of them.
    const shownOnce = Array.isArray(result?.deliver_once) ? result.deliver_once : null;
    if (shownOnce?.length) audit(req.user.id, 'server_op_credentials_shown', req, `${action.label}: ${shownOnce.length} generated password(s) shown once`);
    const recorded = publicControlAction(result);
    // It travelled attached to the action because that is what execute returns,
    // and it is taken off again here. The action is the record; this is not,
    // and the same list appearing in both places with one copy blanked is how
    // somebody concludes the passwords were lost.
    delete recorded.deliver_once;
    res.json({ ok: true, action: recorded, ...(shownOnce?.length ? { deliver_once: shownOnce } : {}) });
  } catch (error) {
    // Still running is not failed. The panel stopped waiting at the screen, the
    // machine carried on, and the row stays `executing` until the machine says
    // how it ended. Recording this as a failure is the one answer we know to be
    // wrong, and it is the answer this route used to give.
    if (error.stillRunning) {
      audit(req.user.id, 'control_action_still_running', req, `${action.label}: the panel stopped watching; the machine is still working`);
      return res.status(202).json({
        ok: true,
        stillRunning: true,
        message: error.message,
        action: publicControlAction(actionStore.get(action.id)),
      });
    }
    audit(req.user.id, 'control_action_failed', req, `${action.label}: ${error.message}`);
    res.status(400).json({ error: error.message, action: publicControlAction(actionStore.get(action.id)) });
  }
});

// ── PORTABILITY & MIGRATION ──────────────────────────────────────
app.post('/api/portability/export/propose', auth, (req, res) => {
  try {
    const action = portability.proposeExport(req.user.id);
    audit(req.user.id, 'portability_export_proposed', req, action.id);
    res.json({ ok: true, action: publicControlAction(action) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/portability/export/:id/execute', auth, (req, res) => {
  try {
    const built = portability.executeExport(req.params.id, req.user.id, req.body?.passphrase);
    audit(req.user.id, 'portability_export_executed', req, `${built.report.bytes} bytes ${built.report.sha256}`);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${built.filename}"`,
      'Content-Length': String(built.buffer.length),
      'X-JotPanel-Package-SHA256': built.report.sha256,
    });
    res.send(built.buffer);
  } catch (error) {
    audit(req.user.id, 'portability_export_failed', req, error.message);
    res.status(400).json({ error: error.message, failures: error.failures || [] });
  }
});

app.post('/api/portability/import/inspect', auth, uploadLimiter, upload.single('archive'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: req.t('A ZIP, TAR, or TAR.GZ archive is required.') });
  try {
    const result = portability.acceptImportUpload(req.user.id, req.file.path, req.file.originalname);
    audit(req.user.id, 'portability_import_inspected', req, `${result.inspection.source}: ${req.file.originalname}`);
    res.json({ ok: true, action: publicControlAction(result.action), inspection: result.inspection });
  } catch (error) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    audit(req.user.id, 'portability_import_rejected', req, error.message);
    res.status(400).json({ error: error.message });
  }
});

// Read a cPanel archive and say what is in it. Nothing is created. The archive
// itself is now kept for a short while rather than deleted on the way out: it
// carries somebody's entire account, and the apply that follows needs the bytes
// to fill in what the plan describes. It is swept on the same fifteen-minute
// timer as an uploaded dump, and it is reachable only by the token this route
// hands back, resolved against the panel's own directory.
app.post('/api/panel/server/migration/archive', auth, uploadLimiter, upload.single('archive'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: req.t('Choose a cPanel archive to read.') });
  try {
    const { format, entries } = readArchiveFile(req.file.path);
    const parsed = parseCpanelArchive(entries);
    // Kept rather than thrown away, which is the change that lets a migration
    // carry content at all. The archive was read to make the plan; it is held
    // for the same fifteen minutes an uploaded dump is, so the apply that
    // follows can put the website files, the database dumps and the stored mail
    // where the plan says they go. A box with no staging area still gets a plan,
    // and the plan says in words that it will build empty.
    let staged = null;
    try { staged = serverOps.stageMigrationArchive(req.user.id, req.file.path, req.file.originalname); }
    catch (error) { console.error('[migration] the archive could not be staged:', error.message); }
    // Three separate pieces, each refusing on its own terms: the parser refuses
    // an archive that is not cPanel, the adapter refuses a plan it cannot read,
    // and the catalogue rebuilds every field before the plan is allowed to be
    // the input to anything.
    const plan = migrationPlan(planFromCpanel(parsed, { archiveId: staged ? staged.archiveId : null }));
    audit(req.user.id, 'migration_archive_read', req, `${req.file.originalname}: ${plan.domains.length} site(s), ${plan.databases.length} database(s), ${plan.mailboxes.length} mailbox(es)${staged ? ', archive kept for the apply' : ', archive not kept'}`);
    res.json({ ok: true, format, archive: req.file.originalname, plan, content_available: !!staged });
  } catch (error) {
    audit(req.user.id, 'migration_archive_refused', req, `${req.file.originalname}: ${error.message}`);
    res.status(400).json({ error: error.message });
  } finally {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch { /* the archive is going either way */ }
  }
});

app.post('/api/portability/import/:id/execute', auth, (req, res) => {
  try {
    const report = portability.executeRestore(req.params.id, req.user.id, req.body?.passphrase);
    audit(req.user.id, 'portability_restore_executed', req, JSON.stringify(report.restored));
    res.json({ ok: true, report, action: publicControlAction(actionStore.get(req.params.id)) });
  } catch (error) {
    audit(req.user.id, 'portability_restore_failed', req, error.message);
    res.status(400).json({ error: error.message, action: publicControlAction(actionStore.get(req.params.id)) });
  }
});

// ── API KEYS ─────────────────────────────────────────────────────
// Credentials for the things that are not people: a billing system creating an
// account, a monitor reading usage, a provisioning script that runs at three in
// the morning.
//
// These routes are deliberately absent from `KEY_ROUTES`, so a key cannot mint
// another key, widen itself or revoke the one that would have stopped it. Only a
// signed-in person manages keys, and only their own.
app.post('/api/keys', auth, (req, res) => {
  if (req.apiKey) return res.status(403).json({ error: req.t('A key cannot create another key.') });
  try {
    const membership = (() => { try { return ownership.getMembership(req.user.id); } catch { return null; } })();
    const issued = apiKeys.issue({
      name: req.body?.name,
      identityId: req.user.id,
      orgId: membership ? membership.orgId : null,
      capabilities: req.body?.capabilities,
      expiresAt: req.body?.expires_at || null,
      createdBy: req.user.id,
    });
    audit(req.user.id, 'api_key_issued', req, `${issued.prefix}: ${issued.name} [${issued.capabilities.join(' ')}]`);
    // The one and only time the secret exists outside the caller's hands. Named
    // the same way a generated mailbox password is, because it is the same
    // promise: shown once, kept nowhere, and the panel cannot answer for it
    // afterwards.
    const { token, ...record } = issued;
    res.json({ ok: true, key: record, deliver_once: { what: `API key ${record.name}`, token } });
  } catch (error) {
    audit(req.user.id, 'api_key_refused', req, error.message);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/keys', auth, (req, res) => {
  if (req.apiKey) return res.status(403).json({ error: req.t('A key cannot list keys.') });
  res.json({ keys: apiKeys.list(req.user.id) });
});

app.delete('/api/keys/:id', auth, (req, res) => {
  if (req.apiKey) return res.status(403).json({ error: req.t('A key cannot revoke a key.') });
  try {
    const existing = apiKeys.get(req.params.id);
    if (!existing || existing.identityId !== req.user.id) return res.status(404).json({ error: req.t('Not found') });
    const revoked = apiKeys.revoke(req.params.id, req.user.id);
    audit(req.user.id, 'api_key_revoked', req, `${revoked.prefix}: ${revoked.name}`);
    const { permits: _permits, ...record } = revoked;
    res.json({ ok: true, key: record });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── SCHEDULED JOBS ───────────────────────────────────────────────
app.get('/api/panel/jobs', auth, (req, res) => {
  try { res.json({ jobs: scheduledJobs.list(req.user.id) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/panel/jobs/:id/history', auth, (req, res) => {
  try { res.json({ runs: scheduledJobs.history(req.user.id, req.params.id, req.query.limit) }); }
  catch (error) { res.status(404).json({ error: error.message }); }
});
app.post('/api/panel/jobs/propose', auth, (req, res) => {
  try {
    const action = scheduledJobs.propose(req.user.id, req.body);
    audit(req.user.id, 'scheduled_job_proposed', req, action.label);
    res.json({ ok: true, action: publicControlAction(action) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// ── SERVER OPERATIONS ────────────────────────────────────────────
// Services, logs, databases, mail administration, sites, files, DNS and the
// firewall. Reads answer directly. Every change is a proposal on the same
// action record as the rest of the panel and executes through
// /api/control/actions/:id/execute.

// What this machine can actually do. The panel draws its tools from this and
// from nothing else, which is what stops a button existing for an operation the
// server cannot perform.
app.get('/api/panel/server/capabilities', auth, async (req, res) => {
  // Answered for whoever is asking. A report that describes only the machine
  // makes every screen decide for itself who may see it, and those decisions
  // drift away from the engine that actually refuses.
  try {
    const context = opsContext(req);
    res.json(await serverOps.surface({
      refresh: req.query.refresh === '1',
      accountId: req.user.id,
      permits: context.permits,
    }));
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/panel/server/read/:resource', auth, async (req, res) => {
  try { res.json(await serverOps.read(req.params.resource, req.query, opsContext(req))); }
  catch (error) {
    // A capability that is not installed is not a server error; it is the
    // honest answer to the question, so it reads as one. A reading this
    // account may not have is 403, the same answer the write path gives.
    res.status(error.forbidden ? 403 : error.unavailable ? 501 : 400).json({ error: error.message, unavailable: error.unavailable || null });
  }
});

// The same reads, for the two that will not fit in a query string. A migration
// preview carries a whole parsed account, and looking at somebody's old mail
// server carries the password to it, which has no business in a URL where it
// would land in an access log on the way past. Reads need no approval either
// way: this changes the method, not the rule.
app.post('/api/panel/server/read/:resource', auth, async (req, res) => {
  try { res.json(await serverOps.read(req.params.resource, req.body || {}, opsContext(req))); }
  catch (error) {
    res.status(error.forbidden ? 403 : error.unavailable ? 501 : 400).json({ error: error.message, unavailable: error.unavailable || null });
  }
});

app.post('/api/panel/server/propose', auth, async (req, res) => {
  try {
    const action = await serverOps.propose(req.user.id, req.body?.operation, req.body?.input, opsContext(req), {
      generate: req.body?.generate,
    });
    audit(req.user.id, 'server_op_proposed', req, action.label);
    res.json({ ok: true, action: publicControlAction(action) });
  } catch (error) {
    audit(req.user.id, 'server_op_proposal_refused', req, `${req.body?.operation}: ${error.message}`);
    res.status(error.forbidden ? 403 : error.unavailable ? 501 : 400).json({ error: error.message, unavailable: error.unavailable || null });
  }
});

app.get('/api/panel/server/logs/:id/download', auth, async (req, res) => {
  try {
    const file = await serverOps.logDownload(req.params.id, opsContext(req));
    audit(req.user.id, 'server_log_downloaded', req, `${file.path} (${file.sending_bytes} bytes)`);
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Content-Length': String(file.sending_bytes),
      'X-JotPanel-Log-Truncated': file.truncated ? 'tail-only' : 'complete',
    });
    file.stream().on('error', () => res.destroy()).pipe(res);
  } catch (error) { res.status(error.forbidden ? 403 : error.unavailable ? 501 : 400).json({ error: error.message }); }
});

// Send a backup somewhere else, over the connection the customer already set up
// for deploying. A copy on the same disk as the site is not a backup, and the
// cheapest way to fix that is to reuse the SFTP or FTP credentials that are
// already here, encrypted, rather than inventing a second place to keep them.
app.post('/api/panel/server/backups/send', auth, async (req, res) => {
  const { domain: dom, id, part = 'files', credentialId, remoteDir } = req.body || {};
  if (!credentialId) return res.status(400).json({ error: req.t('Choose where to send it') });
  const row = db.prepare('SELECT * FROM deploy_credentials WHERE id=? AND user_id=?').get(credentialId, req.user.id);
  if (!row) return res.status(404).json({ error: req.t('That destination is not set up') });

  let file;
  try {
    file = await serverOps.backupDownload({ domain: dom, id, part }, opsContext(req));
  } catch (error) {
    return res.status(error.forbidden ? 403 : error.unavailable ? 501 : 400).json({ error: error.message });
  }

  const password = decryptField(row.password, ENCRYPT_SECRET);
  const dir = (remoteDir || row.remote_dir || '/backups').replace(/\/+$/, '') || '/backups';
  try {
    if (row.protocol === 'sftp' || row.protocol === 'ssh') {
      const SFTPClient = require('ssh2-sftp-client');
      const sftp = new SFTPClient();
      await sftp.connect({ host: row.host, port: row.port, username: row.username, password, readyTimeout: 20000 });
      await sftp.mkdir(dir, true).catch(() => {});
      await sftp.put(file.path, `${dir}/${file.filename}`);
      // Rule 2: ask the far end how big it is rather than trusting the upload.
      const stat = await sftp.stat(`${dir}/${file.filename}`);
      await sftp.end();
      if (stat.size !== file.bytes) throw new Error(`The copy that arrived is ${stat.size} bytes and the archive is ${file.bytes}`);
    } else {
      const ftp = require('basic-ftp');
      const client = new ftp.Client(20000);
      await client.access({ host: row.host, port: row.port, user: row.username, password, secure: row.protocol === 'ftps' });
      await client.ensureDir(dir);
      await client.uploadFrom(file.path, file.filename);
      const size = await client.size(file.filename);
      client.close();
      if (size !== file.bytes) throw new Error(`The copy that arrived is ${size} bytes and the archive is ${file.bytes}`);
    }
    audit(req.user.id, 'backup_sent', req, `${file.filename} to ${row.host}${dir} (${file.bytes} bytes)`);
    res.json({ ok: true, host: row.host, path: `${dir}/${file.filename}`, bytes: file.bytes, sha256: file.sha256, verified: true });
  } catch (e) {
    audit(req.user.id, 'backup_send_failed', req, `${file.filename} to ${row.host}: ${e.message}`);
    res.status(400).json({ ok: false, error: e.message, verified: false });
  }
});

// Take the backup away. A copy that only exists on the machine it protects is
// not really a backup, so downloading it is part of the feature.
app.get('/api/panel/server/backups/download', auth, async (req, res) => {
  try {
    const file = await serverOps.backupDownload({ domain: req.query.domain, id: req.query.id, part: req.query.part || 'files' }, opsContext(req));
    audit(req.user.id, 'backup_downloaded', req, `${file.filename} (${file.bytes} bytes)`);
    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Content-Length': String(file.bytes),
      ...(file.sha256 ? { 'X-JotPanel-SHA256': file.sha256 } : {}),
    });
    // If the read fails after the headers are out there is no way to turn it
    // into an error page, so say so in the log and drop it rather than sending
    // a truncated archive somebody would trust.
    fs.createReadStream(file.path)
      .on('error', err => { audit(req.user.id, 'backup_download_failed', req, err.message); res.destroy(); })
      .pipe(res);
  } catch (error) {
    audit(req.user.id, 'backup_download_failed', req, error.message);
    res.status(error.forbidden ? 403 : error.unavailable ? 501 : 400).json({ error: error.message });
  }
});

app.post('/api/panel/server/databases/dump', auth, async (req, res) => {
  try {
    const dump = await serverOps.databaseDump({ name: req.body?.name, engine: req.body?.engine }, opsContext(req));
    audit(req.user.id, 'database_dumped', req, `${dump.name} (${dump.bytes} bytes)`);
    res.set({
      'Content-Type': 'application/sql; charset=utf-8',
      'Content-Disposition': `attachment; filename="${dump.name}.sql"`,
      'Content-Length': String(Buffer.byteLength(dump.sql, 'utf8')),
    });
    res.send(dump.sql);
  } catch (error) {
    audit(req.user.id, 'database_dump_failed', req, error.message);
    res.status(error.forbidden ? 403 : error.unavailable ? 501 : 400).json({ error: error.message });
  }
});

// A dump is held on disk until its import is approved, so the file the owner
// approved is the file that runs.
const dumpUpload = multer({ storage, limits: { fileSize: 256 * 1024 * 1024, files: 1 } });
app.post('/api/panel/server/databases/upload', auth, uploadLimiter, dumpUpload.single('dump'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: req.t('An .sql dump file is required.') });
  try {
    if (!/\.sql$/i.test(req.file.originalname || '')) throw new Error('The file must be a .sql dump');
    const held = serverOps.acceptDumpUpload(req.user.id, req.file.path, req.file.originalname);
    audit(req.user.id, 'database_dump_uploaded', req, `${held.filename} (${held.bytes} bytes)`);
    res.json({ ok: true, upload: held });
  } catch (error) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: error.message });
  }
});

// ── A site's files, in and out ───────────────────────────────────
// Neither direction can be done by this process alone. It cannot read a site
// tree, and anything it wrote there would belong to the panel rather than the
// site, so a file crosses through a staging directory both halves can reach.
// The upload lands staged and is only placed once the change is approved, so
// the file the owner approved is the file that arrives.
const siteUpload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } });
app.post('/api/panel/server/site-files/upload', auth, uploadLimiter, siteUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: req.t('A file is required.') });
  try {
    const slot = await serverOps.read('staging-reserve', {}, opsContext(req));
    fs.copyFileSync(req.file.path, slot.path);
    fs.unlinkSync(req.file.path);
    audit(req.user.id, 'site_file_staged', req, `${req.file.originalname} (${req.file.size} bytes)`);
    res.json({ ok: true, staged: slot.id, name: req.file.originalname, bytes: req.file.size });
  } catch (error) {
    try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    res.status(error.unavailable ? 501 : 400).json({ error: error.message });
  }
});

app.get('/api/panel/server/site-files/download', auth, async (req, res) => {
  let staged = null;
  try {
    const file = await serverOps.read('site-file-stage', { domain: req.query.domain, path: req.query.path }, opsContext(req));
    staged = file.id;
    const source = file.staged_path;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(file.size_bytes));
    // The name is quoted and stripped of anything that could break the header
    // or name a path, because it comes off a filesystem the owner controls.
    res.setHeader('Content-Disposition', `attachment; filename="${String(file.name).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    audit(req.user.id, 'site_file_downloaded', req, `${req.query.domain}:${req.query.path}`);
    const stream = fs.createReadStream(source);
    stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: req.t('The file could not be read.') }); else res.destroy(); });
    stream.on('close', () => { serverOps.read('staging-discard', { staged }, opsContext(req)).catch(() => {}); });
    stream.pipe(res);
  } catch (error) {
    if (staged) serverOps.read('staging-discard', { staged }, opsContext(req)).catch(() => {});
    res.status(error.unavailable ? 501 : 400).json({ error: error.message });
  }
});

// ── REGISTRATION / THINKING-SERVICE LICENCE ──────────────────────
// Registration belongs to the installation, not to an account on it, and there
// is exactly one registration row on a box. Both of these were open to anybody
// signed in, which meant a customer could read the hoster's registered address
// and licence state, and, worse, could re-register the whole machine under
// their own address: the register call upserts the single row, so the last
// person to call it owns the installation's licence identity. It is the
// operator's, so it is asked of the operator.
app.get('/api/license', operatorOnly, async (req, res) => {
  const state = req.query.refresh === '1' ? await licenseClient.validate({ force: true }) : licenseClient.localStatus();
  res.json(state);
});
app.post('/api/license/register', operatorOnly, async (req, res) => {
  try {
    const state = await licenseClient.register({
      email: req.body?.email,
      newsletterOptIn: req.body?.newsletter_opt_in === true,
      consentText: req.body?.consent_text || 'We will email you about software updates and news, and you can stop that whenever you like.',
    });
    audit(req.user.id, 'panel_registered', req, `${state.email}; newsletter=${state.newsletter_opt_in ? 'yes' : 'no'}`);
    res.status(201).json(state);
  } catch (error) {
    audit(req.user.id, 'panel_registration_failed', req, error.message);
    res.status(400).json({ error: error.message });
  }
});

// ── USAGE FEED ───────────────────────────────────────────────────
app.get('/api/usage', auth, (req, res) => {
  try {
    const report = usageService.reportForAccount(req.user.id, { period: req.query.period, from: req.query.from, to: req.query.to });
    if (req.query.format === 'csv') {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="jotpanel-usage-${report.period.from.slice(0,10)}.csv"` });
      return res.send(usageService.toCsv([report]));
    }
    res.json(report);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// ── PANEL READ MODEL ─────────────────────────────────────────────
app.get('/api/panel/sites', auth, async (req, res) => {
  const sites = db.prepare('SELECT id,name,domain,status,created_at,updated_at FROM sites WHERE user_id=? ORDER BY name').all(req.user.id);
  res.json({ sites: await siteCertificateHealth(sites) });
});

app.get('/api/panel/statistics', auth, async (req, res) => {
  try {
    const domains = siteOwnershipByIdentity({ db }).domainsByIdentity.get(req.user.id) || [];
    const selected = req.query.siteId ? domains.filter(domain => domain === req.query.siteId) : domains;
    const ingestion = [];
    for (const domain of selected) {
      // One site the reader cannot handle must not blank the page for every
      // other one. A name that is not a name is reported against that site and
      // the rest are still counted — the alternative, which this replaces, was
      // a single odd entry returning 400 and the whole screen showing nothing.
      try {
        const candidates = siteAccessLogPaths(domain);
        const logPath = candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
        ingestion.push(await statisticsService.ingestAccessLog({ userId: req.user.id, siteId: domain, siteName: domain, path: logPath }));
      } catch (error) {
        ingestion.push({ ok: false, path: '', added: 0, reason: req.t('Traffic for {site} cannot be counted: {why}', { site: domain || '(unnamed)', why: error.message }) });
      }
    }
    res.json(statisticsService.report(req.user.id, { siteId: req.query.siteId || null, days: req.query.days || 30, ingestion }));
  }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/local-engine/security', auth, async (req, res) => res.json(await localEngineSecurity.check({ force: req.query.refresh === '1' })));
app.post('/api/local-engine/security/propose-fix', auth, (req, res) => {
  const action = localEngineSecurity.proposeFix(req.user.id);
  audit(req.user.id, 'local_engine_fix_proposed', req, action.id);
  res.json({ ok: true, action: publicControlAction(action) });
});

app.get('/api/panel/overview', auth, async (req, res) => {
  try {
    const [siteData, engine] = await Promise.all([
      siteCertificateHealth(db.prepare('SELECT id,name,domain,status,updated_at FROM sites WHERE user_id=? ORDER BY name').all(req.user.id)),
      localEngineSecurity.check(),
    ]);
    const jobs = scheduledJobs.list(req.user.id);
    const usage = usageService.reportForAccount(req.user.id, {});
    const actions = actionStore.list({ userId: req.user.id, limit: 20 });
    const pending = actions.filter(a => a.status === 'pending' || a.status === 'approved').length;
    res.json({
      checked_at: new Date().toISOString(),
      owner: db.prepare('SELECT name,email,plan,storage_gb,created_at FROM users WHERE id=?').get(req.user.id),
      // The domains this account may act on. Without this the panel asks for a
      // mailbox address while keeping the list of acceptable domains secret,
      // and the first thing a new owner sees is a scope rejection.
      scope: (() => { const s = buildProvisioningAccountContext(req.user.id); return { primaryDomain: s.primaryDomain, domains: s.domains }; })(),
      sites: siteData,
      jobs: { total: jobs.length, enabled: jobs.filter(j => j.enabled).length, failed: jobs.filter(j => j.lastRun?.status === 'failed' || j.lastRun?.status === 'timed_out').length },
      usage,
      license: licenseClient.localStatus(),
      local_engine: engine,
      actions: { pending, recent: actions.map(publicControlAction) },
      health: {
        certificates_attention: siteData.filter(s => !['healthy','not_configured'].includes(s.certificate.status)).length,
        failed_actions: actions.filter(a => a.status === 'failed').length,
      },
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/deploy/credentials — list saved connections (no passwords returned)
app.get('/api/deploy/credentials', auth, (req, res) => {
  const rows = db.prepare('SELECT id,label,protocol,host,port,username,remote_dir,created_at FROM deploy_credentials WHERE user_id=?').all(req.user.id);
  res.json(rows);
});

// POST /api/deploy/credentials — save a new connection
app.post('/api/deploy/credentials', auth, (req, res) => {
  const { label, protocol = 'sftp', host, port = 22, username, password, remote_dir = '/public_html' } = req.body;
  if (!label || !host || !username) return res.status(400).json({ error: req.t('label, host and username required') });
  const id  = uid();
  const enc = encryptField(password || '', ENCRYPT_SECRET);
  db.prepare('INSERT INTO deploy_credentials (id,user_id,label,protocol,host,port,username,password,remote_dir,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, label, protocol, host, parseInt(port), username, enc, remote_dir, new Date().toISOString());
  audit(req.user.id, 'deploy_credential_saved', req, host);
  res.json({ ok: true, id });
});

// DELETE /api/deploy/credentials/:id
app.delete('/api/deploy/credentials/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM deploy_credentials WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: req.t('Not found') });
  db.prepare('DELETE FROM deploy_credentials WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/deploy/test — test a connection without saving
app.post('/api/deploy/test', auth, async (req, res) => {
  const { protocol = 'sftp', host, port = 22, username, password } = req.body;
  if (!host || !username) return res.status(400).json({ error: req.t('host and username required') });
  try {
    if (protocol === 'sftp' || protocol === 'ssh') {
      const SFTPClient = require('ssh2-sftp-client');
      const sftp = new SFTPClient();
      await sftp.connect({ host, port: parseInt(port), username, password, readyTimeout: 8000 });
      await sftp.end();
    } else {
      const ftp = require('basic-ftp');
      const client = new ftp.Client(8000);
      await client.access({ host, port: parseInt(port), user: username, password, secure: protocol === 'ftps' });
      client.close();
    }
    res.json({ ok: true, message: 'Connection successful' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// POST /api/deploy/upload — deploy HTML to server
app.post('/api/deploy/upload', auth, async (req, res) => {
  const { credentialId, html, filename = 'index.html' } = req.body;
  if (!credentialId || !html) return res.status(400).json({ error: req.t('credentialId and html required') });

  const row = db.prepare('SELECT * FROM deploy_credentials WHERE id=? AND user_id=?').get(credentialId, req.user.id);
  if (!row) return res.status(404).json({ error: req.t('Credential not found') });

  const password  = decryptField(row.password, ENCRYPT_SECRET);
  const remoteDir = row.remote_dir || '/public_html';

  try {
    if (row.protocol === 'sftp' || row.protocol === 'ssh') {
      const SFTPClient = require('ssh2-sftp-client');
      const sftp = new SFTPClient();
      await sftp.connect({ host: row.host, port: row.port, username: row.username, password, readyTimeout: 15000 });
      // Ensure remote dir exists
      await sftp.mkdir(remoteDir, true).catch(() => {});
      await sftp.put(Buffer.from(html, 'utf8'), `${remoteDir}/${filename}`);
      await sftp.end();
    } else {
      const ftp = require('basic-ftp');
      const client = new ftp.Client(15000);
      await client.access({ host: row.host, port: row.port, user: row.username, password, secure: row.protocol === 'ftps' });
      await client.ensureDir(remoteDir);
      const { Readable } = require('stream');
      const stream = Readable.from([html]);
      await client.uploadFrom(stream, filename);
      client.close();
    }

    audit(req.user.id, 'deploy_upload', req, `${row.host}${remoteDir}/${filename}`);
    res.json({ ok: true, url: `https://${row.host}/${filename === 'index.html' ? '' : filename}`, host: row.host, path: `${remoteDir}/${filename}` });
  } catch (e) {
    console.error('[deploy]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/platform/config — reseller branding (public, no auth needed).
// The public shape is whitelisted: the full row holds the host's platform AI
// key and markup, which must never reach a client. The admin key gets the
// full row so the Admin panel can edit it.
app.get('/api/platform/config', (req, res) => {
  const row = db.prepare("SELECT data FROM routing_table WHERE id=2").get();
  let cfg = { label: 'Hosted AI' };
  if (row) { try { cfg = JSON.parse(row.data); } catch {} }
  // The full settings went only to a caller holding the shared key, so the
  // operator's own console, which signs in as a person, was shown a markup of
  // zero and "no platform key set" no matter what was really configured. The
  // operator is the account that runs the box; being that account is a better
  // answer than holding a password, so it is accepted here too.
  // The shared key used to be accepted here too, and is not any more: this is
  // the operator's own settings, the operator is a signed-in identity, and a
  // key that could read them from anywhere on the internet was a second answer
  // to a question that already had one.
  if (operatorRequest(req)) {
    // The name this panel answers on. It lives in the environment because the
    // installer put it there, which meant the only way to see it was to read a
    // file on the box — and the only way to change it was to reinstall. It is
    // the operator's own setting, and this is the operator's own settings
    // route, so it belongs here rather than in a route of its own.
    return res.json({ ...cfg, platformKey: !!cfg.platformKey, panelDomain: DOMAIN, deployPushEnabled: DEPLOY_PUSH_ENABLED });
  }
  res.json({ label: cfg.label || 'Hosted AI', byok: cfg.byok !== false, deployPushEnabled: DEPLOY_PUSH_ENABLED });
});

// PATCH /api/platform/config — admin sets reseller branding + platform AI key
app.patch('/api/platform/config', (req, res) => {
  // Identity only. The shared key was accepted here as well, which meant the
  // platform key, the markup and the branding could be rewritten from anywhere
  // by anybody holding it, and the audit line below could not name who did it
  // because there was nobody to name.
  const operator = operatorRequest(req);
  if (!operator) return res.status(403).json({ error: req.t('Forbidden') });
  // Merged rather than replaced. This wrote whatever body arrived straight over
  // the row, so saving a label from a screen that does not show the platform
  // key deleted the platform key, and the only sign of it would have been AI
  // calls failing some time later for an unrelated-looking reason.
  const row = db.prepare("SELECT data FROM routing_table WHERE id=2").get();
  let current = {};
  if (row) { try { current = JSON.parse(row.data) || {}; } catch { current = {}; } }
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  // The one field here that decides whether strangers may open accounts. A
  // value this route does not recognise is refused rather than stored, because
  // `registrationMode` reads anything it does not recognise as closed and a
  // hoster who typed "open" would be told it saved and get the opposite.
  if (incoming.registrationMode !== undefined && !REGISTRATION_MODES.has(incoming.registrationMode)) {
    return res.status(400).json({ error: `registrationMode must be one of ${[...REGISTRATION_MODES].join(', ')}` });
  }
  // The switch that separates the free panel from the tier the host charges
  // for. `assistantOpsPolicy` reads anything it does not recognise as OFF, so
  // a host who sent the wrong shape would be told it saved and would get the
  // opposite, which is the same trap registrationMode is guarded against
  // above. Refuse it here rather than store it.
  if (incoming.assistantOps !== undefined) {
    const a = incoming.assistantOps;
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return res.status(400).json({ error: req.t('assistantOps must be an object with enabled and an optional list of plans') });
    }
    if (typeof a.enabled !== 'boolean') {
      return res.status(400).json({ error: req.t('assistantOps.enabled must be true or false') });
    }
    if (a.plans !== undefined && (!Array.isArray(a.plans) || a.plans.some(p => typeof p !== 'string'))) {
      return res.status(400).json({ error: req.t('assistantOps.plans must be a list of plan names, or left out to mean every plan') });
    }
    incoming.assistantOps = { enabled: a.enabled, ...(a.plans ? { plans: a.plans } : {}) };
  }
  const merged = { ...current, ...incoming };
  db.prepare('INSERT OR REPLACE INTO routing_table (id,data,updated) VALUES (2,?,?)')
    .run(JSON.stringify(merged), new Date().toISOString());
  if (operator) audit(operator, 'platform_config_changed', req, Object.keys(incoming).join(', ') || 'no fields');
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// ECHO — server-side brain. Routing, system prompts, model pricing and
// provider keys live here and never ship to the browser. This is the
// single most important source-protection step (see docs/ARCHITECTURE.md)
// and it is what lets AI spend be metered and capped per customer.
// ══════════════════════════════════════════════════════════════════

// Usage ledger — the authoritative record of AI spend, replaces the old
// browser localStorage cost store so caps can actually be enforced.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    id       TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL,
    ts       TEXT DEFAULT (datetime('now')),
    provider TEXT,
    model    TEXT,
    in_tok   INTEGER DEFAULT 0,
    out_tok  INTEGER DEFAULT 0,
    cost     REAL DEFAULT 0,
    byok     INTEGER DEFAULT 0,
    task     TEXT,
    preview  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_user_ts ON ai_usage (user_id, ts);
`);
// Decision 5: the usage log keeps no words. `preview` holds the kind of work,
// the length and a short hash. Rows written before this carried the first 80
// characters of what the person typed, a pasted key included, so those are
// replaced here once.
function usageLabel(kind, text) {
  const words = String(text || '');
  return `${kind || 'chat'} · ${words.length} chars · ${crypto.createHash('sha256').update(words).digest('hex').slice(0, 12)}`;
}
{
  const raw = db.prepare("SELECT rowid AS r, task, preview FROM ai_usage WHERE preview IS NOT NULL AND preview <> '' AND preview NOT LIKE '% chars · %'").all();
  if (raw.length) {
    const write = db.prepare('UPDATE ai_usage SET preview=? WHERE rowid=?');
    db.transaction(rows => { for (const row of rows) write.run(`${row.task || 'chat'} · earlier words removed`, row.r); })(raw);
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* the next checkpoint does it */ }
    console.log(`[usage] removed the words from ${raw.length} older usage rows`);
  }
}

// Performance columns on ai_usage, added in place so an existing deployment
// keeps its ledger. The cost columns above answer "what did this spend"; these
// answer "was it fast, and if not what was in the way", which is what the admin
// analytics centre reads to spot a pool running out of room before customers
// start complaining. Idempotent: SQLite has no ADD COLUMN IF NOT EXISTS, so the
// duplicate-column error is the expected no-op on every boot after the first.
for (const col of [
  'ttft_ms INTEGER',      // time to first token, the number a user actually feels
  'dur_ms INTEGER',       // whole request
  'gen_tps REAL',         // output tokens per second achieved on this call
  'endpoint TEXT',        // which inference endpoint served it
  'accel TEXT',           // gpu | cpu | frontier
  'concurrent INTEGER',   // in-flight AI requests when this one started
]) {
  try { db.exec(`ALTER TABLE ai_usage ADD COLUMN ${col}`); } catch { /* already there */ }
}

// In-flight counter. Recorded per request so the analytics centre can separate
// "the model is slow" from "the model is busy", which look identical in a
// latency graph and call for completely different fixes: a bigger card versus
// another card.
let AI_INFLIGHT = 0;


// Additive column migration. CREATE TABLE IF NOT EXISTS silently does nothing
// to a table that already exists, so a column added after a box has run once
// would never appear there. Adding is safe and never touches existing rows.
function addColumnIfMissing(table, column, definition) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.length || cols.some(c => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] added ${table}.${column}`);
  } catch (e) { console.error('[db] migration failed', table, column, e.message); }
}

// The workspace's public state, recorded on the vault row the file already has.
//
// There is deliberately no `state` column. A state stored as a column is a state
// that can disagree with the disk, and the disagreement is silent and permanent:
// a copy that failed to delete leaves a row saying private and a file on the open
// internet. So the state is derived by `workspaceStorage.stateOf` from the facts
// underneath it, and these columns are those facts rather than a summary of them.
// Public means there is a copy recorded in a named document root; shared will
// mean there is an unexpired link, which arrives with share links; private is
// what everything else means, including a row somebody has corrupted.
//
// Existing rows get NULL in all four, which reads as private, which is what every
// file on every box already is.
addColumnIfMissing('files', 'published_domain', 'TEXT');
addColumnIfMissing('files', 'published_path', 'TEXT');
addColumnIfMissing('files', 'published_at', 'TEXT');
addColumnIfMissing('files', 'published_by', 'TEXT');

// Trash. Deleting sets this and removes nothing, because a desktop that loses a
// file the moment you press Delete is a desktop nobody trusts. Emptying the
// Trash is the removal and it is the only thing in this product that cannot be
// undone, which is why it is the only thing that asks first.
//
// A NULL here means the file is not in the Trash, which is what every existing
// row on every box already is.
addColumnIfMissing('files', 'deleted_at', 'TEXT');

// Provider transport metadata. The platform key for each provider comes
// from a server-only env var, so it is never in the shipped bundle.
//
// `region` is where the inference actually happens, and it is surfaced in the
// UI on purpose. It is the sub-processor disclosure a GDPR buyer is owed and it
// is the thing a public-sector or EU tenant screens on, so a provider list that
// hides it is worse than useless. One flat list with a jurisdiction tag, not
// three regional bundles — the UI groups on this field.
const PROVIDERS_META = {
  anthropic: { kind: 'anthropic', base: 'https://api.anthropic.com/v1/messages',                       envKey: 'ANTHROPIC_API_KEY', region: 'US' },
  openai:    { kind: 'openai',    base: 'https://api.openai.com/v1/chat/completions',                   envKey: 'OPENAI_API_KEY',    region: 'US' },
  groq:      { kind: 'openai',    base: 'https://api.groq.com/openai/v1/chat/completions',              envKey: 'GROQ_API_KEY',      region: 'US' },
  gemini:    { kind: 'openai',    base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', envKey: 'GEMINI_API_KEY', region: 'US' },
  mistral:   { kind: 'openai',    base: 'https://api.mistral.ai/v1/chat/completions',                   envKey: 'MISTRAL_API_KEY',   region: 'EU' },
  // Asia-hosted frontiers. Open-weight houses, OpenAI-compatible transport, so
  // they need no adapter of their own. BYOK by default: a host that wants to
  // sell one of these on its own key should read the note in MODEL_PRICING
  // first, and no tenant with EU data-residency terms should be pointed here.
  deepseek:  { kind: 'openai',    base: 'https://api.deepseek.com/v1/chat/completions',                 envKey: 'DEEPSEEK_API_KEY',  region: 'CN' },
  moonshot:  { kind: 'openai',    base: 'https://api.moonshot.ai/v1/chat/completions',                  envKey: 'MOONSHOT_API_KEY',  region: 'CN' },
  zhipu:     { kind: 'openai',    base: 'https://api.z.ai/api/paas/v4/chat/completions',                 envKey: 'ZHIPU_API_KEY',     region: 'CN' },
  // xAI speaks the OpenAI chat-completions shape, so it needs no adapter of its
  // own. Their Responses API is the direction of travel and chat-completions is
  // documented as its predecessor; when that is retired this entry changes, not
  // the transport everything else uses.
  xai:       { kind: 'openai',    base: 'https://api.x.ai/v1/chat/completions',                          envKey: 'XAI_API_KEY',       region: 'US' },
  ollama:    { kind: 'openai',    base: process.env.OLLAMA_BASE || 'http://localhost:11434/v1/chat/completions', envKey: null, local: true, region: 'local' },
  // The user's own machine, reached over a link it dialled out on. `local`
  // because the inference costs nobody anything and no key exists, `device`
  // because it is emphatically NOT this box: the endpoint is a link rather than
  // a URL, so everything that treats a local provider as "the Ollama on this
  // server" has to ask this flag first.
  byog:      { kind: 'byog',      base: null, envKey: null, local: true, device: true, region: 'device' },
};

// Model pricing — $ per million tokens [input, output]. Authoritative copy.
const MODEL_PRICING = {
  'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-6': [5, 25], 'claude-opus-4-5': [5, 25],
  'claude-sonnet-5': [3, 15], 'claude-sonnet-4-6': [3, 15], 'claude-sonnet-4-5': [3, 15],
  'claude-haiku-4-5-20251001': [1, 5], 'claude-haiku-4-5': [1, 5],
  'gpt-4o': [2.5, 10], 'gpt-4o-mini': [0.15, 0.6], 'gpt-4-turbo': [10, 30], 'o1-mini': [1.1, 4.4],
  'llama-3.3-70b-versatile': [0.59, 0.79], 'llama-3.1-70b-versatile': [0.59, 0.79],
  'mixtral-8x7b-32768': [0.24, 0.24], 'gemma2-9b-it': [0.2, 0.2],
  'gemini-2.0-flash': [0.1, 0.4], 'gemini-1.5-pro': [1.25, 5], 'gemini-1.5-flash': [0.075, 0.3],
  'mistral-large-latest': [2, 6], 'mistral-medium-latest': [0.4, 2], 'open-mixtral-8x22b': [2, 6],
  // Asia-hosted frontiers (Aug 2026 list rates). These are here so the cost
  // widget does not fall through to the ~Sonnet fallback below and overstate a
  // DeepSeek call by twenty times. Rates move fast and none of these are
  // contractual — re-check before a host sells any of them on a platform key.
  'deepseek-chat': [0.14, 0.28], 'deepseek-reasoner': [0.435, 0.87],
  'kimi-k3': [3, 15], 'kimi-k2.6': [0.95, 4], 'kimi-k2.5': [0.6, 3],
  'glm-5.2': [1.4, 4.4], 'glm-4.7': [0.6, 2.2], 'glm-4.7-flash': [0, 0],
  'llama3.2': [0, 0], 'mistral': [0, 0], 'codellama': [0, 0], 'phi3': [0, 0],
};
// The catalogue is asked first, because it is the copy an operator can correct
// without waiting for us to cut a release. MODEL_PRICING below it is the
// shipped fallback for the providers the catalogue does not cover yet, and for
// ids a customer's key reports that nobody has documented.
//
// The old fallback quietly billed every unknown model at a Sonnet-ish rate,
// which is a number invented about somebody else's money. An unknown model now
// costs nothing in the meter and says so, rather than being charged a guess.
function calcCost(model, inTok, outTok, providerId = null) {
  let price = null;
  if (providerId) {
    const fromCatalogue = modelCatalogue.priceOf(providerId, model);
    if (fromCatalogue) price = [fromCatalogue.input, fromCatalogue.output];
  }
  if (!price) {
    for (const id of modelCatalogue.providerIds()) {
      const found = modelCatalogue.priceOf(id, model);
      if (found) { price = [found.input, found.output]; break; }
    }
  }
  if (!price && MODEL_PRICING[model]) price = MODEL_PRICING[model];
  if (!price) return 0;
  return (inTok / 1e6) * price[0] + (outTok / 1e6) * price[1];
}

// Cost-aware default routing — mechanical work to cheap/local models,
// frontier models only on the judgement tasks. Overridable per-deploy via
// the routing_table (id=1) and per-task by a user override sent in the body.
// Defaults come from the Resident's role table (control/residentGateway.js),
// shown here under the task names the panel already uses.
const DEFAULT_ROUTES = Object.fromEntries(Object.entries(TASK_ROLE).map(([task, role]) => [task, ROLE_ROUTES[role]]));
function hostRoutes() {
  const row = db.prepare('SELECT data FROM routing_table WHERE id=1').get();
  if (!row) return {};
  try { const r = JSON.parse(row.data); return r && typeof r === 'object' ? r : {}; }
  catch { return {}; }
}
function liveRoutes() {
  return { ...DEFAULT_ROUTES, ...hostRoutes() };
}

// The Resident — detect the local Ollama and whatever models are pulled, so
// the free brain works on any box (this machine, a self-host, a server we
// point at) without hardcoding model names. Cached briefly; degrades cleanly
// to "not available" when no Ollama is running, which is when Echo asks for a
// key. A coder model is preferred for code/build, a general model for chat.
// There can be two Residents. A rented GPU pod is up only while a booked demo
// slot is running, and the CPU on this box is up always, so the rule is GPU
// when one answers and CPU the rest of the time, decided by probe rather than
// by hand. `JOTPANEL_GPU_OLLAMA_BASE` names the pod and unset means CPU only.
const CPU_OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434/v1/chat/completions';
const GPU_OLLAMA_BASE = (process.env.JOTPANEL_GPU_OLLAMA_BASE ?? process.env.ARCA_GPU_OLLAMA_BASE) || null;
// A configured-but-absent pod is the normal case between bookings, so back off
// after a miss instead of paying the probe timeout on one request every 30s.
let _gpuProbeSkipUntil = 0;

let _residentCache = { ts: 0, data: { available: false, models: [], chatModel: null, codeModel: null } };
async function getResident() {
  const now = Date.now();
  if (now - _residentCache.ts < 30000) return _residentCache.data;
  let data = { available: false, models: [], chatModel: null, codeModel: null };

  const engineSecurity = await localEngineSecurity.check();
  if (!engineSecurity.usable) {
    data.security = engineSecurity;
    _residentCache = { ts: now, data };
    return data;
  }

  const candidates = [];
  if (GPU_OLLAMA_BASE && now >= _gpuProbeSkipUntil) candidates.push({ base: GPU_OLLAMA_BASE, accel: 'gpu' });
  candidates.push({ base: CPU_OLLAMA_BASE, accel: 'cpu' });

  for (const cand of candidates) {
    try {
      const root = cand.base.replace(/\/v1\/.*$/, '');
      const res = await fetch(root + '/api/tags', { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const j = await res.json();
        // qwen2.5:3b is Qwen Research License (non-commercial) and must never be
        // selected in a sold product, even as a last-resort fallback — excluded
        // at detection time so no downstream picker can reach it.
        const models = (j.models || []).map(m => m.name).filter(n => n && !/embed/i.test(n) && !/qwen2\.5:3b/i.test(n));
        if (models.length) {
          const isVision = n => /vl|llava|vision|moondream|bakllava|gemma3|minicpm/i.test(n);
          const isCoder  = n => /coder|code/i.test(n);
          // Chat wants a plain general model — a vision model runs slower for pure
          // text, so only fall back to one if nothing else is pulled.
          const chatModel = models.find(n => !isCoder(n) && !isVision(n)) || models.find(n => !isCoder(n)) || models[0];
          const codeModel = models.find(isCoder) || chatModel;
          const visionModel = models.find(isVision) || null;
          data = { available: true, models, chatModel, codeModel, visionModel, accel: cand.accel, base: cand.base };
        }
      }
    } catch {}
    if (data.available) break;
    if (cand.accel === 'gpu') _gpuProbeSkipUntil = now + 60000;
  }

  // Point every downstream caller at whichever endpoint answered. Both
  // callProvider and warmResident read this at call time, so the switch costs
  // one assignment and no plumbing. A change of endpoint means the new one has
  // never seen the concierge prefix, so re-warm it rather than letting the next
  // visitor pay the prefill.
  const prevBase = PROVIDERS_META.ollama.base;
  if (data.available && data.base) PROVIDERS_META.ollama.base = data.base;
  const switched = data.available && data.base && data.base !== prevBase;

  _residentCache = { ts: now, data };
  if (switched) {
    console.log(`[ai] Local model endpoint switched to ${data.accel.toUpperCase()} (${data.base})`);
    warmResident().catch(() => {});
  }
  return data;
}

// Keep the Resident warm. Ollama unloads a model after ~5 minutes idle, which
// makes the first message pay a multi-second cold load. Preload the chat model
// with a long keep_alive at boot and refresh it on a timer, so Echo answers at
// full speed the moment someone talks to it. The coder model loads on demand.
const OLLAMA_KEEP_ALIVE = (process.env.JOTPANEL_OLLAMA_KEEP_ALIVE ?? process.env.ARCA_OLLAMA_KEEP_ALIVE) || '2h';
async function warmResident() {
  if ((process.env.JOTPANEL_THINKING_URL ?? process.env.ARCA_THINKING_URL)) return;
  const r = await getResident();
  if (!r.available || !r.chatModel) return;
  const root = PROVIDERS_META.ollama.base.replace(/\/v1\/.*$/, '');
  try {
    // Loading the weights is only half the warm-up. The concierge's system
    // prompt carries the whole knowledge base, and prefilling that is the
    // expensive part on CPU: measured 2026-08-11 on the 6-core OVH box, a
    // ~3,000-token KB costs 161s of prefill on qwen2.5:7b, 39s on 1.5b. Once
    // Ollama has that exact prefix cached the same request answers in ~0.6s.
    //
    // So warm with the real concierge prompt, not an empty one. Every visitor
    // shares this prefix, which is what makes priming it worth doing: the cold
    // cost is paid once here at boot instead of by whoever arrives first.
    // The prompt must match byte for byte or the cache will not hit, hence
    // calling buildSystemPrompt rather than approximating it.
    const system = buildSystemPrompt('concierge', { demo: 'try' });
    await fetch(root + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: r.chatModel,
        system,
        prompt: 'hello',
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { num_predict: 1 },   // prefill is the point; generation is not
      }),
    });
    console.log(`[ai] Local model warmed: ${r.chatModel} + concierge prefix (~${Math.round(system.length / 4)} tok, keep_alive ${OLLAMA_KEEP_ALIVE})`);
  } catch {}
}
warmResident();
setInterval(warmResident, 20 * 60 * 1000).unref();

// Resolve a usable key for a provider. A caller's own key wins when present,
// so bringing your own key uses it (uncapped, and keeps data off the platform
// key) — the platform env key is the fallback for users who have not. Returns
// null if neither exists.
function resolveKey(providerId, byok) {
  const meta = PROVIDERS_META[providerId];
  if (!meta) return null;
  // A device is never resolved by the generic paths. Every other provider in
  // this map answers on a URL that is the same for everybody, so "does it have
  // a key" is the whole question. A device has an owner, a link that may be
  // down and a list of models it actually holds, so it is chosen deliberately
  // in routeForTask and nowhere else. Without this line the loop that finds a
  // provider for an explicit model would hand any model name at all to
  // somebody's laptop, because a local provider always looks keyed.
  if (meta.device) return null;
  if (meta.local) return { key: '', source: 'platform' };
  const userKey = byok && byok[providerId] && byok[providerId].key;
  if (userKey) return { key: userKey, source: 'byok', fingerprint: byok[providerId].fingerprint || null };
  const envKey = meta.envKey && process.env[meta.envKey];
  if (envKey) return { key: envKey, source: 'platform' };
  return null;
}

// The keys a person actually holds, read from the vault rather than from a
// settings blob. Shaped like the `byok` map the router already speaks so that
// nothing downstream has to know where a key came from.
function storedByok(userId) {
  const routes = storedByokRoutes(userId);
  const out = {};
  for (const [providerId, keys] of Object.entries(routes)) {
    if (keys[0]) out[providerId] = { key: keys[0].key };
  }
  return out;
}

// The chat path also needs the later keys, kept beside their safe
// fingerprints. This is server-only; storedByok deliberately retains the old
// one-key shape used by every existing caller.
function storedByokRoutes(userId) {
  const out = {};
  if (!userId) return out;
  const scope = { kind: 'identity', id: userId };
  for (const providerId of new Set(providerKeys.list(scope).map(row => row.provider_id))) {
    const found = providerKeys.resolveAll(providerId, [scope], { markUsed: false });
    out[providerId] = found.filter(item => item && item.key).map(item => ({
      key: item.key, fingerprint: item.fingerprint, label: item.label,
    }));
  }
  return out;
}

// Pick provider + model for a task, honouring an explicit model, a per-task
// user override, then the routing table, then any provider that has a key.
function routeForTask(task, opts = {}) {
  const byok = opts.byok || {};
  // Routes that already failed this turn are not offered again.
  const skip = opts.exclude || new Set();
  const tryPair = (pid, mid) => {
    if (skip.has(`${pid}/${mid}`)) return null;
    const got = resolveKey(pid, byok);
    if (got) return { providerId: pid, model: mid, key: got.key, source: got.source, ...(got.fingerprint ? { keyFingerprint: got.fingerprint } : {}) };
    return null;
  };
  // The caller has already asked the byog service which of this person's
  // machines is online and which model on it fits the work. What arrives here
  // is a decision, not a lookup, so this function stays a router.
  const pick = opts.byogPick || null;
  const deviceRoute = (model) => {
    if (!pick || !pick.device || !pick.model) return null;
    const chosen = model || pick.model;
    // A model named explicitly has to be one the machine actually holds, or the
    // job would be dispatched for weights that are not there.
    if (model && !(pick.device.models || []).some(m => m.name === model)) return null;
    if (skip.has(`byog/${chosen}`)) return null;
    return {
      providerId: 'byog', model: chosen, key: '', source: 'device',
      byog: { deviceId: pick.device.id, name: pick.device.name },
    };
  };

  // Explicit provider (Direct Chat forces one) — use it if it has a key.
  if (opts.providerId === 'byog') return deviceRoute(opts.model);
  if (opts.providerId && opts.model) {
    const hit = tryPair(opts.providerId, opts.model);
    if (hit) return hit;
  }
  // Explicit model wins — find a provider that lists it and has a key.
  if (opts.model) {
    for (const pid of Object.keys(PROVIDERS_META)) {
      const hit = tryPair(pid, opts.model);
      if (hit) return hit;
    }
  }
  // Per-task user override { task: { providerId, modelId } }
  const ov = opts.override && opts.override[task];
  if (ov && ov.providerId === 'byog') {
    const hit = deviceRoute(ov.modelId || null);
    if (hit) return hit;
  } else if (ov && ov.providerId) {
    const hit = tryPair(ov.providerId, ov.modelId || opts.model);
    if (hit && hit.model) return hit;
  }

  // The user's own machine, before the routing table, for the work the table
  // was already sending to the cheapest capable model. `byogFirst` is the byog
  // service's own judgement (see byog.preferBefore): mechanical work runs on
  // free hardware the user already owns, and the judgement tasks the table
  // escalates keep escalating. A device is never automatically better than
  // everything else just because it is connected.
  if (opts.byogFirst) {
    const hit = deviceRoute(null);
    if (hit) return hit;
  }

  // How models have done this kind of work for this account moves a failing
  // one down; it never adds a candidate the lists above did not allow.
  const prefs = opts.accountId && routingFit
    ? routingFit.order(opts.accountId, TASK_ROLE[task] || 'chat', candidatesFor(task, hostRoutes()), ([pid, mid]) => `${pid}/${mid}`)
    : candidatesFor(task, hostRoutes());
  for (const [pid, mid] of prefs) {
    const hit = tryPair(pid, mid);
    if (hit) return hit;
  }

  // Nothing keyed answered. The user's own machine beats this box's Resident,
  // because it is their hardware, usually their GPU, and the words travel one
  // hop further from the host rather than one hop closer.
  const deviceLast = deviceRoute(null);
  if (deviceLast) return deviceLast;

  // Free local Resident — last resort, so any configured key always wins
  // first. This is what lets Echo answer and build with no key at all.
  const r = opts.resident;
  if (r && r.available) {
    const mid = (task === 'code' || task === 'build') ? r.codeModel : r.chatModel;
    if (mid && !skip.has(`ollama/${mid}`)) return { providerId: 'ollama', model: mid, key: '', source: 'platform', resident: true };
  }
  return null;
}

// Concierge routing — always chat, never code or build, and blind to
// whatever the client sent. Resident by default (see docs/CONCIERGE_MODE.md
// section 6); a designated demo key can override this once the demo tenant
// config exists (implementation order step 5).
//
// Per-deploy brain switch (docs/CONCIERGE_MODE.md section 3 item 6): defaults
// to the free Resident so the demo can be left public at zero cost. Flip a
// named high-value prospect to a capped Frontier key by setting
// JOTPANEL_CONCIERGE_BRAIN=frontier (optionally JOTPANEL_CONCIERGE_MODEL) with a
// platform key present; it falls back to the Resident if no key is configured.
function routeForConcierge({ resident, byok }) {
  // Demo BYOK toggle — a visitor-supplied key wins so a prospect can feel the
  // Frontier difference inside the same conversation. Only the brain changes:
  // the locked concierge prompt, the token cap and the style scrub all still
  // apply downstream, and the key is per-request from the browser, never stored.
  const DEMO_BYOK_MODELS = { anthropic: 'claude-sonnet-5', openai: 'gpt-4o' };
  for (const pid of Object.keys(DEMO_BYOK_MODELS)) {
    const k = byok && byok[pid] && byok[pid].key;
    if (k) return { providerId: pid, model: DEMO_BYOK_MODELS[pid], key: k, source: 'byok' };
  }
  const brain = ((process.env.JOTPANEL_CONCIERGE_BRAIN ?? process.env.ARCA_CONCIERGE_BRAIN) || 'resident').toLowerCase();
  if (brain === 'frontier') {
    // Platform keys only — a prospect brings none, and the demo tenant should
    // never depend on a visitor's key. A designated model wins if set.
    const hit = routeForTask('chat', { byok: {}, model: (process.env.JOTPANEL_CONCIERGE_MODEL ?? process.env.ARCA_CONCIERGE_MODEL) || null });
    if (hit && !PROVIDERS_META[hit.providerId].local) return hit;
    // No frontier key configured — fall through to the Resident.
  }
  if (resident && resident.available && resident.chatModel) {
    return { providerId: 'ollama', model: resident.chatModel, key: '', source: 'platform', resident: true };
  }
  return routeForTask('chat', { byok });
}

// System prompts — the Echo personas and app-builder instructions. These are
// product IP and are assembled here so they never reach the client. User data
// (name, persona, memories, site context) is passed in and filled into them.
// Echo in the panel works with the person's own AI key and no hosted service:
// when the private instructions are not installed, the panel's own open prompt
// answers for the panel's Echo. Every other mode still needs the service.
function buildSystemPrompt(mode, ctx = {}) {
  let brain = null;
  try { brain = loadPrivateBrain(); }
  catch (error) { if (mode === 'echo') return buildPanelEchoPrompt(ctx); throw error; }
  return brain.buildSystemPrompt(mode, ctx);
}

let PRIVATE_BRAIN = null;
function loadPrivateBrain() {
  if (PRIVATE_BRAIN) return PRIVATE_BRAIN;
  try {
    PRIVATE_BRAIN = require('./thinking/brain');
    return PRIVATE_BRAIN;
  } catch (error) {
    throw new Error('Local thinking instructions are not installed. Configure JOTPANEL_THINKING_URL for this panel.');
  }
}

// Steve's prose rules, enforced deterministically because a small local model
// will not obey them every time: no em/en dashes as a pause, no comma before
// "and"/"or". The concierge prompt asks for the voice; this guarantees the two
// hard mechanical rules never slip through to the screen.
function sanitizeStyle(text) {
  return (text || '')
    .replace(/`+/g, '')                      // code ticks read as "backtick"
    .replace(/\*+/g, '')                      // markdown asterisks read as "asterisk"
    .replace(/(^|\n)\s*#{1,6}\s+/g, '$1')     // markdown headings
    .replace(/(^|\n)\s*[-+]\s+/g, '$1')       // bullet markers at line start
    .replace(/(^|\n)\s*\d+[.)]\s+/g, '$1')    // numbered-list markers at line start
    .replace(/^\s*(Certainly|Sure|Absolutely|Of course|Great question|Hi there|Hello)[!,.]?\s*/i, '') // the chatbot opener
    .replace(/\s*[—–]\s*/g, ' ')            // em/en dash used as a pause → space
    .replace(/\s+--\s+/g, ' ')               // double hyphen used as a pause
    .replace(/,\s+(and|or)\b/gi, ' $1')      // drop the comma before and/or
    .replace(/[ \t]{2,}/g, ' ');
}
// Streaming-safe version: holds back a short tail so a rule that reaches across
// a chunk boundary (", and") still applies before the text is emitted. Returns
// { push(delta) → cleaned chunk to send, flush() → the final remainder }.
function makeStreamSanitizer() {
  let raw = '', sent = '';
  const HOLD = 8; // longest lookahead any rule needs, plus slack
  const emit = (upTo) => { const chunk = upTo.slice(sent.length); sent = upTo; return chunk; };
  return {
    push(delta) {
      raw += delta;
      const clean = sanitizeStyle(raw);
      const safe = clean.slice(0, Math.max(0, clean.length - HOLD));
      return safe.length > sent.length ? emit(safe) : '';
    },
    flush() { return emit(sanitizeStyle(raw)); },
    get full() { return sanitizeStyle(raw); },
  };
}

// Host policy: may users bring their own API key? Set by the reseller admin
// in the platform config (Admin → Platform → "Allow users to bring their own
// API key"). Defaults to allowed when unset, which is the current behaviour.
// Enforced here rather than in the UI so hiding a button is never the lock.
function hostAllowsByok() {
  try {
    const row = db.prepare("SELECT data FROM routing_table WHERE id=2").get();
    if (row) return JSON.parse(row.data).byok !== false;
  } catch {}
  return true;
}

// The assistant tier. Off unless the host turns it on, and then only for the
// plans the host names, because it is the host's machine and the host's
// margin. `plans` empty means every plan on the deployment.
function assistantOpsPolicy(userId) {
  let cfg = {};
  try {
    const row = db.prepare("SELECT data FROM routing_table WHERE id=2").get();
    if (row) cfg = JSON.parse(row.data).assistantOps || {};
  } catch {}
  // On by default. A fresh install has no row here at all, and requiring one
  // meant every new panel shipped with an Echo that could only describe the
  // screens it was standing on: asking for a mailbox produced instructions,
  // never a proposal. Nothing about safety rests on this flag. A proposal is
  // not an action, serverOps refuses operations the asker may not perform, the
  // list is closed, and a person still approves in Activity. An operator who
  // wants the tier off sets it off, explicitly.
  const enabled = cfg.enabled !== false;
  if (!enabled) return { enabled: false, allowed: false, reason: 'The assistant tier is off on this deployment.' };
  const plans = Array.isArray(cfg.plans) ? cfg.plans : [];
  if (!plans.length) return { enabled: true, allowed: true, reason: null };
  let plan = null;
  try { plan = db.prepare('SELECT plan FROM users WHERE id=?').get(userId)?.plan || null; } catch {}
  if (plan && plans.includes(plan)) return { enabled: true, allowed: true, reason: null };
  return { enabled: true, allowed: false, reason: `Letting the assistant do the work is part of ${plans.join(' or ')}. The panel still does everything by hand on this plan.` };
}

// Spend cap (monthly, USD). Platform default, overridable per user in settings.
function monthlyCap(userId) {
  let cap = parseFloat(process.env.AI_MONTHLY_CAP_USD || '10');
  try {
    const cfgRow = db.prepare("SELECT data FROM routing_table WHERE id=2").get();
    if (cfgRow) { const c = JSON.parse(cfgRow.data); if (c.monthlyCapUSD != null) cap = parseFloat(c.monthlyCapUSD); }
  } catch {}
  try {
    const sRow = db.prepare('SELECT data FROM settings WHERE user_id=?').get(userId);
    if (sRow) { const s = JSON.parse(sRow.data); if (s.aiCapUSD != null) cap = parseFloat(s.aiCapUSD); }
  } catch {}
  return isNaN(cap) ? 10 : cap;
}
function spentThisMonth(userId) {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const row = db.prepare("SELECT COALESCE(SUM(cost),0) AS total FROM ai_usage WHERE user_id=? AND substr(ts,1,7)=? AND byok=0").get(userId, month);
  return row ? row.total : 0;
}

// Read a provider's SSE body line by line, calling onData with each parsed
// "data:" JSON payload. Shared by both streaming transports.
async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onData(JSON.parse(payload)); } catch {}
    }
  }
}

// Provider transport. Returns { text, inTok, outTok }. When onDelta is given
// the call streams and onDelta fires with each text fragment as it arrives.
// A call that came back is the only honest evidence that this panel can use a
// model. It is recorded here, around the one place every provider call goes
// through, rather than trusted from the catalogue or inferred from discovery:
// a provider can list a model the account may not call, and our document can
// describe one whose request shape we get wrong.
async function callProvider(args) {
  const result = await callProviderInner(args);
  if (args && args.userId && args.providerId && args.model) {
    recordModelTested(args.userId, args.providerId, args.model);
  }
  return result;
}

async function callProviderInner({ providerId, model, key, system, messages, maxTokens, onDelta, device, userId, signal }) {
  const meta = PROVIDERS_META[providerId];
  if (!meta) throw new Error(`Unknown provider: ${providerId}`);
  // Normalise history roles to user/assistant. Images ride along as data URLs
  // (downscaled client-side) and are shaped per dialect below.
  const hist = (messages || []).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: typeof m.content === 'string' ? m.content : String(m.content || ''),
    images: Array.isArray(m.images)
      ? m.images.filter(s => typeof s === 'string' && s.startsWith('data:image/')).slice(0, 4)
      : null,
  }));
  const stream = typeof onDelta === 'function';

  // The user's own machine. There is no URL to call: the job is written down a
  // link that machine is holding open, and the answer comes back up the same
  // way. Everything else in this function builds an HTTP request; this branch
  // builds a job and waits for it.
  if (meta.kind === 'byog') {
    if (!device || !device.deviceId) throw new Error('No device was chosen for this request.');
    if (!userId) throw new Error('A device job needs the identity of the person it belongs to.');
    const { promise } = byog.dispatch({
      userId, deviceId: device.deviceId, model,
      system, messages: hist, maxTokens, onDelta, signal,
    });
    const out = await promise;
    return { text: out.text, inTok: out.inTok, outTok: out.outTok, device: out.byogDevice };
  }

  if (meta.kind === 'anthropic') {
    const msgsA = hist.map(m => {
      if (!m.images || !m.images.length) return { role: m.role, content: m.content };
      const blocks = m.images.map(url => {
        const [, mediaType, b64] = url.match(/^data:(image\/[\w+.-]+);base64,(.+)$/) || [];
        return b64 ? { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } } : null;
      }).filter(Boolean);
      if (m.content) blocks.push({ type: 'text', text: m.content });
      return { role: m.role, content: blocks };
    });
    const res = await fetch(meta.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens || 900, system: system || undefined, messages: msgsA, stream }),
    });
    if (!stream) {
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'Anthropic error');
      return { text: data.content?.[0]?.text || '', inTok: data.usage?.input_tokens || 0, outTok: data.usage?.output_tokens || 0 };
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error?.message || `Anthropic error (${res.status})`), { status: res.status });
    }
    let text = '', inTok = 0, outTok = 0;
    await readSSE(res, ev => {
      if (ev.type === 'content_block_delta' && ev.delta?.text) { text += ev.delta.text; onDelta(ev.delta.text); }
      if (ev.type === 'message_start') inTok = ev.message?.usage?.input_tokens || 0;
      if (ev.type === 'message_delta' && ev.usage?.output_tokens) outTok = ev.usage.output_tokens;
      if (ev.type === 'error') throw new Error(ev.error?.message || 'Anthropic stream error');
    });
    return { text, inTok, outTok };
  }

  // OpenAI-compatible (openai, groq, gemini, mistral, ollama)
  const histO = hist.map(m => {
    if (!m.images || !m.images.length) return { role: m.role, content: m.content };
    const parts = m.images.map(url => ({ type: 'image_url', image_url: { url } }));
    if (m.content) parts.push({ type: 'text', text: m.content });
    return { role: m.role, content: parts };
  });
  const msgs = system ? [{ role: 'system', content: system }, ...histO] : histO;
  const headers = { 'Content-Type': 'application/json' };
  if (!meta.local) headers['Authorization'] = `Bearer ${key}`;
  const body = { model, max_tokens: maxTokens || 900, messages: msgs };
  if (stream) {
    body.stream = true;
    // Ask for usage in the final chunk where the dialect supports it.
    if (['openai', 'groq', 'ollama'].includes(providerId)) body.stream_options = { include_usage: true };
  }
  // A local Resident can go away for a moment, a service restart being the
  // ordinary way, and the endpoint chosen at probe time then answers nothing.
  // Nothing invalidated that, so one blip left Echo answering "fetch failed"
  // to everybody on the box until somebody restarted the panel by hand, while
  // Ollama itself answered the same prompt on loopback in eight seconds.
  // Measured on a live box 2026-09-09. Re-probe once and use whatever answers.
  let res;
  try {
    res = await fetch(meta.base, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (error) {
    if (!meta.local) throw error;
    _residentCache = { ts: 0, data: _residentCache.data };
    await getResident();
    res = await fetch(meta.base, { method: 'POST', headers, body: JSON.stringify(body) });
  }
  if (!stream) {
    const data = await res.json().catch(() => ({}));
    if (data.error || !res.ok) throw Object.assign(new Error(data.error?.message || (data.error ? JSON.stringify(data.error) : `${providerId} error (${res.status})`)), { status: res.ok ? null : res.status });
    return { text: data.choices?.[0]?.message?.content || '', inTok: data.usage?.prompt_tokens || 0, outTok: data.usage?.completion_tokens || 0 };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error?.message || `${providerId} error (${res.status})`), { status: res.status });
  }
  let text = '', inTok = 0, outTok = 0;
  await readSSE(res, ev => {
    const delta = ev.choices?.[0]?.delta?.content;
    if (delta) { text += delta; onDelta(delta); }
    if (ev.usage) { inTok = ev.usage.prompt_tokens || 0; outTok = ev.usage.completion_tokens || 0; }
  });
  // Dialects that never report usage on streams get a rough estimate so the
  // meter still moves; local calls are costed at zero anyway. Text only —
  // base64 image payloads would inflate the estimate absurdly.
  if (!inTok && !outTok) {
    inTok = Math.ceil((system || '').length / 4) + hist.reduce((n, m) => n + Math.ceil(m.content.length / 4) + (m.images ? m.images.length * 800 : 0), 0);
    outTok = Math.ceil(text.length / 4);
  }
  return { text, inTok, outTok };
}

// Customer panels never need the directing instructions. When an installer
// supplies JOTPANEL_THINKING_URL, this backend becomes a narrow authenticated
// transport and the local brain below is bypassed completely. Steve's own
// thinking-service deployment leaves it unset and runs the engine here.
async function proxyThinkingChat(req, res, staged = null, options = {}) {
  const base = String((process.env.JOTPANEL_THINKING_URL ?? process.env.ARCA_THINKING_URL) || '').replace(/\/$/, '');
  if (!base) return false;
  const key = licenseClient.keyForProxy();
  if (!key) throw new Error('This panel is not registered for the thinking service');
  // Only the fields the engine reads. The browser's request also carries the
  // person's own provider keys, and those never leave for the engine.
  const outbound = hostedBody(req.body || {}, { messages: options.messages, context: options.context });
  const upstream = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: req.body?.stream ? 'text/event-stream' : 'application/json',
      'X-Arca-License': key,
      'X-Arca-Machine': licenseClient.machineId,
      'X-Arca-Account': crypto.createHmac('sha256', ENCRYPT_SECRET).update(req.user.id).digest('hex'),
      'X-Arca-Version': (process.env.JOTPANEL_VERSION ?? process.env.ARCA_VERSION) || 'dev',
    },
    body: JSON.stringify(outbound),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  // A refusal or a failure upstream reaches the caller as one plain line,
  // never as somebody's gateway page.
  if (!upstream.ok) {
    let message = 'The assistant is not available right now.';
    try { const j = await upstream.json(); if (j && j.error) message = j.error; } catch { /* not JSON: the words above stand */ }
    res.status(upstream.status >= 500 ? 503 : upstream.status).json({ error: message, hosted: true });
    return '';
  }
  res.status(upstream.status);
  res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
  if (req.body?.stream) {
    res.set({ 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    // Same event the local path writes, ahead of the words, so a card appears
    // whether the thinking happened on this machine or upstream.
    if (staged) res.write(`data: ${JSON.stringify({ action: publicControlAction(staged) })}\n\n`);
    const reader = upstream.body.getReader();
    let collected = '', pending = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      if (options.collect) {
        pending += Buffer.from(value).toString('utf8');
        let i; while ((i = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, i).trim(); pending = pending.slice(i + 1); if (line.startsWith('data:')) { try { const j = JSON.parse(line.slice(5)); if (j.delta) collected += j.delta; } catch { /* partial */ } } }
      }
    }
    res.end();
    return collected;
  } else {
    const body = Buffer.from(await upstream.arrayBuffer());
    if (options.collect) { try { const j = JSON.parse(body.toString('utf8')); res.send(body); return j.reply || j.text || ''; } catch { /* fall through */ } }
    if (staged) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        return res.send(JSON.stringify({ ...parsed, action: publicControlAction(staged) }));
      } catch { /* not JSON, so it is passed through as it arrived */ }
    }
    res.send(body);
  }
  return true;
}


// POST /api/ai/chat — the one entry point Echo uses. Routes, builds the
// system prompt, enforces the cap, calls the provider, meters the cost.
// ── The person's own provider keys ─────────────────────────────────
// Kept in the encrypted vault on this server and never in the browser. Nothing
// here ever returns a key: saving answers with a fingerprint, listing reads
// fingerprints and labels only.
function keyableProvider(id) {
  if (id === 'elevenlabs') return id;
  return Object.prototype.hasOwnProperty.call(PROVIDERS_META, id) && !PROVIDERS_META[id].local ? id : null;
}
mountKeyVaultRoutes(app, { auth, providerKeys, audit, scrubSecrets, keyableProvider, hostAllowsByok, identityKey });

// ── Builds: plan, approve, run (Resident Stage 6) ──────────────────
const jobRunner = createJobRunner({ db, ledger: projectLedger });
const conversationGuard = createConversationGuard({ ledger: projectLedger, jobRunner, fit: routingFit });
const SPECIALIST_SYSTEM = 'You are a specialist on one step of a larger build. Do only this step, keep to every rule given, and put code in fenced blocks.';
const PLANNER_SYSTEM = 'You plan software builds. Break the goal into 2 to 12 small steps that each produce code. Reply with JSON only, no prose: [{"title":"what this step builds","mustContain":["an exact short piece of code the finished step must contain"]}]. Keep to the rules given.';

// Decision 4: the person's own bigger model plans; without one, the local
// Resident writes a plan labelled rough. A host's key never plans.
async function plannerFor(accountId) {
  const byok = hostAllowsByok() ? storedByok(accountId) : {};
  for (const [pid, mid] of candidatesFor('reason', hostRoutes())) {
    const key = byok[pid] && byok[pid].key;
    if (key) return { id: `${pid}/${mid}`, rough: false, call: (system, text) => callProvider({ providerId: pid, model: mid, key, system, messages: [{ role: 'user', content: text }], maxTokens: 2000, userId: accountId }) };
  }
  const resident = await getResident();
  const localModel = resident.available && (resident.codeModel || resident.chatModel);
  if (localModel) return { id: `ollama/${localModel}`, rough: true, call: (system, text) => callProvider({ providerId: 'ollama', model: localModel, key: '', system, messages: [{ role: 'user', content: text }], maxTokens: 2000 }) };
  return null;
}

// The models that may work a step: the person's own keys and the models on
// this box or their own device. A host's key is never spent by a build, since
// builds run outside the chat budget checks.
async function specialistsForStep(accountId, step) {
  const task = interpretRequest({ text: step.title }).task;
  const byok = hostAllowsByok() ? storedByok(accountId) : {};
  const resident = await getResident();
  const exclude = new Set();
  const found = [];
  for (let i = 0; i < 6 && found.length < 3; i += 1) {
    const r = routeForTask(task, { byok, resident, exclude });
    if (!r) break;
    exclude.add(`${r.providerId}/${r.model}`);
    if (r.source === 'platform' && !PROVIDERS_META[r.providerId].local) continue;
    found.push(r);
  }
  return routingFit.order(accountId, TASK_ROLE[task] || 'chat', found, r => `${r.providerId}/${r.model}`).map(r => ({
    id: `${r.providerId}/${r.model}`,
    call: async ({ brief }) => (await callProvider({ providerId: r.providerId, model: r.model, key: r.key, system: SPECIALIST_SYSTEM, messages: assertClean([{ role: 'user', content: scrubSecrets(brief) }]), maxTokens: 1500, userId: accountId })).text,
  }));
}

function briefForStep(accountId) {
  return ({ step, correction }) => {
    const project = residentGateway.projectContext({ accountId, projectId: step.projectId });
    const role = interpretRequest({ text: step.title }).role;
    const request = `${step.title}${step.criteria && step.criteria.length ? `\nIt must contain: ${step.criteria.map(c => c.name).join('; ')}` : ''}${correction ? `\n\nCorrection from review:\n${correction}` : ''}`;
    return prepareOutbound({ role: role === 'chat' ? 'coding' : role, messages: [{ role: 'user', content: request }], project }).messages[0].content;
  };
}

async function startRun(accountId, planId) {
  // A build resumed at start follows the licence too; it waits for the next
  // start rather than running unlicensed.
  const licence = await licenseClient.thinkingAccess().catch(() => ({ allowed: false }));
  if (!licence.allowed) { console.log(`[resident] build ${planId} waits: the assistant is not licensed here`); return; }
  jobRunner.runBuild({
    accountId, planId, runId: LEDGER_RUN_ID, specialistsFor: step => specialistsForStep(accountId, step), prepareBrief: briefForStep(accountId),
    onOutcome: ({ specialist, step, accepted }) => routingFit.record(accountId, TASK_ROLE[interpretRequest({ text: step.title }).task] || 'chat', specialist.id, accepted ? 'accepted' : 'rejected'),
  })
    .then(result => audit(accountId, `resident_build_${result.outcome}`, null, planId))
    .catch(error => { console.error('[resident] build', planId, error.message); audit(accountId, 'resident_build_failed', null, `${planId} ${scrubSecrets(error.message)}`); });
}

// The same rule chat follows: nothing here uses a model until the panel is
// registered for the assistant.
async function assistantLicensed(req, res) {
  const licence = await thinkingAccessForRequest();
  if (licence.allowed) return true;
  audit(req.user.id, 'thinking_service_refused', req, `${licence.status}: ${licence.reason || ''}`);
  res.status(403).json({ error: licence.reason || 'Register this panel to connect the assistant.', license: { registered: !!licence.registered, status: licence.status, reason: licence.reason || null, panel_available: true } });
  return false;
}

const buildError = (res, error) => res.status({ NOT_FOUND: 404, NOT_APPROVED: 409, LOCKED: 409, BAD_PLAN: 422 }[error.code] || 400).json({ error: error.message, code: error.code || null });

app.post('/api/resident/plans', auth, async (req, res) => {
  if (!(await assistantLicensed(req, res))) return;
  const goal = String(req.body?.goal || '').trim().slice(0, 2000);
  if (!goal) return res.status(400).json({ error: req.t('Say what you want built.') });
  try {
    const projectId = residentGateway.projectFor(req.user.id, req.body?.conversationId || null);
    const planner = await plannerFor(req.user.id);
  if (!planner) return res.status(503).json({ error: req.t('Nothing can plan this yet: add your own API key, or start the local model.') });
    const draft = async ({ rules }) => {
      const text = `Goal: ${scrubSecrets(goal)}\nRules:\n${rules.map(r => `- ${r.title}`).join('\n') || '- none'}`;
      const out = await planner.call(PLANNER_SYSTEM, text);
      const found = String(out.text || '').match(/\[[\s\S]*\]/);
      try { return found ? JSON.parse(found[0]) : null; } catch { return null; }
    };
    const plan = await jobRunner.planBuild({ accountId: req.user.id, projectId, goal, planner: draft, plannerId: planner.id, rough: planner.rough, actor: planner.rough ? 'resident' : `model:${planner.id}` });
    audit(req.user.id, 'resident_plan_proposed', req, `${plan.id} ${planner.id}${planner.rough ? ' rough' : ''}`);
    res.json({ ...jobRunner.status(req.user.id, plan.id), ...(planner.rough ? { note: req.t('This is a rough plan from the local model. Check it before approving; your own API key can produce a more detailed one.') } : {}) });
  } catch (error) { buildError(res, error); }
});
app.post('/api/resident/plans/:id/approve', auth, (req, res) => {
  try {
    const approval = projectLedger.approve(req.user.id, req.params.id, { seenHash: req.body?.seenHash, approvedBy: `person:${req.user.id}` });
    projectLedger.settle(req.user.id, req.params.id, { actor: `person:${req.user.id}`, approvalId: approval.id });
    res.json(jobRunner.status(req.user.id, req.params.id));
  } catch (error) { buildError(res, error); }
});
app.post('/api/resident/plans/:id/run', auth, async (req, res) => {
  if (!(await assistantLicensed(req, res))) return;
  try {
    jobRunner.requireApprovedPlan(req.user.id, req.params.id);
    if (['queued', 'running'].includes(jobRunner.status(req.user.id, req.params.id).run.state)) return res.status(409).json({ error: req.t('This plan is already queued or running.'), code: 'LOCKED' });
    startRun(req.user.id, req.params.id);
    res.status(202).json({ started: true });
  } catch (error) { buildError(res, error); }
});
app.get('/api/resident/plans/:id', auth, (req, res) => {
  try { res.json(jobRunner.status(req.user.id, req.params.id)); } catch (error) { buildError(res, error); }
});
// ── Rules and the record of routing (Stage 7) ───────────────────────
// A rule is proposed with the patterns that would show it broken, drafted by
// the local Resident as plain words (never as code) and approved by the person
// together with the rule, so the supervisor can check it.
async function draftRulePatterns(title, text) {
  const resident = await getResident();
  if (!resident.available || !resident.chatModel) return [];
  try {
    const out = await Promise.race([
      callProvider({ providerId: 'ollama', model: resident.chatModel, key: '', maxTokens: 80,
        system: 'A rule for a software project is given. List up to 5 single words or package names that would appear in code that breaks it. Use lowercase. Example for the rule "No jQuery": ["jquery", "$("]. Reply with a JSON array of strings only.',
        messages: [{ role: 'user', content: `Rule: ${scrubSecrets(title)}${text ? `\n${scrubSecrets(text)}` : ''}` }] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('over budget')), 30000)),
    ]);
    const found = String(out.text || '').match(/\[[\s\S]*?\]/);
    const list = found ? JSON.parse(found[0]) : [];
    return (Array.isArray(list) ? list : []).map(v => String(v).trim()).filter(v => v.length >= 2 && v.length <= 60).slice(0, 5)
      .map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  } catch { return []; }
}

app.get('/api/resident/projects', auth, (req, res) => {
  res.json({ projects: projectLedger.projects(req.user.id).map(p => ({ id: p.id, name: p.name, status: p.status })) });
});
app.get('/api/resident/projects/:id', auth, (req, res) => {
  try {
    const snap = projectLedger.snapshot(req.user.id, req.params.id);
    const brief = item => ({ id: item.id, title: item.title, text: item.text || null, status: item.status, hash: item.hash, forbid: item.forbid || [], approval: item.approval || null, kind: item.kind || null });
    res.json({ project: { id: snap.project.id, name: snap.project.name }, decisions: snap.decisions.map(brief), constraints: snap.constraints.map(brief), knowledge: snap.knowledge.map(brief), questions: snap.questions.map(brief) });
  } catch (error) { buildError(res, error); }
});
app.post('/api/resident/projects/:id/rules', auth, async (req, res) => {
  if (!(await assistantLicensed(req, res))) return;
  const kind = req.body?.kind === 'constraint' ? 'constraint' : 'decision';
  const title = String(req.body?.title || '').trim().slice(0, 300);
  if (!title) return res.status(400).json({ error: req.t('A rule needs a title.') });
  try {
    const forbid = Array.isArray(req.body?.forbid) ? req.body.forbid.map(String).slice(0, 10) : await draftRulePatterns(title, req.body?.text);
    const rule = projectLedger.record(req.user.id, req.params.id, kind, { title, text: req.body?.text ? String(req.body.text).slice(0, 2000) : undefined, forbid }, { actor: `person:${req.user.id}` });
    const note = rule.forbid && rule.forbid.length
      ? req.t('Check the patterns: an answer whose code contains any of them is treated as breaking this rule. Approve to put the rule in force.')
      : req.t('No patterns could be drafted, so answers cannot be checked against this rule automatically. Add some before approving if you want that.');
    res.json({ id: rule.id, kind, title: rule.title, forbid: rule.forbid, hash: rule.hash, status: rule.status, note });
  } catch (error) { buildError(res, error); }
});
app.post('/api/resident/rules/:id/approve', auth, (req, res) => {
  try {
    const rule = projectLedger.get(req.user.id, req.params.id);
    if (!rule || !['decision', 'constraint'].includes(rule.entity)) return res.status(404).json({ error: req.t('No such rule.') });
    const approval = projectLedger.approve(req.user.id, rule.id, { seenHash: req.body?.seenHash, approvedBy: `person:${req.user.id}` });
    const moved = projectLedger.move(req.user.id, rule.id, rule.entity === 'constraint' ? 'active' : 'settled', { actor: `person:${req.user.id}`, approvalId: approval.id });
    res.json({ id: moved.id, status: moved.status, approval: moved.approval });
  } catch (error) { buildError(res, error); }
});
// Why each piece of work went where it went, what left the box, and how it
// ended. Field names, sizes and hashes only; never the words.
app.get('/api/resident/dispatches', auth, (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  const out = [];
  for (const p of projectLedger.projects(req.user.id)) {
    for (const d of projectLedger.list(req.user.id, p.id, { entity: 'dispatch' })) {
      out.push({
        id: d.id, project: p.name, at: d.createdAt, status: d.status, purpose: d.purpose,
        route: d.route || null, sent: (d.sent || []).map(f => ({ field: f.field, bytes: f.bytes, sha256: f.sha256 })),
        result: d.result ? { costMicro: d.result.costMicro, latencyMs: d.result.latencyMs, checks: d.result.checks, error: d.result.error } : null,
        interruption: d.interruption || null,
      });
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : -1));
  res.json({ dispatches: out.slice(0, limit), fit: routingFit.report(req.user.id) });
});

// Builds that were running when the process stopped carry on.
setImmediate(() => {
  for (const run of jobRunner.runsToResume({ runId: LEDGER_RUN_ID })) {
    console.log(`[resident] resuming build ${run.planId}`);
    startRun(run.accountId, run.planId);
  }
});

app.post('/api/ai/chat', auth, async (req, res) => {
  const { mode, task, model, maxTokens, byok: rawByok, system: rawSystem } = req.body || {};
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: req.t('messages required') });

  const licence = await thinkingAccessForRequest();
  if (!licence.allowed) {
    audit(req.user.id, 'thinking_service_refused', req, `${licence.status}: ${licence.reason || ''}`);
    return res.status(403).json({
      error: licence.reason || 'Register this panel to connect the assistant.',
      license: {
        registered: !!licence.registered,
        status: licence.status,
        reason: licence.reason || null,
        contact: licence.contact || null,
        panel_available: true,
      },
    });
  }
  
// The Resident sees every orchestrated turn first and works out the task
  // itself; the browser's task is a hint. The public demo keeps its own locked
  // path unchanged.
  const residentLocked = mode === 'concierge';
  let residentTurn = null;
  if (!residentLocked) {
    try {
      const lastUserText = String(([...messages].reverse().find(m => m.role === 'user') || {}).content || '');
      residentTurn = await residentGateway.open(req.user.id, { conversationId: req.body?.conversationId, mode, taskHint: task, text: lastUserText });
    } catch (error) {
      audit(req.user.id, 'resident_open_failed', req, error.message);
    }
  }
  const turnTask = residentTurn ? residentTurn.task : (task || 'chat');

  // Before anything is routed (F5): a destructive-sounding request gets a
  // question back and nothing else; a correction is recorded, and one that
  // points at the plan drafts the change for approval.
  let residentConfirmed = null;
  if (residentTurn) {
    let guarded = null;
    try {
      guarded = conversationGuard.before({ accountId: req.user.id, projectId: residentTurn.projectId, role: residentTurn.role, text: String(([...messages].reverse().find(m => m.role === 'user') || {}).content || '') });
    } catch (error) { console.error('[resident] guard', error.message); }
    if (guarded && guarded.kind === 'confirmed') residentConfirmed = guarded.confirmedRequest;
    if (guarded && !guarded.proceed) {
      audit(req.user.id, `resident_${guarded.kind}`, req, residentTurn.projectId);
      if (req.body?.stream) {
        res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify({ delta: guarded.reply })}\n\n`);
        res.write(`data: ${JSON.stringify({ done: true, provider: 'resident', model: 'rules', resident: guarded.kind })}\n\n`);
        return res.end();
      }
      return res.json({ reply: guarded.reply, provider: 'resident', model: 'rules', resident: guarded.kind });
    }
  }

  // Demo bridge — Echo proposes, the visitor approves, it executes, all
  // inside the conversation. Detect an actionable intent in the visitor's
  // last message, stage it through the normal propose path (same queue, same
  // audit trail, mock adapter) and hand the proposal to the stream as a
  // structured event alongside the text. Detection failure never breaks chat.
  let bridgeAction = null;
  if (mode === 'concierge') {
    try {
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const account = buildProvisioningAccountContext(req.user.id);
      const hit = detectDemoAction(lastUser?.content, { clientIp: req.ip, primaryDomain: account.primaryDomain });
      if (hit) {
        bridgeAction = await provisioning.propose({ intent: hit.actionKey, input: hit.input, account });
        audit(req.user.id, 'provisioning_propose', req, bridgeAction.label);
      }
    } catch (e) { console.error('[demo-bridge]', e.message); }
  }

  // The assistant tier. Same shape as the demo bridge and a different target:
  // this stages a REAL catalogue operation down the one execution path, so it
  // is proposed here, approved by the person on their own request, executed by
  // the privileged layer and verified by reading it back. The assistant's
  // reach is the closed list in control/assistantProposals.js, the detector
  // reads the human's own last message and never anything the model produced
  // or fetched, and a capability the box cannot do refuses here rather than
  // drawing a card that cannot run.
  let assistantAction = null;
  const assistantPolicy = assistantOpsPolicy(req.user.id);
  if (!bridgeAction && mode !== 'concierge' && assistantPolicy.allowed) {
    try {
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      // After a confirmed destructive request, the operation is read from the
      // request that was confirmed, not from the word "yes".
      const hit = assistantProposals.detect(residentConfirmed || lastUser?.content);
      if (hit) {
        assistantAction = await serverOps.propose(req.user.id, hit.operation, hit.input, opsContext(req), { deliver: hit.deliver });
        audit(req.user.id, 'assistant_op_proposed', req, assistantAction.label);
      }
    } catch (e) {
      audit(req.user.id, 'assistant_op_proposal_refused', req, e.message);
      console.error('[assistant-ops]', e.message);
    }
  }

  // Staged above the proxy branch on purpose. A panel pointed at the hosted
  // thinking service returns from inside that branch, so every proposal the
  // assistant could make was staged in code that never ran, and the whole AI
  // tier was silently dead on exactly the deployment shape customers use.
  if ((process.env.JOTPANEL_THINKING_URL ?? process.env.ARCA_THINKING_URL)) {
    let hostedDispatch = null;
    try {
      const hostedOut = residentTurn
        ? prepareOutbound({ role: residentTurn.role, explicit: !!(model || req.body?.providerId), messages, project: residentGateway.projectContext(residentTurn) })
        : null;
      if (hostedOut) assertClean(hostedOut.messages);
      hostedDispatch = residentDispatch(residentTurn, { providerId: 'hosted', model: 'engine', source: 'platform' }, { sent: hostedOut ? hostedOut.fields : {} });
      await proxyThinkingChat(req, res, bridgeAction || assistantAction, hostedOut ? { messages: hostedOut.messages } : {});
      residentFinish(residentTurn, hostedDispatch);
      return;
    } catch (error) {
      error.message = scrubSecrets(error.message);
      residentFinish(residentTurn, hostedDispatch, { error: error.message });
      audit(req.user.id, 'thinking_service_proxy_failed', req, error.message);
      return res.status(502).json({ error: `The thinking service could not complete the request: ${error.message}`, panel_available: true });
    }
  }

  // Host policy gate: when the reseller disallows bring-your-own-key, client
  // keys are ignored everywhere (routing, vision, the demo toggle) so the
  // platform routes and caps are the only path.
  // A key the caller sent wins over one they stored, because the demo toggle
  // is a key typed into this request and meant for this request.
  const storedKeyRoutes = hostAllowsByok() ? storedByokRoutes(req.user && req.user.id) : {};
  const storedKeys = hostAllowsByok() ? storedByok(req.user && req.user.id) : {};
  for (const [providerId, keys] of Object.entries(storedKeyRoutes)) {
    if (storedKeys[providerId] && keys[0]) storedKeys[providerId].fingerprint = keys[0].fingerprint;
  }
  const byok = hostAllowsByok() ? { ...storedKeys, ...(rawByok || {}) } : {};

  const resident = await getResident();
  const hasImages = messages.some(m => Array.isArray(m.images) && m.images.length);

  // BYOG — the model on the person's own computer. Asked before routing rather
  // than during it, because "is my laptop awake and does it hold a model that
  // fits this job" is a question about a live link and a machine's inventory,
  // not a lookup in a table.
  //
  // Concierge is a public demo conversation with a visitor who has no account
  // and no machine, so it never offers the user's own computer.
  const byogOffered = mode !== 'concierge';
  const byogPolicy = byog.readPolicy(req.user.id);
  const byogPick = byogOffered
    ? byog.selectDevice(req.user.id, {
        task: turnTask,
        needsVision: hasImages,
        // Naming the device by hand is the user overruling their own automatic
        // routing preference, which is allowed. It is not overruling ownership:
        // selectDevice still only ever looks at this person's own rows.
        ignoreAutoRoute: req.body?.providerId === 'byog',
      })
    : { device: null, policy: byogPolicy, reason: 'Not offered in this mode.' };
  // `byok` is whatever the client sent, which is usually nothing at all, so it
  // is read defensively exactly as resolveKey reads it. Without the guard this
  // line threw inside an async route, which Express 4 does not catch, and the
  // rejection took the whole process down. Found by the end-to-end run.
  const hasFrontierKey = Object.keys(PROVIDERS_META).some(id => !PROVIDERS_META[id].local
    && ((PROVIDERS_META[id].envKey && process.env[PROVIDERS_META[id].envKey]) || (byok && byok[id] && byok[id].key)));
  // Local-only always reaches for the machine first. Otherwise the byog service
  // decides, and its rule is the routing table's own: mechanical work to the
  // free hardware, judgement escalates.
  const byogFirst = !!byogPick.device
    && (byogPolicy.mode === 'private' || byog.preferBefore(turnTask, { hasFrontier: hasFrontierKey }));

  // Concierge is mode-locked: chat only, never code or build, and the client's
  // own task/model/providerId/override are ignored so a wording jailbreak
  // cannot route this conversation anywhere but a chat model. Resident first.
  let route = mode === 'concierge'
    ? routeForConcierge({ resident, byok })
    : routeForTask(turnTask, { accountId: residentTurn ? req.user.id : null, byok, model, providerId: req.body?.providerId, override: req.body?.override, resident, byogPick, byogFirst });
  if (!route && req.body?.providerId === 'byog') {
    return res.status(503).json({ error: byogPick.reason || 'That computer is not available right now.', code: 'byog_unavailable', byog: { reason: byogPick.reason } });
  }
  if (!route) return res.status(503).json({ error: req.t('No AI provider available. Start the local model (Ollama) or add an API key in Settings → AI Connections.') });

  // Messages with photos need a vision-capable brain: first keyed provider
  // that can see, then a local vision model, else a clear nudge. A device that
  // holds a vision model is offered ahead of this box's own, for the same
  // reason it is anywhere else: it is the user's hardware and a photo is the
  // most personal thing they will ever paste into a chat.
  if (hasImages) {
    const VISION_PREFS = [['anthropic', 'claude-sonnet-5'], ['openai', 'gpt-4o'], ['gemini', 'gemini-2.0-flash']];
    const deviceVision = byogPick.device && byogPick.model
      ? { providerId: 'byog', model: byogPick.model, key: '', source: 'device', byog: { deviceId: byogPick.device.id, name: byogPick.device.name } }
      : null;
    let vroute = null;
    // Under local-only, a keyed cloud provider is not a candidate at all.
    if (byogPolicy.mode !== 'private') {
      for (const [pid, mid] of VISION_PREFS) {
        const got = resolveKey(pid, byok);
        if (got) { vroute = { providerId: pid, model: mid, key: got.key, source: got.source }; break; }
      }
    }
    if (deviceVision && (byogFirst || !vroute)) vroute = deviceVision;
    if (!vroute && resident.available && resident.visionModel) {
      vroute = { providerId: 'ollama', model: resident.visionModel, key: '', source: 'platform', resident: true };
    }
    if (!vroute) return res.status(503).json({ error: req.t('No vision-capable brain available. Add an API key in Settings → AI Connections, or pull a local vision model (for example: ollama pull qwen2.5vl).') });
    route = vroute;
  }

  // Local-only is a promise about where the words go, so it is enforced on the
  // route that came out rather than trusted to the ladder that produced it. A
  // conversation the user marked private is never quietly finished in somebody
  // else's cloud, whatever the routing table would have preferred.
  if (byogOffered && byogPolicy.mode === 'private' && !PROVIDERS_META[route.providerId].local) {
    if (byogPolicy.residentFallback && resident.available && (hasImages ? resident.visionModel : resident.chatModel)) {
      route = { providerId: 'ollama', model: hasImages ? resident.visionModel : resident.chatModel, key: '', source: 'platform', resident: true };
    } else {
      audit(req.user.id, 'byog_local_only_refused', req, byogPick.reason || 'no device');
      return res.status(503).json({
        error: `This account is set to answer on your own computer only. ${byogPick.reason || 'No device is connected.'}`,
        code: 'byog_local_only',
        byog: { mode: 'private', reason: byogPick.reason, residentFallback: byogPolicy.residentFallback },
      });
    }
  }

  // Enforce the monthly cap only when spending platform money.
  //
  // The package limit is the authority when the account has one. That is the
  // migration the reseller-packages work called for: one cap, in the place
  // every other limit lives, checked up the whole chain so a reseller's own
  // ceiling holds across all of its customers at once — something the old
  // per-user cap could never do, since it only ever looked at one person.
  // Where no package sets a figure, the old platform default still applies,
  // so nothing became unlimited on the upgrade that shipped this.
  if (route.source === 'platform' && !PROVIDERS_META[route.providerId].local) {
    const membership = ownership.getMembership(req.user.id);
    const packaged = membership ? await entitlements.checkCapacity(membership.orgId, 'ai_cost_microunits_month', 0, entitlements.monthKey()) : { ok: true };
    if (!packaged.ok) {
      const limitUsd = (packaged.maximum || 0) / 1e6;
      const spentUsd = (packaged.used || 0) / 1e6;
      return res.status(402).json({
        error: packaged.code === 'ENTITLEMENT_ASSIGNMENT_MISSING'
          ? 'This account has no active package, so the assistant cannot spend anything yet.'
          : `The monthly assistant budget on this account's package is used up ($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}). It resets next month, or add your own API key to continue.`,
        cap: limitUsd, spent: spentUsd, source: 'package',
      });
    }
    const capped = membership ? entitlements.effectiveEntitlement(membership.orgId, 'ai_cost_microunits_month') : null;
    if (!capped || capped.missing || capped.maxUnlimited) {
      const cap = monthlyCap(req.user.id);
      const spent = spentThisMonth(req.user.id);
      if (cap > 0 && spent >= cap) {
        return res.status(402).json({ error: `Monthly AI budget reached ($${cap.toFixed(2)}). It resets next month, or add your own API key to continue.`, cap, spent, source: 'platform' });
      }
    }
  }

  // mode → server-built persona/app prompt (IP stays here). No mode → caller's
  // own system string (Direct Chat raw access), which is the user's, not ours.
  let stagedAction = bridgeAction || assistantAction;
  // The generic pipeline. The thirteen phrasings the detector knows are a fast
  // path that needs no model round trip; everything else in the catalogue is
  // reachable by letting the model name the operation. It still only ever files
  // a proposal, and propose() re-checks the operation, the parameters, the
  // capability and this person's permission.
  const echoPipeline = mode === 'echo' && !stagedAction && assistantPolicy.allowed;
  const promptCtx = {
    ...req.body,
    ...(stagedAction ? { bridgeLabel: stagedAction.label } : {}),
    ...(echoPipeline ? { operationRules: echoProposals.promptRules(echoProposals.catalogueForPrompt(opsCatalogue.OPERATIONS)) } : {}),
  };
  let system;
  try { system = mode ? buildSystemPrompt(mode, promptCtx) : (rawSystem || ''); }
  catch (error) {
    audit(req.user.id, 'assistant_unconfigured', req, error.message);
    return res.status(503).json({ error: req.t('The assistant is not connected on this machine yet.') });
  }

  // Answer in the register the person is in (bundle 3, responseAssembly.md).
  // Unsure what was asked: one short question beats a confident wrong answer.
  if (residentTurn && residentTurn.how === 'model' && residentTurn.confidence != null && residentTurn.confidence < 0.5) {
    system = `${system}\n\nThe request may be ambiguous. If it could mean more than one thing, ask one short clarifying question before doing anything.`;
  }
  if (residentTurn && (residentTurn.state === 'frustrated' || residentTurn.state === 'confused')) {
    system = `${system}\n\nThe person seems ${residentTurn.state}. Answer shorter and plainer than usual, lead with what to do, and skip background they did not ask for.`;
  }

  // Concierge answers stay short by contract; cap output tokens so a rambly
  // local model is cut off rather than talking the prospect's head off.
  const effMaxTokens = mode === 'concierge' ? Math.min(maxTokens || 200, 200) : maxTokens;

  // A proposal block must never reach the person, and a stream has already sent
  // the words by the time the block can be read. Echo's own screen does not
  // stream; while the pipeline is in play, nothing else does either.
  const wantStream = !!req.body?.stream && !echoPipeline;
  // The concierge speaks in Steve's voice; scrub the two hard style rules on
  // the way out so a local model's slip never reaches the prospect.
  const styleClean = mode === 'concierge';
  const sanitizer = styleClean && wantStream ? makeStreamSanitizer() : null;

  // Performance instrumentation. Timed around the provider call only, so it
  // measures inference rather than our own prompt building, and the in-flight
  // count is snapshotted at the START because that is the load this request had
  // to push through.
  const perfT0 = Date.now();
  const perfConcurrent = ++AI_INFLIGHT;
  let perfTtft = null;
  // How much of the answer has actually reached the browser, and whether a
  // device dropped this request into somebody else's lap. Both are read by the
  // fallback decision and both are reported to the client, because a person who
  // asked for their own machine is owed the news that it was not used.
  let emitted = 0;
  let byogFallbackFrom = null;
  let keyFailover = null;
  let residentDispatchId = null;

  try {
    let onDelta;
    if (wantStream) {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const mark = () => { if (perfTtft === null) perfTtft = Date.now() - perfT0; };
      onDelta = sanitizer
        ? d => { mark(); const c = sanitizer.push(d); if (c) { emitted++; res.write(`data: ${JSON.stringify({ delta: c })}\n\n`); } }
        : d => { mark(); emitted++; res.write(`data: ${JSON.stringify({ delta: d })}\n\n`); };
    }
    // A device can go away mid-sentence, so the request that depends on it gets
    // the one thing a URL never needs: a way to give up. The controller aborts
    // when the browser hangs up, which sends a cancel down the link so the
    // user's own machine stops generating for a page nobody is reading.
    const clientGone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) clientGone.abort(); });

    const explicitChoice = !!(model || req.body?.providerId || (req.body?.override && req.body.override[turnTask]));
    // What leaves the box. A provider on this machine or the person's own
    // device gets the conversation; anything else gets the brief (or, for a
    // plain conversation or a model chosen by hand, the recent thread), with
    // secrets removed and a last check that none are left.
    const outboundFor = r => {
      if (PROVIDERS_META[r.providerId].local) return { messages, fields: { system, messages } };
      if (!residentTurn) {
        const scrubbed = assertClean(messages.map(m => ({ ...m, content: typeof m.content === 'string' ? scrubSecrets(m.content) : m.content })));
        return { messages: scrubbed, fields: { system, messages: scrubbed } };
      }
      const out = prepareOutbound({ role: residentTurn.role, explicit: explicitChoice || hasImages, system, messages, project: residentGateway.projectContext(residentTurn) });
      assertClean(out.messages);
      return out;
    };
    residentDispatchId = residentDispatch(residentTurn, route, { explicit: explicitChoice, sent: outboundFor(route).fields });

    const runRoute = r => callProvider({
      providerId: r.providerId, model: r.model, key: r.key,
      system, messages: outboundFor(r).messages, maxTokens: effMaxTokens, onDelta,
      device: r.byog, userId: req.user.id, signal: r.providerId === 'byog' ? clientGone.signal : undefined,
    });

    // Failure policy (control/failover.js): a busy provider gets one more try,
    // then the next suitable one answers, but only before anything is on the
    // screen. Locked modes, a model the person chose and photo turns keep their
    // brain; a failing device falls back as before, and local-only stays local.
    const firstRoute = route;
    const nextRoute = (failed, error, failures) => {
      const exclude = new Set(failures.map(f => f.route));
      if (failed.providerId === 'byog') {
        const fallback = byogPolicy.mode === 'private'
          ? (byogPolicy.residentFallback && resident.available && (hasImages ? resident.visionModel : resident.chatModel)
              ? { providerId: 'ollama', model: hasImages ? resident.visionModel : resident.chatModel, key: '', source: 'platform', resident: true }
              : null)
          : routeForTask(turnTask, { byok, model, providerId: undefined, override: req.body?.override, resident, byogPick: null, byogFirst: false, exclude });
        if (!fallback) {
          audit(req.user.id, 'byog_no_fallback', req, `${error.code || 'error'}: ${error.message}`);
          const refusal = new Error(byogPolicy.mode === 'private'
            ? `${error.message} This account answers on your own computer only, so nothing was sent anywhere else.`
            : error.message);
          refusal.byogCode = error.code || 'device_failed';
          throw refusal;
        }
        audit(req.user.id, 'byog_fallback', req, `${error.code || 'error'} → ${fallback.providerId}/${fallback.model}`);
        byogFallbackFrom = { device: failed.byog ? failed.byog.name : null, code: error.code || 'device_failed', message: error.message };
        return fallback;
      }
      if (residentLocked || explicitChoice || hasImages || byogPolicy.mode === 'private') return null;
      const next = routeForTask(turnTask, { byok, providerId: undefined, override: undefined, resident, byogPick: null, byogFirst: false, exclude });
      if (next) audit(req.user.id, 'provider_failover', req, `${failed.providerId}/${failed.model} (${error.status || 'no answer'}) → ${next.providerId}/${next.model}`);
      return next;
    };
    const nextKeyRoute = (failed, _error, failures) => {
      const tried = new Set(failures.map(f => f.fingerprint).filter(Boolean));
      const alternate = (storedKeyRoutes[failed.providerId] || []).find(item => !tried.has(item.fingerprint));
      return alternate ? { ...failed, key: alternate.key, keyFingerprint: alternate.fingerprint } : null;
    };
    const attempt = await runWithFailover({
      first: route, run: runRoute, next: nextRoute, nextKey: nextKeyRoute,
      emitted: () => emitted, aborted: () => clientGone.signal.aborted,
      onFailure: (failed, error) => { error.message = scrubSecrets(error.message); console.log(`[ai] ${failed.providerId}/${failed.model} failed (${error.status || error.code || 'error'})`); },
      onKeyFailover: (_failed, alternate) => {
        keyFailover = { message: 'Tried another of your keys.', fingerprint: alternate.keyFingerprint };
        audit(req.user.id, 'provider_key_failover', req, scrubSecrets(`another of your keys (${alternate.keyFingerprint}) tried for ${alternate.providerId}/${alternate.model}`));
      },
    });
    const out = attempt.out;
    route = attempt.route;
    if (keyFailover && route.keyFingerprint === keyFailover.fingerprint) keyFailover.message = 'Answered with another of your keys.';
    const failoverFrom = attempt.failures.length ? attempt.failures : null;
    if (sanitizer) { const tail = sanitizer.flush(); if (tail) res.write(`data: ${JSON.stringify({ delta: tail })}\n\n`); }
    if (styleClean) out.text = sanitizeStyle(out.text);
    // Local inference (Ollama) is genuinely free regardless of model.
    const cost = PROVIDERS_META[route.providerId].local ? 0 : calcCost(route.model, out.inTok, out.outTok);
    const preview = usageLabel(residentTurn ? residentTurn.role : (task || mode || 'chat'), messages[messages.length - 1]?.content);
    const perfDur = Date.now() - perfT0;
    // The answer checked against the project's rules in force. A breach can't
    // be taken back once streamed, so it is recorded and reported with the
    // answer; a recommendation to change a rule waits for the person.
    let ruleReview = null;
    if (residentTurn) {
      try {
        const rules = residentGateway.projectContext(residentTurn);
        ruleReview = supervisor.review(out.text, { rules: [...rules.rules.decisions, ...rules.rules.constraints] });
        for (const proposal of ruleReview.proposals) {
          projectLedger.record(residentTurn.accountId, residentTurn.projectId, 'decision', { title: `Change "${proposal.title}"?`, text: proposal.text, supersedes: [proposal.ruleId] }, { actor: `model:${route.providerId}/${route.model}` });
        }
      } catch (error) { console.error('[resident] review', error.message); }
    }
    residentFinish(residentTurn, residentDispatchId, {
      costMicro: Math.round(cost * 1e6), latencyMs: perfDur, usage: { in: out.inTok, out: out.outTok },
      checks: [
        ...(byogFallbackFrom ? [{ name: 'device fallback', passed: false, detail: `answered by ${route.providerId}/${route.model}` }] : []),
        ...(failoverFrom ? failoverFrom.map(f => ({ name: `failed: ${f.route}`, passed: false, detail: `${f.status || 'no answer'}; ${keyFailover && f.fingerprint ? `another of your keys (${keyFailover.fingerprint}) was tried` : `answered by ${route.providerId}/${route.model}`}` })) : []),
        ...(ruleReview ? ruleReview.breaches.map(b => ({ name: `rule: ${b.title}`, passed: false, detail: b.found })) : []),
      ],
    });
    const perfAccel = PROVIDERS_META[route.providerId].device
      ? 'device'
      : PROVIDERS_META[route.providerId].local
        ? ((await getResident()).accel || 'cpu')
        : 'frontier';
    db.prepare(`INSERT INTO ai_usage
        (id,user_id,provider,model,in_tok,out_tok,cost,byok,task,preview,
         ttft_ms,dur_ms,gen_tps,endpoint,accel,concurrent)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uid(), req.user.id, route.providerId, route.model, out.inTok, out.outTok, cost,
        route.source === 'byok' ? 1 : 0, residentTurn ? turnTask : (task || mode || 'chat'), preview,
        perfTtft, perfDur,
        perfDur > 0 ? (out.outTok / (perfDur / 1000)) : null,
        // The endpoint column says where the work happened. For a device that
        // is the device, named by its id and never by an address, because
        // there is no address: the machine dialled us.
        PROVIDERS_META[route.providerId].device ? `byog:${route.byog ? route.byog.deviceId : 'unknown'}`
          : PROVIDERS_META[route.providerId].local ? PROVIDERS_META.ollama.base : route.providerId,
        perfAccel, perfConcurrent);
    const summary = {
      model: route.model, provider: route.providerId, source: route.source,
      usage: { in: out.inTok, out: out.outTok }, cost,
      ...(route.byog ? { device: route.byog.name } : {}),
      // The user asked for their own machine and did not get it. That is news,
      // not a detail, so it rides back with the answer rather than only landing
      // in a log the person will never read.
      ...(byogFallbackFrom ? { byogFallback: byogFallbackFrom } : {}),
      ...(keyFailover ? { keyFailover } : {}),
      ...(ruleReview && ruleReview.breaches.length ? { ruleBreaches: ruleReview.breaches.map(b => b.title) } : {}),
      ...(failoverFrom && firstRoute.providerId !== 'byog' ? { failover: { from: failoverFrom.map(f => f.route), answeredBy: `${route.providerId}/${route.model}` } } : {}),
      ...(ruleReview && ruleReview.proposals.length ? { ruleProposals: ruleReview.proposals.map(p => p.title) } : {}),
    };
    if (wantStream) {
      // The staged proposal rides the same stream as the text, after the
      // reply so the approval card lands under Echo's own sentence about it.
      if (stagedAction) res.write(`data: ${JSON.stringify({ action: publicControlAction(stagedAction) })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, ...summary })}\n\n`);
      res.end();
    } else {
      let reply = out.text;
      if (echoPipeline) {
        const read = echoProposals.extractProposal(reply);
        reply = read.text;
        if (read.malformed) {
          audit(req.user.id, 'assistant_op_block_unreadable', req, '');
          reply = `${reply}\n\n${echoProposals.refusalLine('I could not read my own request. Please say it again.')}`.trim();
        } else if (read.proposal) {
          try {
            const operation = opsCatalogue.OPERATIONS.find(o => o.id === read.proposal.operation);
            if (!operation) throw new Error(`There is no operation called ${read.proposal.operation} on this panel.`);
            const generate = echoProposals.paramsOf(operation).generate;
            stagedAction = await serverOps.propose(req.user.id, read.proposal.operation, read.proposal.input, opsContext(req), { generate });
            audit(req.user.id, 'assistant_op_proposed', req, stagedAction.label);
          } catch (error) {
            audit(req.user.id, 'assistant_op_proposal_refused', req, error.message);
            reply = `${reply}\n\n${echoProposals.refusalLine(error.message)}`.trim();
          }
        }
      }
      res.json({ reply, ...(stagedAction ? { action: publicControlAction(stagedAction) } : {}), ...summary });
    }
  } catch (e) {
    // Providers quote the key back in their refusals. That line goes to the
    // screen, the log and the record, so the key comes out of it first.
    e.message = scrubSecrets(e.message);
    console.error('[ai]', route.providerId, e.message);
    residentFinish(residentTurn, residentDispatchId, { error: e.message });
    const failure = { error: e.message, ...(e.byogCode || e.code ? { code: e.byogCode || e.code } : {}) };
    if (wantStream && res.headersSent) {
      res.write(`data: ${JSON.stringify(failure)}\n\n`);
      res.end();
    } else {
      res.status(502).json(failure);
    }
  } finally {
    // Must run on the error path too, or one failed generation permanently
    // inflates the in-flight count and every later row reports phantom load.
    AI_INFLIGHT = Math.max(0, AI_INFLIGHT - 1);
  }
});

// GET /admin/ai-health — what the analytics centre reads. Turns the performance
// columns on ai_usage into the three questions an operator actually has: is the
// pool keeping up, is it getting worse, and if it is then what do I do about it.
//
// The distinction the whole endpoint exists to draw: slow because the hardware
// is slow, versus slow because the hardware is busy. Those look identical on a
// latency chart and have opposite fixes, a faster card against another card, so
// latency is always reported against the concurrency it was measured at.
app.get('/admin/ai-health', operatorOrKey, (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || '24', 10) || 24, 24 * 30);
  const since = `-${hours} hours`;
  const pctl = (rows, key, p) => {
    const xs = rows.map(r => r[key]).filter(v => v != null).sort((a, b) => a - b);
    if (!xs.length) return null;
    return Math.round(xs[Math.min(xs.length - 1, Math.floor(p / 100 * (xs.length - 1)))]);
  };

  const rows = db.prepare(
    `SELECT ttft_ms, dur_ms, gen_tps, accel, concurrent, out_tok, user_id, cost
       FROM ai_usage WHERE ts >= datetime('now', ?)`).all(since);

  // Latency banded by how busy the box was, which is the bottleneck signal. If
  // the busy band is much worse than the quiet one, the pool is short of
  // capacity rather than short of speed.
  const quiet = rows.filter(r => (r.concurrent || 1) <= 1);
  const busy  = rows.filter(r => (r.concurrent || 1) >= 3);
  const band = rs => ({
    calls: rs.length, ttft_p50: pctl(rs, 'ttft_ms', 50), ttft_p95: pctl(rs, 'ttft_ms', 95),
    tps_p50: rs.length ? Math.round(pctl(rs, 'gen_tps', 50) * 10) / 10 : null,
  });

  const byUser = db.prepare(
    `SELECT user_id, COUNT(*) calls, SUM(out_tok) tok, ROUND(SUM(cost),4) cost
       FROM ai_usage WHERE ts >= datetime('now', ?)
      GROUP BY user_id ORDER BY tok DESC LIMIT 10`).all(since);
  const totalTok = byUser.reduce((n, u) => n + (u.tok || 0), 0) || 1;

  const peak = rows.reduce((m, r) => Math.max(m, r.concurrent || 0), 0);
  const q = band(quiet), b = band(busy);
  const degradation = (q.ttft_p95 && b.ttft_p95) ? Math.round(b.ttft_p95 / q.ttft_p95 * 10) / 10 : null;

  // Recommendations are deliberately few and each names its own evidence, so an
  // operator can disagree with the reasoning rather than just the conclusion.
  const recs = [];
  if (degradation && degradation >= 3) {
    recs.push({ severity: 'high', action: 'Add inference capacity',
      why: `Time to first token is ${degradation}x worse under load than at rest (${q.ttft_p95}ms quiet, ${b.ttft_p95}ms busy). That is queueing, not model speed, so a second card helps and a faster one mostly does not.` });
  } else if (degradation && degradation >= 1.8) {
    recs.push({ severity: 'watch', action: 'Capacity is tightening',
      why: `Loaded latency is ${degradation}x the quiet baseline. Not urgent, worth watching before it reaches 3x.` });
  }
  if (q.tps_p50 != null && q.tps_p50 < 10) {
    recs.push({ severity: 'high', action: 'Move off CPU inference',
      why: `Unloaded generation is ${q.tps_p50} tokens per second, below comfortable reading speed. A CPU pool cannot batch, so this does not improve with more customers on it, only with a GPU.` });
  }
  const hog = byUser[0];
  if (hog && byUser.length > 2 && hog.tok / totalTok > 0.4) {
    recs.push({ severity: 'watch', action: 'One account dominates the pool',
      why: `${hog.user_id} is ${Math.round(hog.tok / totalTok * 100)}% of all generated tokens. Consider moving them to their own pool, or a plan that prices what they use.` });
  }
  if (!rows.length) recs.push({ severity: 'info', action: 'No AI traffic in this window', why: 'Nothing to judge yet.' });

  res.json({
    window_hours: hours, calls: rows.length, peak_concurrency: peak,
    accel: [...new Set(rows.map(r => r.accel).filter(Boolean))],
    quiet: q, busy: b, degradation_ratio: degradation,
    top_users: byUser.map(u => ({ ...u, share: Math.round((u.tok || 0) / totalTok * 100) })),
    recommendations: recs,
  });
});

// GET /admin/ops — the vendor's own operations view. NOT the host-admin surface
// and never shipped to a customer: this watches OUR estate, the box under the
// public demo, so Steve is told a thing is cracking before it breaks rather than
// after a visitor finds it.
//
// Everything here is read from the machine at request time rather than from a
// metrics store, because one box does not need a metrics store and a thing that
// needs its own database to tell you the disk is full is a thing that fails when
// the disk is full.
//
// The contract that makes it useful: `concerns` is empty when nothing is wrong.
// An operator reads that array and nothing else. Every entry carries the number
// that triggered it, so a threshold can be argued with.
app.get('/admin/ops', operatorOrKey, async (req, res) => {
  const os = require('os');
  const { execSync } = require('child_process');
  const sh = (cmd, fallback = null) => {
    try { return execSync(cmd, { timeout: 4000, encoding: 'utf8' }).trim(); } catch { return fallback; }
  };
  const concerns = [];
  const warn = (severity, what, why) => concerns.push({ severity, what, why });

  // ── Host ────────────────────────────────────────────────────────
  const cores = os.cpus().length;
  const load1 = os.loadavg()[0];
  const memTotal = os.totalmem(), memFree = os.freemem();
  const memUsedPct = Math.round((1 - memFree / memTotal) * 100);
  const diskLine = sh("df -P / | tail -1");
  const diskPct = diskLine ? parseInt(diskLine.split(/\s+/)[4], 10) : null;
  const uptimeDays = Math.round(os.uptime() / 86400 * 10) / 10;

  if (diskPct != null && diskPct >= 80) {
    warn(diskPct >= 90 ? 'critical' : 'warn', 'Disk filling',
      `Root is ${diskPct}% full. Models, logs and the SQLite WAL all grow quietly.`);
  }
  if (memUsedPct >= 90) warn('warn', 'Memory tight', `${memUsedPct}% of RAM in use.`);
  if (load1 > cores * 1.5) {
    warn('warn', 'Sustained load',
      `Load average ${load1.toFixed(2)} against ${cores} cores. On this box that usually means inference is saturated.`);
  }

  // ── Services ────────────────────────────────────────────────────
  //
  // These used to be the units the JotNotes box ran, so a fresh Arca panel
  // opened its operator screen to three critical alarms about services it was
  // never meant to have. An operator who is shown a red screen on day one for
  // reasons that are not real learns to ignore the screen, which is worse than
  // having no screen at all.
  //
  // `is-active` exits non-zero for a unit that is stopped and for one that was
  // never installed, and those are different facts, so the load state is asked
  // for first and an absent unit says so rather than reading as a failure.
  const unitState = u => {
    const load = sh(`systemctl show -p LoadState --value ${u}`, 'not-found');
    if (load !== 'loaded') return 'not installed';
    return sh(`systemctl is-active ${u}`, 'inactive');
  };
  const REQUIRED_UNITS = ['jotpanel', 'jotpanel-ops', 'nginx'];
  // Not part of the panel. Reported when a box happens to run them, never
  // alarmed about, because the panel is the whole product without them.
  const OPTIONAL_UNITS = ['ollama', 'arca-license'];
  const services = {};
  for (const u of REQUIRED_UNITS) {
    services[u] = unitState(u);
    if (services[u] !== 'active') warn('critical', `${u} is ${services[u]}`, 'A service this panel needs is not running.');
  }
  for (const u of OPTIONAL_UNITS) {
    const state = unitState(u);
    if (state !== 'not installed') services[u] = state;
  }
  const ttsUp = await fetch(TTS_BASE + '/health', { signal: AbortSignal.timeout(1200) })
    .then(r => r.ok).catch(() => false);
  // The voice belongs to the desktop. A panel install has no Echo to speak.
  if (!ttsUp && SHELL === 'desktop') warn('info', 'Voice service down', 'Echo falls back to the browser voice, which sounds like 1950s text to speech.');

  // ── Certificate ─────────────────────────────────────────────────
  // Read the certificate off the live TLS connection rather than off disk.
  // /etc/letsencrypt is root-only because the private key is in there, and the
  // unit sets NoNewPrivileges, so sudo is not available and should not be made
  // available. Connecting to ourselves needs no privileges at all and is the
  // better check anyway: it sees the certificate nginx is actually serving,
  // which is the one that expires on a visitor rather than the one in a folder.
  let certDays = null;
  try {
    certDays = await new Promise((resolve, reject) => {
      const sock = require('tls').connect(
        { host: '127.0.0.1', port: 443, servername: process.env.DOMAIN, rejectUnauthorized: false },
        () => {
          const cert = sock.getPeerCertificate();
          sock.end();
          resolve(cert && cert.valid_to
            ? Math.round((new Date(cert.valid_to) - Date.now()) / 86400000) : null);
        });
      sock.setTimeout(3000, () => { sock.destroy(); reject(new Error('tls timeout')); });
      sock.on('error', reject);
    });
  } catch { certDays = null; }
  if (certDays != null && certDays < 21) {
    warn(certDays < 7 ? 'critical' : 'warn', 'Certificate expiring',
      `${certDays} days left on the certificate nginx is serving. Renewal is supposed to be automatic, so this means it is not.`);
  }

  // ── The Resident, and whether the warm is actually firing ───────
  const resident = await getResident();
  const lastWarm = sh(`journalctl -u arca --since "40 min ago" --no-pager 2>/dev/null | grep -c "Local model warmed"`, '0');
  if (resident.available && parseInt(lastWarm, 10) === 0) {
    warn('warn', 'Warm has stopped firing',
      'No warm logged in 40 minutes against a 20 minute timer. The next visitor pays the full cold prefill, which was measured at 161 seconds on this box.');
  }
  // The Resident is the upgrade, not the panel. A panel install having none is
  // the normal, correct state and was being reported as a critical fault.
  if (!resident.available && SHELL === 'desktop') {
    warn('critical', 'No local model', 'Echo cannot answer. The public link signs people in and then fails them.');
  }

  // ── AI health, reusing the banding from /admin/ai-health ────────
  const perf = db.prepare(
    `SELECT ttft_ms, concurrent FROM ai_usage WHERE ts >= datetime('now','-24 hours') AND ttft_ms IS NOT NULL`).all();
  const med = xs => xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
  const quietT = med(perf.filter(r => (r.concurrent || 1) <= 1).map(r => r.ttft_ms));
  const busyT  = med(perf.filter(r => (r.concurrent || 1) >= 3).map(r => r.ttft_ms));
  const degradation = (quietT && busyT) ? Math.round(busyT / quietT * 10) / 10 : null;
  if (degradation && degradation >= 3) {
    warn('warn', 'Pool is queueing', `Loaded latency is ${degradation}x the quiet baseline. Capacity, not model speed.`);
  }

  // ── Backups ─────────────────────────────────────────────────────
  //
  // This looked for `.db` files in a directory belonging to a different
  // product, on a path that does not exist here, and reported "no database
  // backup exists" on every box including ones with a working schedule. It also
  // measured the panel's database at a path the panel does not use, so the size
  // it printed was always zero. Both now read the real thing: the database this
  // process actually opened, and the backup health the panel already keeps.
  const dbPath = PANEL_DB_PATH;
  const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  let backupAccounts = 0, backupUnhealthy = 0, openIncidents = 0, newestVerified = null;
  try {
    const health = backupHealth.listHealth();
    backupAccounts = health.length;
    backupUnhealthy = health.filter(row => row.status && row.status !== 'healthy').length;
    openIncidents = backupHealth.listIncidents({ state: 'open' }).length;
    for (const row of health) {
      if (row.last_verified_at && (!newestVerified || row.last_verified_at > newestVerified)) newestVerified = row.last_verified_at;
    }
  } catch { backupAccounts = -1; }
  const backupAgeH = newestVerified ? Math.round((Date.now() - Date.parse(newestVerified)) / 3600000) : null;
  if (backupAccounts === -1) {
    warn('info', 'Backup health could not be read', 'The operator screen is showing nothing rather than showing zero.');
  } else if (backupAccounts === 0) {
    warn('warn', 'Nothing on this box is backed up', 'No account has a backup schedule. One bad disk is the whole server.');
  } else {
    if (openIncidents) warn('critical', `${openIncidents} open backup incident${openIncidents === 1 ? '' : 's'}`, 'A backup has failed and the failure has not been dealt with.');
    else if (backupUnhealthy) warn('warn', `${backupUnhealthy} account${backupUnhealthy === 1 ? '' : 's'} not backing up cleanly`, 'The schedule exists but the last run did not end healthy.');
    if (backupAgeH != null && backupAgeH > 48) warn('warn', 'Newest verified backup is old', `The most recent verified backup on this box is ${backupAgeH} hours old.`);
  }

  // ── Who is knocking ─────────────────────────────────────────────
  // These read root-owned files. If the service user cannot read them the honest
  // answer is "unreadable", never 0, because a dashboard reporting zero attacks
  // when it simply cannot see the log is worse than showing nothing at all.
  const readable = f => { try { fs.accessSync(f, fs.constants.R_OK); return true; } catch { return false; } };
  const NGINX_LOG = '/var/log/nginx/access.log';
  const probes = readable(NGINX_LOG)
    ? parseInt(sh(`grep -acE '/\\.env|/\\.git|/config\\.json|wp-login|/vendor/' ${NGINX_LOG}`, '0'), 10)
    : 'unreadable';
  const sshRaw = sh(`journalctl -u ssh --since "24 hours ago" --no-pager 2>/dev/null | grep -ci "failed\\|invalid user"`);
  const sshFails = sshRaw === null ? 'unreadable' : parseInt(sshRaw, 10);
  if (probes === 'unreadable' || sshFails === 'unreadable' || certDays === null) {
    warn('info', 'Some checks cannot see their source',
      'The service user lacks read access to the nginx log, the ssh journal or the certificate, so those readings are absent rather than clean. Grant read access or stop trusting those fields.');
  }

  res.json({
    checked_at: new Date().toISOString(),
    host: { cores, load1: Math.round(load1 * 100) / 100, mem_used_pct: memUsedPct,
            disk_used_pct: diskPct, uptime_days: uptimeDays },
    services: { ...services, tts: ttsUp ? 'active' : 'down' },
    // Which of those this panel actually needs. Without it a surface has to
    // guess, and the guess it makes is that everything listed is required, so
    // an optional service that is off reads as a fault in red.
    service_roles: Object.fromEntries([
      ...REQUIRED_UNITS.map(u => [u, 'required']),
      ...OPTIONAL_UNITS.filter(u => u in services).map(u => [u, 'optional']),
      ['tts', 'optional'],
    ]),
    tls: { days_remaining: certDays },
    resident: { available: resident.available, model: resident.chatModel, accel: resident.accel || null,
                warms_last_40min: parseInt(lastWarm, 10) },
    ai: { calls_24h: perf.length, ttft_quiet_ms: quietT, ttft_busy_ms: busyT, degradation_ratio: degradation },
    data: {
      db_mb: Math.round(dbSize / 1048576 * 10) / 10,
      newest_backup_hours: backupAgeH,
      backup_accounts: backupAccounts === -1 ? null : backupAccounts,
      backup_unhealthy: backupAccounts === -1 ? null : backupUnhealthy,
      backup_open_incidents: backupAccounts === -1 ? null : openIncidents,
    },
    noise: { scanner_hits: probes, ssh_failures_24h: sshFails },
    concerns,
    verdict: concerns.some(c => c.severity === 'critical') ? 'attention needed'
           : concerns.length ? 'watch' : 'healthy',
  });
});

// ── Reseller packages and entitlements ──────────────────────────────
// Every write here is a catalogue operation, proposed, approved, executed and
// read back, exactly like restarting a service. It was not always: these
// started as direct routes that wrote an audit line, on the reasoning that
// nothing on the machine changes when a limit moves. That reasoning was wrong
// in the way that matters. What changes is what a customer is allowed to have,
// and "who raised this account's limit, when, and who approved it" is a
// question a hosting company gets asked six months later by somebody holding
// an invoice. An audit line is a note. The record is evidence.
//
// The two exceptions are deliberate and are not policy writes: reading an
// account's entitlements, and measuring its disk. Measuring writes a row, but
// what it writes is an observation of the machine with the time it was taken,
// not a decision about anybody, and it is the documented way to clear a refusal
// that said the figures were too old.
function actorOrg(req) {
  const membership = ownership.getMembership(req.user.id);
  if (!membership) throw Object.assign(new Error('No organization membership'), { status: 400 });
  return membership;
}

// One shape for all of them: propose through serverOps, and hand back the card.
// Approval and execution go through the same two endpoints every other
// operation uses, so there is no second path to keep in step.
async function proposeEntitlementChange(req, res, operation, input) {
  try {
    const action = await serverOps.propose(req.user.id, operation, input, opsContext(req));
    audit(req.user.id, 'entitlement_change_proposed', req, `${operation}: ${action.label}`);
    res.json({ ok: true, action: publicControlAction(action) });
  } catch (error) {
    audit(req.user.id, 'entitlement_change_refused', req, `${operation}: ${error.message}`);
    res.status(error.forbidden ? 403 : 400).json({ error: error.message, code: error.entitlementCode || null });
  }
}

app.post('/api/organizations/:targetOrgId/link', auth, (req, res) =>
  proposeEntitlementChange(req, res, 'entitlements.organization.link', { targetOrgId: req.params.targetOrgId }));

app.post('/api/entitlements/packages', auth, (req, res) =>
  proposeEntitlementChange(req, res, 'entitlements.package.create', {
    name: req.body?.name, description: req.body?.description, limits: req.body?.limits,
  }));

app.put('/api/organizations/:targetOrgId/package-assignment', auth, (req, res) =>
  proposeEntitlementChange(req, res, 'entitlements.package.assign', {
    targetOrgId: req.params.targetOrgId, packageId: req.body?.packageId,
  }));

app.post('/api/entitlements/packages/:packageId/archive', auth, (req, res) =>
  proposeEntitlementChange(req, res, 'entitlements.package.archive', { packageId: req.params.packageId }));

app.put('/api/organizations/:targetOrgId/overrides/:metric', auth, (req, res) =>
  proposeEntitlementChange(req, res, 'entitlements.account_limit.override', {
    targetOrgId: req.params.targetOrgId, metric: req.params.metric,
    unlimited: !!req.body?.unlimited, maximum: req.body?.maximum,
    reserved: req.body?.reserved, downstreamPolicy: req.body?.downstream_policy, reason: req.body?.reason,
  }));

app.delete('/api/organizations/:targetOrgId/overrides/:metric', auth, (req, res) =>
  proposeEntitlementChange(req, res, 'entitlements.account_limit.override.clear', {
    targetOrgId: req.params.targetOrgId, metric: req.params.metric,
  }));

// Measuring disk, on request. Not a policy write: it records what the machine
// says, with the time it was said, and it is the answer to a refusal that named
// stale figures. Deliberately not run on every read, because a `du` across every
// site on the box is not something a page load should set off.
app.post('/api/organizations/:targetOrgId/usage/refresh', auth, async (req, res) => {
  try {
    const actor = actorOrg(req);
    // The same reach the operations path uses, asked of the same service rather
    // than spelled out again here.
    if (!ownership.withinReach(actor, req.params.targetOrgId)) {
      return res.status(403).json({ error: req.t('Not authorized to measure this organization') });
    }
    const orgIds = entitlements.getSubtreeOrgIds(req.params.targetOrgId);
    const result = await entitlements.refreshStorageReadings(orgIds);
    const measured = entitlements.readStorage(orgIds);
    audit(req.user.id, 'entitlement_usage_refreshed', req, `${req.params.targetOrgId}: ${result.measured} measured, ${result.failed} could not be`);
    res.json({ ok: true, ...result, managed_storage_bytes: measured.bytes, could_not_measure: measured.unusable });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

// The accounts beneath this one, with who they are and what they are on. The
// panel's reseller screen is built from this: without it the only way to find a
// customer's organization id is to read the database, which is not a feature.
app.get('/api/organizations', auth, (req, res) => {
  try {
    const actor = actorOrg(req);
    const subtree = entitlements.getSubtreeOrgIds(actor.orgId).filter(id => id !== actor.orgId);
    const accounts = subtree.map(id => {
      const members = db.prepare(`SELECT u.id, u.email, u.name, u.suspended FROM memberships m JOIN users u ON u.id = m.identity_id WHERE m.org_id=?`).all(id);
      const assignment = db.prepare(`SELECT a.package_id, p.name AS package_name, a.assigned_at
        FROM account_package_assignments a JOIN packages p ON p.id = a.package_id
        WHERE a.target_org_id=? AND a.status='active'`).get(id);
      return {
        org_id: id,
        // An organization can hold more than one login. The first is enough to
        // recognise it by, and the count says when there are others rather
        // than pretending the first is the whole story.
        people: members.map(m => ({ id: m.id, email: m.email, name: m.name })),
        // An organization is suspended when everyone who can sign in to it is.
        // Reported so the screen can offer the right one of stop and start
        // rather than offering both and letting the person guess.
        suspended: members.length > 0 && members.every(m => !!m.suspended),
        package: assignment ? { id: assignment.package_id, name: assignment.package_name, assigned_at: assignment.assigned_at } : null,
        direct: entitlements.getDirectParent(id) === actor.orgId,
      };
    });
    const packages = db.prepare(`SELECT id, name, status, created_at FROM packages WHERE owner_org_id=? ORDER BY created_at DESC`).all(actor.orgId);
    res.json({ org_id: actor.orgId, role: actor.role, accounts, packages, metrics: entitlements.enabledMetrics().map(m => ({ metric: m.metric_key, unit: m.unit })) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.get('/api/organizations/:targetOrgId/entitlements', auth, async (req, res) => {
  try {
    const membership = ownership.getMembership(req.user.id);
    if (!ownership.withinReach(membership, req.params.targetOrgId)) {
      return res.status(403).json({ error: req.t('Not authorized to view this organization\'s entitlements') });
    }
    res.json({ org_id: req.params.targetOrgId, metrics: await entitlements.usageReport(req.params.targetOrgId) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

// GET /admin/tenants — the business half of the console. /admin/ops answers
// "is the box well", this answers "who is on it, what are they using and what
// does it cost me". Everything here is read from the tables that already
// record it, so a number on this screen can always be traced to a row.
//
// Two absences are reported rather than hidden, because a hoster console that
// implies a capability it does not have is worse than one that says the word
// none: the approval queue is in memory, so it empties on restart, and there
// is no licence issuing at all yet.
// ── The Admin app's own two routes ───────────────────────────────
//
// The desktop Admin app has called these since it was written and neither has
// ever existed on this backend, so that surface has been dead against this
// server: it asks for an admin key, sends it, and gets a 404 dressed up as a
// refusal. Built here, and gated on who is signed in rather than on a key
// somebody pasted into local storage.
app.get('/admin/api/accounts', operatorOnly, async (req, res) => {
  try {
    audit(req.user.id, 'operator_accounts_read', req);
    res.json(await computeTenantRows());
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// The audit trail, newest first. It is the record of who did what on this
// machine, so it is the operator's and nobody else's, and reading it is itself
// written down.
app.get('/admin/api/audit', operatorOnly, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const action = typeof req.query.action === 'string' && req.query.action !== 'all' ? req.query.action : null;
  const rows = action
    ? db.prepare('SELECT id,user_id,action,ip,details,ts FROM audit_log WHERE action=? ORDER BY id DESC LIMIT ?').all(action, limit)
    : db.prepare('SELECT id,user_id,action,ip,details,ts FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  // Names, so a row reads as a person rather than as an identifier. Resolved
  // from the accounts that exist now; an entry whose account is gone keeps the
  // id, because the record is not rewritten when somebody leaves.
  const names = new Map(db.prepare('SELECT id,email FROM users').all().map(u => [u.id, u.email]));
  audit(req.user.id, 'operator_audit_read', req, `${rows.length} entries`);
  res.json(rows.map(row => ({ ...row, email: names.get(row.user_id) || null })));
});

// The tenant rows, computed once and read by both surfaces that want them: the
// console at /admin/tenants and the account list the Admin app draws. Factored
// out rather than written twice, because these numbers were audited row by row
// on 21 August against their real sources and a second copy would be a second
// thing to audit. See docs/HOSTER_ADMIN_VERIFICATION.md.
async function computeTenantRows() {

  const monthStart = new Date().toISOString().slice(0, 7) + '-01';

  // One pass per fact, joined in JS. These tables are small and staying with
  // vanilla SQL keeps the zip-and-run promise intact.
  const users = db.prepare(
    `SELECT id, name, email, plan, subdomain, storage_gb, created_at, suspended FROM users ORDER BY created_at DESC`).all();
  // Sites and their storage come from the authorization ledger
  // (resource_owners / memberships), not from the `sites` or `files` tables
  // — those belong to the older desktop-OS product and the server-ops panel
  // never writes to them. See control/tenantMetrics.js for why.
  const { domainsByIdentity } = siteOwnershipByIdentity({ db });
  const { databasesByIdentity } = databaseOwnershipByIdentity({ db });
  const allOwnedDomains = [...new Set([...domainsByIdentity.values()].flat())];
  const runJob = (job, params) => privilegedOps.run(job, params);
  const storageBy = await siteStorageBytes({ domains: allOwnedDomains, runPrivilegedJob: runJob })
    .catch(() => new Map()); // a storage read failing must not take the whole admin view down
  // Mailboxes and backups are both keyed by domain on the box, not by
  // identity, so these are counted per domain once and then summed under
  // whichever account owns that domain — same fail-soft rule as storage: one
  // of these being unreadable must not blank the rest of the admin view.
  const mailboxCountsBy = await mailboxCountsByDomain({ runPrivilegedJob: runJob }).catch(() => new Map());
  const backupCountsBy = await backupCountsByDomain({ runPrivilegedJob: runJob }).catch(() => new Map());
  const spendBy = new Map(db.prepare(
    `SELECT user_id, COALESCE(SUM(cost),0) cost, COALESCE(SUM(in_tok+out_tok),0) tok, COUNT(*) calls,
            SUM(CASE WHEN byok=1 THEN 1 ELSE 0 END) byok_calls
       FROM ai_usage WHERE ts >= ? GROUP BY user_id`).all(monthStart)
    .map(r => [r.user_id, r]));
  const seenBy = new Map(db.prepare(
    `SELECT user_id, MAX(ts) ts FROM audit_log GROUP BY user_id`).all().map(r => [r.user_id, r.ts]));

  const cap = Number(process.env.AI_MONTHLY_CAP_USD || 0);
  const tenants = users.map(u => {
    const s = spendBy.get(u.id) || { cost: 0, tok: 0, calls: 0, byok_calls: 0 };
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      plan: u.plan,
      subdomain: u.subdomain,
      created_at: u.created_at,
      suspended: !!u.suspended,
      last_seen: seenBy.get(u.id) || null,
      sites: (domainsByIdentity.get(u.id) || []).length,
      databases: (databasesByIdentity.get(u.id) || []).length,
      mailboxes: (domainsByIdentity.get(u.id) || []).reduce((n, d) => n + (mailboxCountsBy.get(d) || 0), 0),
      backups: (domainsByIdentity.get(u.id) || []).reduce((n, d) => n + (backupCountsBy.get(d) || 0), 0),
      storage: {
        used_mb: Math.round((domainsByIdentity.get(u.id) || [])
          .reduce((n, d) => n + (storageBy.get(d) || 0), 0) / 1048576 * 10) / 10,
        unmeasured: (domainsByIdentity.get(u.id) || []).filter(d => storageBy.get(d) == null),
        quota_gb: u.storage_gb,
      },
      ai_month: {
        calls: s.calls,
        tokens: s.tok,
        // Platform spend only. BYOK calls run on the customer's own key and
        // cost the host nothing, so folding them in would overstate the bill.
        cost_usd: Math.round(s.cost * 10000) / 10000,
        byok_calls: s.byok_calls,
        cap_usd: cap || null,
        over_cap: cap > 0 && s.cost >= cap,
      },
    };
  });
  return tenants;
}


app.get('/admin/tenants', operatorOnly, async (req, res) => {
  const tenants = await computeTenantRows();
  // Read from the environment in both places rather than threaded out of the
  // rows, because it is the deployment's setting and not a fact about a tenant.
  const cap = Number(process.env.AI_MONTHLY_CAP_USD || 0);

  const fleet = {
    accounts: tenants.length,
    suspended: tenants.filter(t => t.suspended).length,
    active_30d: tenants.filter(t => t.last_seen && (Date.now() - Date.parse(t.last_seen)) < 30 * 86400000).length,
    sites: tenants.reduce((n, t) => n + t.sites, 0),
    databases: tenants.reduce((n, t) => n + t.databases, 0),
    mailboxes: tenants.reduce((n, t) => n + t.mailboxes, 0),
    backups: tenants.reduce((n, t) => n + t.backups, 0),
    storage_used_mb: Math.round(tenants.reduce((n, t) => n + t.storage.used_mb, 0) * 10) / 10,
    ai_month_cost_usd: Math.round(tenants.reduce((n, t) => n + t.ai_month.cost_usd, 0) * 10000) / 10000,
    ai_month_tokens: tenants.reduce((n, t) => n + t.ai_month.tokens, 0),
  };

  // What the platform charges on top, and on whose key. The margin question a
  // hoster asks first, answered from the config they set rather than a guess.
  const cfgRow = db.prepare('SELECT * FROM routing_table WHERE id=2').get();
  let cfg = {};
  try { cfg = cfgRow && cfgRow.data ? JSON.parse(cfgRow.data) : {}; } catch { cfg = {}; }
  const commerce = {
    label: cfg.label || null,
    markup_pct: cfg.markup != null ? cfg.markup : null,
    byok_allowed: hostAllowsByok(),
    platform_key_set: !!cfg.platformKey,
    monthly_cap_usd: cap || null,
    billed_amount_usd: Math.round(fleet.ai_month_cost_usd * (1 + (cfg.markup || 0) / 100) * 10000) / 10000,
  };

  const queue = provisioning.listActions({});
  const byStatus = queue.reduce((m, a) => { m[a.status] = (m[a.status] || 0) + 1; return m; }, {});

  res.json({
    checked_at: new Date().toISOString(),
    fleet,
    commerce,
    tenants,
    provisioning: {
      adapter: (provisioning.adapter && provisioning.adapter.name) || 'unknown',
      counts: byStatus,
      recent: queue.slice(0, 8).map(a => ({
        id: a.id, label: a.label, status: a.status, account: a.cpanelUser || a.accountId, at: a.createdAt })),
      durable: true,
      note: 'Proposals, approvals, rejections, verified results and failures are encrypted and survive restarts.',
    },
    licensing: { supported: true, ...licenseClient.localStatus(), note: 'Licence state gates the thinking-service connection only; the panel remains available.' },
    audit_recent: db.prepare(
      `SELECT user_id, action, ip, details, ts FROM audit_log ORDER BY ts DESC LIMIT 12`).all(),
  });
});

// POST /api/ai/transcribe — the Resident ear. Takes 16kHz mono WAV recorded in
// the browser, returns the text. Local Whisper, so speech never leaves the box.
app.post('/api/ai/transcribe', auth, express.raw({ type: ['audio/wav', 'audio/*'], limit: '32mb' }), async (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: req.t('wav audio required') });
  try {
    // No registration gate here. This is the box's own Whisper, on the box's own
    // CPU, and the audio never leaves the machine — there is nothing of ours in
    // the path to license. Asking someone to register with us before their own
    // computer will listen to them is a toll, not a licence condition.
    const r = await fetch(TTS_BASE + '/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: req.body,
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `stt ${r.status}`);
    res.json({ text: data.text || '' });
  } catch {
    res.status(503).json({ error: req.t('Echo listening is not available') });
  }
});

// GET /api/ai/catalogue — the three states, kept apart.
//
// `documented` is ours and comes from the catalogue. `available` is the
// customer's, discovered with their own key, and is the only thing that lets a
// model be offered. `tested` is observed, recorded when a call through this
// panel actually succeeded.
//
// Discovery costs a request to each provider, so an answer is held briefly per
// key. The cache is keyed on the key's fingerprint, so replacing a key asks
// again immediately rather than showing the old plan's models.
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map();

function testedModelsFor(userId, providerId) {
  try {
    const rows = db.prepare('SELECT model_id FROM provider_model_tests WHERE user_id=? AND provider_id=?').all(userId, providerId);
    return new Set(rows.map(r => r.model_id));
  } catch { return new Set(); }
}

function recordModelTested(userId, providerId, modelId) {
  if (!userId || !providerId || !modelId) return;
  try {
    db.prepare(`INSERT INTO provider_model_tests (user_id, provider_id, model_id, tested_at)
                VALUES (?,?,?,?)
                ON CONFLICT(user_id, provider_id, model_id) DO UPDATE SET tested_at=excluded.tested_at`)
      .run(userId, providerId, modelId, new Date().toISOString());
  } catch (error) { console.error('[catalogue] a successful call could not be recorded:', error.message); }
}

// POST /api/ai/catalogue/test — prove one model, with the customer's own key.
//
// "Tested" has to be earnable, or it is just another word for "documented".
// This sends the smallest real request the adapter can make and records the
// result only if it came back. A failure is reported as what the provider said,
// because "it does not work" and "your key cannot use this one" are different
// problems with different fixes.
app.post('/api/ai/catalogue/test', auth, async (req, res) => {
  const providerId = String(req.body?.provider || '');
  const model = String(req.body?.model || '');
  if (!PROVIDERS_META[providerId]) return res.status(400).json({ error: req.t('That provider is not one this panel speaks to.') });
  if (!model) return res.status(400).json({ error: req.t('Name the model to test.') });

  const resolved = providerKeys.resolveAll(providerId, [{ kind: 'identity', id: req.user.id }]);
  const holder = Array.isArray(resolved) ? resolved.find(r => r && r.key) : null;
  if (!holder) return res.status(400).json({ error: req.t('Add a key for this provider first.') });

  try {
    await callProvider({
      providerId, model, key: holder.key,
      system: 'Answer with the single word OK.',
      messages: [{ role: 'user', content: 'OK' }],
      maxTokens: 5,
      userId: req.user.id,
    });
    audit(req.user.id, 'provider_model_tested', req, `${providerId}/${model}`);
    res.json({ ok: true, provider: providerId, model });
  } catch (error) {
    audit(req.user.id, 'provider_model_test_failed', req, scrubSecrets(`${providerId}/${model}: ${error.message}`));
    res.status(400).json({ ok: false, error: scrubSecrets(String(error.message || 'the provider refused')).slice(0, 200) });
  }
});

app.get('/api/ai/catalogue', auth, async (req, res) => {
  const wanted = typeof req.query.provider === 'string' ? [req.query.provider] : modelCatalogue.providerIds();
  const out = {};
  for (const providerId of wanted) {
    if (!modelCatalogue.provider(providerId)) continue;
    const resolved = providerKeys.resolveAll(providerId, [{ kind: 'identity', id: req.user.id }], { markUsed: false });
    const holder = Array.isArray(resolved) ? resolved.find(r => r && r.key) : null;
    const fingerprint = holder ? holder.fingerprint || 'held' : null;

    let discovered = null;
    if (holder && holder.key) {
      const cacheKey = `${req.user.id}:${providerId}:${fingerprint}`;
      const hit = discoveryCache.get(cacheKey);
      if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) discovered = hit.result;
      else {
        discovered = await providerModels.discover(modelCatalogue.discoveryFor(providerId), holder.key);
        discoveryCache.set(cacheKey, { at: Date.now(), result: discovered });
      }
    }
    out[providerId] = offerFor({
      catalogue: modelCatalogue,
      providerId,
      discovered,
      tested: testedModelsFor(req.user.id, providerId),
    });
    out[providerId].has_key = !!holder;
  }
  res.json({ as_of: modelCatalogue.asOf(), updatable_at: modelCatalogue.overriddenBy() || null, providers: out });
});

// GET /api/ai/meta — non-sensitive info the UI needs: which providers the
// platform supplies a key for, and the spend/cap. No keys, no prompts.
app.get('/api/ai/meta', auth, async (req, res) => {
  const byogDevices = byog.listDevices(req.user.id);
  const byogOnline = byogDevices.filter(d => d.online);
  const providers = Object.keys(PROVIDERS_META).map(id => ({
    id,
    // A device is only "available" when one is actually connected. Reporting it
    // as present because the provider exists in the map would put a brain in
    // the picker that cannot answer.
    platform: PROVIDERS_META[id].device
      ? byogOnline.length > 0
      : !!(PROVIDERS_META[id].envKey && process.env[PROVIDERS_META[id].envKey]) || !!PROVIDERS_META[id].local,
    local: !!PROVIDERS_META[id].local,
    device: !!PROVIDERS_META[id].device,
    region: PROVIDERS_META[id].region || null,
  }));
  // Does the user have a usable Frontier key (platform env or their own BYOK)?
  // Held keys are counted, never read: `list` returns fingerprints and labels,
  // so answering "do you have one" costs nothing and reveals nothing.
  const held = new Set(providerKeys.list({ kind: 'identity', id: req.user.id }).map(k => k.provider_id));
  const hasFrontier = Object.keys(PROVIDERS_META).some(id => !PROVIDERS_META[id].local && ((PROVIDERS_META[id].envKey && process.env[PROVIDERS_META[id].envKey]) || held.has(id)));
  const licence = await licenseClient.thinkingAccess();
  res.json({
    providers, resident: await getResident(), hasFrontier, byokAllowed: hostAllowsByok(),
    byog: { devices: byogDevices, policy: byog.readPolicy(req.user.id), online: byogOnline.length },
    cap: monthlyCap(req.user.id), spent: spentThisMonth(req.user.id), routes: liveRoutes(), license: licence,
    assistantOps: { ...assistantOpsPolicy(req.user.id), operations: assistantProposals.OPERATIONS },
    // Whether this box can hear. Whisper is an optional install, so the panel
    // asks rather than offering a microphone button that can only fail.
    listening: await canListen(),
  });
});

// ── THE RESIDENT VOICE — local Kokoro TTS ─────────────────────────
// A small Python service (tts/tts_server.py) synthesizes Echo's voice on this
// machine, so the free tier speaks naturally and nothing leaves the box. It is
// spawned here when the venv exists and everything degrades cleanly when not.
// 9997, not 9998, and the difference matters more than it looks.
//
// This defaulted to 9998, which is also `JOTPANEL_BOOTSTRAP_PORT`'s default: the
// loopback surface that creates the machine's first owner. Two services, one
// port, and which one got it was a race between this spawn and that listener.
//
// It cannot bite a supported GA installation as installed, because
// `build-customer-bundle.sh` excludes `app/backend/tts/venv` and this only
// starts when that virtual environment exists. But the bundle DOES ship
// `app/backend/tts/setup.sh`, whose whole job is to create it, so a GA box is
// one documented command away from the condition. If this side won the race
// there, the bootstrap surface would be gone: creating the first owner, the
// single-use sign-in link, clearing a second factor and the usage feed all
// answer there, and a reinstall could not make an owner at all.
//
// Observed on the proof box of 2026-08-30, which had the venv on it from a
// developer push: the bootstrap listener won and TTS lost silently. Winning a
// race is not the same as not having one.
const TTS_PORT = parseInt((process.env.JOTPANEL_TTS_PORT ?? process.env.ARCA_TTS_PORT) || '9997');
const TTS_BASE = `http://127.0.0.1:${TTS_PORT}`;

// Asked on a screen load, so it answers fast or not at all: a box without the
// speech service must not make the panel wait on a dead port.
let listeningProbe = { at: 0, ok: false };
async function canListen() {
  if (Date.now() - listeningProbe.at < 60000) return listeningProbe.ok;
  let ok = false;
  try { ok = (await fetch(`${TTS_BASE}/health`, { signal: AbortSignal.timeout(700) })).ok; } catch { ok = false; }
  listeningProbe = { at: Date.now(), ok };
  return ok;
}
(function startResidentVoice() {
  // The venv and the weights are state and live beside the database, because an
  // upgrade replaces the application tree and used to take an installed voice
  // with it. The server script is code and stays in the tree, so an upgrade
  // updates it exactly as it should.
  const voiceState = process.env.JOTPANEL_TTS_STATE || path.join(DATA_DIR, 'tts');
  const py     = path.join(voiceState, 'venv', 'bin', 'python');
  const script = path.join(__dirname, 'tts', 'tts_server.py');
  if (!fs.existsSync(py) || !fs.existsSync(script)) return;
  fetch(TTS_BASE + '/health', { signal: AbortSignal.timeout(800) })
    .then(r => { if (!r.ok) throw new Error('respawn'); console.log('[tts] Echo voice already running'); })
    .catch(() => {
      const { spawn } = require('child_process');
      const child = spawn(py, [script], {
        env: { ...process.env, JOTPANEL_TTS_PORT: String(TTS_PORT), JOTPANEL_TTS_STATE: voiceState },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('error', e => console.error('[tts] failed to start:', e.message));
      process.on('exit', () => { try { child.kill(); } catch {} });
    });
})();

// Gender keeps the existing UI contract; the names are Kokoro voice ids.
const TTS_VOICES = { female: 'af_heart', male: 'am_michael' };

// POST /api/ai/speak — Echo's voice, synthesized locally, returned as WAV.
app.post('/api/ai/speak', auth, async (req, res) => {
  const text = (req.body?.text || '').toString().slice(0, 2000).trim();
  if (!text) return res.status(400).json({ error: req.t('text required') });
  const requested = (req.body?.voice || '').toString();
  const voice = TTS_VOICES[req.body?.gender] || (/^[a-z]{2}_[a-z]+$/.test(requested) ? requested : TTS_VOICES.female);
  try {
    // Local Kokoro on this machine, same reasoning as /transcribe above.
    const r = await fetch(TTS_BASE + '/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, speed: parseFloat(req.body?.speed) || 1.0, lang: /^[a-z]{2}-[a-z]{2}$/i.test(String(req.body?.lang || '')) ? String(req.body.lang).toLowerCase() : undefined }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`tts ${r.status}`);
    res.set('Content-Type', 'audio/wav');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    // No voice on this machine: on the hosted route the engine speaks instead
    // under the same licence.
    const base = String((process.env.JOTPANEL_THINKING_URL ?? process.env.ARCA_THINKING_URL) || '').replace(/\/$/, '');
    const key = base ? licenseClient.keyForProxy() : null;
    if (key) {
      try {
        const r = await fetch(`${base}/v1/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Arca-License': key, 'X-Arca-Machine': licenseClient.machineId, 'X-Arca-Account': crypto.createHmac('sha256', ENCRYPT_SECRET).update(req.user.id).digest('hex'), 'X-Arca-Version': (process.env.JOTPANEL_VERSION ?? process.env.ARCA_VERSION) || 'dev' },
          body: JSON.stringify({ text, voice, lang: /^[a-z]{2}-[a-z]{2}$/i.test(String(req.body?.lang || '')) ? String(req.body.lang).toLowerCase() : undefined }), signal: AbortSignal.timeout(60000) });
        if (r.ok) { res.set('Content-Type', 'audio/wav'); return res.send(Buffer.from(await r.arrayBuffer())); }
      } catch { /* the engine has no voice either */ }
    }
    // The person's own voice keys, read from the vault on this server. The
    // browser used to call these providers itself with the key attached.
    const held = hostAllowsByok() ? storedByok(req.user.id) : {};
    if (held.elevenlabs && held.elevenlabs.key) {
      const requestedVoice = String(req.body?.elVoice || '');
      const voiceId = /^[A-Za-z0-9]{10,40}$/.test(requestedVoice) ? requestedVoice : (req.body?.gender === 'male' ? 'pNInz6obpgDQGcFmaJgB' : 'EXAVITQu4vr4xnSDxMaL');
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, { method: 'POST',
          headers: { 'xi-api-key': held.elevenlabs.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.85 } }), signal: AbortSignal.timeout(60000) });
        if (r.ok) { res.set('Content-Type', 'audio/mpeg'); return res.send(Buffer.from(await r.arrayBuffer())); }
      } catch { /* try the next voice */ }
    }
    if (held.openai && held.openai.key) {
      try {
        const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST',
          headers: { Authorization: `Bearer ${held.openai.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'tts-1', input: text, voice: req.body?.gender === 'male' ? 'onyx' : 'nova', speed: 0.95 }), signal: AbortSignal.timeout(60000) });
        if (r.ok) { res.set('Content-Type', 'audio/mpeg'); return res.send(Buffer.from(await r.arrayBuffer())); }
      } catch { /* no voice left on the server */ }
    }
    res.status(503).json({ error: req.t('Echo voice is not available') });
  }
});

// GET /api/ai/usage — the user's metered spend, source of truth for the widget.
app.get('/api/ai/usage', auth, (req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const rows = db.prepare('SELECT ts,provider,model,in_tok,out_tok,cost,byok,task,preview FROM ai_usage WHERE user_id=? ORDER BY ts DESC LIMIT 200').all(req.user.id);
  res.json({ month, total: spentThisMonth(req.user.id), cap: monthlyCap(req.user.id), sessions: rows });
});

// ── BYOG — the model on the user's own machine ────────────────────
//
// Two audiences and two credentials, kept apart on purpose.
//
// The person, holding a session, pairs and manages devices through the routes
// under `auth`. Their machine, holding only a device credential, dials in on
// `/api/byog/link` and can reach nothing else: `deviceAuth` is the only door it
// has, the token namespace is refused by `auth`, and there is no scope on a
// device credential that could ever widen into a panel operation.
//
// Nothing here takes a device id from a caller and trusts it. Every route that
// names a device resolves it through `ownedDevice(req.user.id, id)` or through
// the token the device itself presented, so the question "whose machine is
// this" is answered from a row rather than from a request.

// Pairing is the one unauthenticated door in this file, so it is the one that
// gets counted hardest. A code is fifty bits and lives fifteen minutes; this
// is belt and braces on top of that.
const BYOG_PAIR_LIMITER = rateLimit({
  windowMs: 15 * 60 * 1000, max: 12,
  message: { error: 'Too many pairing attempts — wait fifteen minutes.' },
  standardHeaders: true, legacyHeaders: false,
});

function deviceAuth(req, res, next) {
  const header = req.headers.authorization;
  const presented = header && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!looksLikeDeviceToken(presented)) return res.status(401).json({ error: req.t('This route is for a paired device.') });
  const device = byog.verifyToken(presented);
  if (!device) return res.status(401).json({ error: req.t('This device is not paired, or it has been removed.') });
  const owner = db.prepare('SELECT id, suspended FROM users WHERE id=?').get(device.user_id);
  // A device belonging to a suspended account stops working with the account,
  // not after somebody remembers to revoke it separately.
  if (!owner || owner.suspended) return res.status(403).json({ error: req.t('The account this device belongs to is not active.') });
  req.device = device;
  next();
}

// ── The person's side ──

app.post('/api/byog/pair-code', auth, (req, res) => {
  try {
    const issued = byog.issuePairCode(req.user.id);
    audit(req.user.id, 'byog_pair_code_issued', req);
    res.json(issued);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/byog/devices', auth, (req, res) => {
  res.json({
    devices: byog.listDevices(req.user.id),
    policy: byog.readPolicy(req.user.id),
    limits: {
      heartbeatSeconds: Math.round(byog.constants.HEARTBEAT_MS / 1000),
      jobTimeoutSeconds: Math.round(byog.constants.jobTimeoutMs / 1000),
      maxJobKb: Math.round(byog.constants.MAX_JOB_BYTES / 1024),
    },
  });
});

app.patch('/api/byog/devices/:id', auth, (req, res) => {
  try {
    let device = byog.ownedDevice(req.user.id, req.params.id);
    if (!device) return res.status(404).json({ error: req.t('No such device') });
    let shown = byog.present(device);
    if (typeof req.body?.name === 'string') shown = byog.renameDevice(req.user.id, req.params.id, req.body.name);
    if (typeof req.body?.autoRoute === 'boolean') shown = byog.setAutoRoute(req.user.id, req.params.id, req.body.autoRoute);
    res.json(shown);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete('/api/byog/devices/:id', auth, (req, res) => {
  try {
    res.json(byog.revokeDevice(req.user.id, req.params.id));
  } catch (error) { res.status(404).json({ error: error.message }); }
});

// The routing policy lives in the same settings row as the user's own API
// keys, because it is the same kind of thing: a preference about which brain
// answers. Merged rather than written over, so saving it cannot take somebody's
// keys with it.
app.put('/api/byog/policy', auth, (req, res) => {
  const mode = ['auto', 'private', 'off'].includes(req.body?.mode) ? req.body.mode : 'auto';
  const next = {
    mode,
    deviceId: typeof req.body?.deviceId === 'string' && req.body.deviceId ? req.body.deviceId : null,
    model: typeof req.body?.model === 'string' && req.body.model ? req.body.model : null,
    residentFallback: req.body?.residentFallback !== false,
  };
  // A pinned device has to be one of theirs. Anything else is silently dropped
  // rather than stored, because a policy pointing at a device the account does
  // not own would read as "no device available" for ever afterwards.
  if (next.deviceId && !byog.ownedDevice(req.user.id, next.deviceId)) next.deviceId = null;
  let current = {};
  try { current = JSON.parse(db.prepare('SELECT data FROM settings WHERE user_id=?').get(req.user.id)?.data || '{}'); } catch {}
  current.byog = next;
  db.prepare('INSERT INTO settings (user_id,data) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data')
    .run(req.user.id, JSON.stringify(current));
  audit(req.user.id, 'byog_policy_saved', req, mode);
  res.json(byog.readPolicy(req.user.id));
});

// The helper's own source, served so the pairing screen can hand out one
// command. It is the client half of an AGPL product and carries no secret, so
// it is public on purpose: needing a session token to fetch it would mean
// pasting a session token into a terminal, which is the habit this whole
// feature exists to avoid.
app.get('/api/byog/helper', (req, res) => {
  const file = path.join(__dirname, '..', 'tools', 'arca-byog-helper.js');
  if (!fs.existsSync(file)) return res.status(404).json({ error: req.t('The helper is not installed on this deployment.') });
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="arca-byog-helper.js"');
  res.send(fs.readFileSync(file, 'utf8'));
});

// ── The device's side ──

app.post('/api/byog/pair', BYOG_PAIR_LIMITER, (req, res) => {
  try {
    const paired = byog.pair({
      code: req.body?.code,
      name: req.body?.name,
      platform: req.body?.platform,
      arch: req.body?.arch,
      agentVersion: req.body?.agentVersion,
      engineKind: req.body?.engineKind,
      host: req.body?.host,
      models: req.body?.models,
      maxConcurrent: req.body?.maxConcurrent,
      from: req.headers['x-real-ip'] || req.ip,
    });
    res.json(paired);
  } catch (error) {
    // A bad code is the caller's mistake and says so; anything else is ours.
    res.status(error.code === 'bad_code' ? 400 : 500).json({ error: error.message, code: error.code || null });
  }
});

// The link. One long-lived response the device holds open, which is the whole
// trick: the machine at home dials out, so there is no inbound port, no NAT
// rule and no tunnel, and the local engine keeps listening to its own loopback
// exactly as localEngineSecurity requires of the Resident.
app.get('/api/byog/link', deviceAuth, (req, res) => {
  // Neither end may time this out. The request is complete the moment it
  // arrives and the response is meant to last for days.
  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) { req.socket.setKeepAlive(true); req.socket.setNoDelay(true); }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const writer = {
    send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    close() { try { res.end(); } catch {} },
  };
  let detach;
  try {
    detach = byog.attachLink(req.device, writer);
  } catch (error) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    return res.end();
  }
  res.on('close', () => { try { detach(); } catch {} });
});

app.post('/api/byog/report', deviceAuth, (req, res) => {
  try {
    res.json(byog.report(req.device.id, req.body || {}));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// A whole answer at once. The nonce rides in a header rather than the path,
// because a path reaches the access log and a per-job secret should not.
app.post('/api/byog/jobs/:id/result', deviceAuth, (req, res) => {
  try {
    const job = byog.claimJob(req.device.id, req.params.id, req.headers['x-byog-nonce']);
    if (req.body?.ok === false || req.body?.error) {
      job.fail(new Error(String(req.body?.error || 'The local model failed').slice(0, 300)));
      return res.json({ ok: true, recorded: 'failure' });
    }
    if (typeof req.body?.text !== 'string') {
      job.fail(new Error('The local model returned no text.'));
      return res.status(400).json({ error: req.t('text is required') });
    }
    job.finish({ text: req.body.text, inTok: req.body.inTok, outTok: req.body.outTok });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.code === 'bad_nonce' ? 403 : 409).json({ error: error.message, code: error.code || null });
  }
});

// A streamed answer. The device holds one outbound request open and writes
// newline-delimited JSON up it as the tokens arrive, which is the same trick as
// the link in the other direction and needs no second connection.
//
// The content type matters: express.json() parses by type, so x-ndjson reaches
// this handler as an unread stream rather than as a parsed body.
app.post('/api/byog/jobs/:id/stream', deviceAuth, (req, res) => {
  let job;
  try {
    job = byog.claimJob(req.device.id, req.params.id, req.headers['x-byog-nonce']);
  } catch (error) {
    return res.status(error.code === 'bad_nonce' ? 403 : 409).json({ error: error.message, code: error.code || null });
  }
  req.setTimeout(0);
  let buffer = '';
  let finished = false;
  let bytes = 0;
  const LIMIT = 8 * 1024 * 1024; // an answer, not an upload channel

  const handleLine = line => {
    const text = line.trim();
    if (!text) return;
    let event;
    // A device that sends rubbish gets the job failed rather than the server
    // confused. Malformed output is a device fault, not a protocol state.
    try { event = JSON.parse(text); } catch {
      finished = true;
      job.fail(new Error('The device sent a malformed response.'));
      return;
    }
    if (typeof event.delta === 'string') return job.onDelta(event.delta);
    if (event.error) { finished = true; return void job.fail(new Error(String(event.error).slice(0, 300))); }
    if (event.done) {
      finished = true;
      job.finish({ text: typeof event.text === 'string' ? event.text : null, inTok: event.inTok, outTok: event.outTok });
    }
  };

  req.setEncoding('utf8');
  req.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > LIMIT) {
      finished = true;
      job.fail(new Error('The device sent more than this link carries.'));
      return void req.destroy();
    }
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) { if (!finished) handleLine(line); }
  });
  req.on('end', () => {
    if (!finished) handleLine(buffer);
    // The stream ended without a done line: the helper died, the machine slept
    // or the network broke mid-sentence. That is a failure, and saying so is
    // what lets the caller fall back instead of hanging.
    if (!finished) job.fail(new Error('The device stopped answering before it finished.'));
    if (!res.headersSent) res.json({ ok: true });
  });
  req.on('error', () => {
    if (!finished) job.fail(new Error('The connection from the device broke mid-answer.'));
    if (!res.headersSent) { try { res.status(400).json({ error: req.t('stream broken') }); } catch {} }
  });
});

// ── SITES / WORKSPACES / FILES ────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    name         TEXT NOT NULL,
    domain       TEXT,
    status       TEXT DEFAULT 'draft',
    echo_context TEXT DEFAULT '{}',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id         TEXT PRIMARY KEY,
    site_id    TEXT NOT NULL,
    parent_id  TEXT,
    name       TEXT NOT NULL,
    type       TEXT DEFAULT 'general',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS site_files (
    id                 TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL,
    site_id            TEXT NOT NULL,
    name               TEXT NOT NULL,
    type               TEXT NOT NULL DEFAULT 'page',
    content            TEXT,
    content_hash       TEXT,
    last_deployed_hash TEXT,
    sync_state         TEXT DEFAULT 'local',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id)      REFERENCES sites(id)      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS site_deploy_targets (
    id            TEXT PRIMARY KEY,
    site_id       TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    label         TEXT NOT NULL,
    remote_path   TEXT DEFAULT '/public_html',
    is_primary    INTEGER DEFAULT 0,
    last_deployed TEXT,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sites_user        ON sites(user_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_site   ON workspaces(site_id);
  CREATE INDEX IF NOT EXISTS idx_site_files_ws     ON site_files(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_deploy_targets    ON site_deploy_targets(site_id);
`);

// ── SITES CRUD ────────────────────────────────────────────────────

// GET /api/sites
app.get('/api/sites', auth, (req, res) => {
  const sites = db.prepare('SELECT * FROM sites WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  const enriched = sites.map(s => {
    const workspaces = db.prepare('SELECT id,name,type,parent_id,sort_order FROM workspaces WHERE site_id=? ORDER BY sort_order').all(s.id);
    const targets    = db.prepare('SELECT id,label,remote_path,is_primary,last_deployed,credential_id FROM site_deploy_targets WHERE site_id=?').all(s.id);
    return { ...s, echo_context: tryParse(s.echo_context), workspaces, deploy_targets: targets };
  });
  res.json(enriched);
});

function tryParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// POST /api/sites
app.post('/api/sites', auth, (req, res) => {
  const { name, domain, status = 'draft', echo_context = {} } = req.body;
  if (!name) return res.status(400).json({ error: req.t('name required') });
  const id = uid(); const now = new Date().toISOString();
  db.prepare('INSERT INTO sites (id,user_id,name,domain,status,echo_context,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, name, domain||null, status, JSON.stringify(echo_context), now, now);
  audit(req.user.id, 'site_create', req, name);
  res.json({ ok: true, id });
});

// PATCH /api/sites/:id
app.patch('/api/sites/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM sites WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: req.t('Not found') });
  const { name, domain, status, echo_context } = req.body;
  const now = new Date().toISOString();
  if (name)         db.prepare('UPDATE sites SET name=?,updated_at=?        WHERE id=?').run(name, now, row.id);
  if (domain)       db.prepare('UPDATE sites SET domain=?,updated_at=?      WHERE id=?').run(domain, now, row.id);
  if (status)       db.prepare('UPDATE sites SET status=?,updated_at=?      WHERE id=?').run(status, now, row.id);
  if (echo_context) db.prepare('UPDATE sites SET echo_context=?,updated_at=? WHERE id=?').run(JSON.stringify(echo_context), now, row.id);
  res.json({ ok: true });
});

// DELETE /api/sites/:id
app.delete('/api/sites/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM sites WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: req.t('Not found') });
  db.prepare('DELETE FROM sites WHERE id=?').run(row.id);
  audit(req.user.id, 'site_delete', req, row.name);
  res.json({ ok: true });
});

// ── WORKSPACES CRUD ───────────────────────────────────────────────

// GET /api/sites/:id/workspaces
app.get('/api/sites/:id/workspaces', auth, (req, res) => {
  const site = db.prepare('SELECT id FROM sites WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!site) return res.status(404).json({ error: req.t('Not found') });
  const rows = db.prepare('SELECT * FROM workspaces WHERE site_id=? ORDER BY sort_order,created_at').all(site.id);
  res.json(rows);
});

// POST /api/sites/:id/workspaces
app.post('/api/sites/:id/workspaces', auth, (req, res) => {
  const site = db.prepare('SELECT id FROM sites WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!site) return res.status(404).json({ error: req.t('Not found') });
  const { name, type = 'general', parent_id = null, sort_order = 0 } = req.body;
  if (!name) return res.status(400).json({ error: req.t('name required') });
  const id = uid(); const now = new Date().toISOString();
  db.prepare('INSERT INTO workspaces (id,site_id,parent_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, site.id, parent_id, name, type, sort_order, now);
  res.json({ ok: true, id });
});

// PATCH /api/workspaces/:id
app.patch('/api/workspaces/:id', auth, (req, res) => {
  const ws = db.prepare(`SELECT w.* FROM workspaces w JOIN sites s ON s.id=w.site_id WHERE w.id=? AND s.user_id=?`).get(req.params.id, req.user.id);
  if (!ws) return res.status(404).json({ error: req.t('Not found') });
  const { name, type, parent_id, sort_order } = req.body;
  if (name !== undefined)       db.prepare('UPDATE workspaces SET name=?      WHERE id=?').run(name, ws.id);
  if (type !== undefined)       db.prepare('UPDATE workspaces SET type=?      WHERE id=?').run(type, ws.id);
  if (parent_id !== undefined)  db.prepare('UPDATE workspaces SET parent_id=? WHERE id=?').run(parent_id, ws.id);
  if (sort_order !== undefined) db.prepare('UPDATE workspaces SET sort_order=? WHERE id=?').run(sort_order, ws.id);
  res.json({ ok: true });
});

// DELETE /api/workspaces/:id
app.delete('/api/workspaces/:id', auth, (req, res) => {
  const ws = db.prepare(`SELECT w.* FROM workspaces w JOIN sites s ON s.id=w.site_id WHERE w.id=? AND s.user_id=?`).get(req.params.id, req.user.id);
  if (!ws) return res.status(404).json({ error: req.t('Not found') });
  db.prepare('DELETE FROM workspaces WHERE id=?').run(ws.id);
  res.json({ ok: true });
});

// ── SITE FILES CRUD ───────────────────────────────────────────────

// GET /api/workspaces/:id/files
app.get('/api/workspaces/:id/files', auth, (req, res) => {
  const ws = db.prepare(`SELECT w.* FROM workspaces w JOIN sites s ON s.id=w.site_id WHERE w.id=? AND s.user_id=?`).get(req.params.id, req.user.id);
  if (!ws) return res.status(404).json({ error: req.t('Not found') });
  const rows = db.prepare('SELECT id,name,type,content_hash,last_deployed_hash,sync_state,created_at,updated_at FROM site_files WHERE workspace_id=? ORDER BY type,name').all(ws.id);
  res.json(rows);
});

// POST /api/workspaces/:id/files — create or upsert file
app.post('/api/workspaces/:id/files', auth, (req, res) => {
  const ws = db.prepare(`SELECT w.* FROM workspaces w JOIN sites s ON s.id=w.site_id WHERE w.id=? AND s.user_id=?`).get(req.params.id, req.user.id);
  if (!ws) return res.status(404).json({ error: req.t('Not found') });
  const { name, type = 'page', content = '' } = req.body;
  if (!name) return res.status(400).json({ error: req.t('name required') });
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const now  = new Date().toISOString();
  const id   = uid();
  db.prepare('INSERT INTO site_files (id,workspace_id,site_id,name,type,content,content_hash,sync_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, ws.id, ws.site_id, name, type, content, hash, 'local', now, now);
  res.json({ ok: true, id, content_hash: hash });
});

// GET /api/site-files/:id — one file with its content (the list endpoint
// deliberately omits content; the deploy push needs it)
app.get('/api/site-files/:id', auth, (req, res) => {
  const file = db.prepare(`SELECT f.* FROM site_files f JOIN sites s ON s.id=f.site_id WHERE f.id=? AND s.user_id=?`).get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: req.t('Not found') });
  res.json(file);
});

// PATCH /api/site-files/:id — update content or sync state
app.patch('/api/site-files/:id', auth, (req, res) => {
  const file = db.prepare(`SELECT f.* FROM site_files f JOIN sites s ON s.id=f.site_id WHERE f.id=? AND s.user_id=?`).get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: req.t('Not found') });
  const now = new Date().toISOString();
  if (req.body.content !== undefined) {
    const hash = crypto.createHash('sha256').update(req.body.content).digest('hex');
    const state = hash !== file.last_deployed_hash ? 'modified' : 'synced';
    db.prepare('UPDATE site_files SET content=?,content_hash=?,sync_state=?,updated_at=? WHERE id=?').run(req.body.content, hash, state, now, file.id);
  }
  if (req.body.sync_state) db.prepare('UPDATE site_files SET sync_state=?,updated_at=? WHERE id=?').run(req.body.sync_state, now, file.id);
  if (req.body.last_deployed_hash) db.prepare('UPDATE site_files SET last_deployed_hash=?,sync_state=?,updated_at=? WHERE id=?').run(req.body.last_deployed_hash, 'synced', now, file.id);
  res.json({ ok: true });
});

// DELETE /api/site-files/:id
app.delete('/api/site-files/:id', auth, (req, res) => {
  const file = db.prepare(`SELECT f.* FROM site_files f JOIN sites s ON s.id=f.site_id WHERE f.id=? AND s.user_id=?`).get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: req.t('Not found') });
  db.prepare('DELETE FROM site_files WHERE id=?').run(file.id);
  res.json({ ok: true });
});

// ── DEPLOY TARGETS ────────────────────────────────────────────────

// GET /api/sites/:id/deploy-targets
app.get('/api/sites/:id/deploy-targets', auth, (req, res) => {
  const site = db.prepare('SELECT id FROM sites WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!site) return res.status(404).json({ error: req.t('Not found') });
  const rows = db.prepare('SELECT t.*,c.label as cred_label,c.host,c.protocol FROM site_deploy_targets t JOIN deploy_credentials c ON c.id=t.credential_id WHERE t.site_id=?').all(site.id);
  res.json(rows);
});

// POST /api/sites/:id/deploy-targets
app.post('/api/sites/:id/deploy-targets', auth, (req, res) => {
  const site = db.prepare('SELECT id FROM sites WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!site) return res.status(404).json({ error: req.t('Not found') });
  const { credential_id, label, remote_path = '/public_html', is_primary = 0 } = req.body;
  if (!credential_id || !label) return res.status(400).json({ error: req.t('credential_id and label required') });
  const cred = db.prepare('SELECT id FROM deploy_credentials WHERE id=? AND user_id=?').get(credential_id, req.user.id);
  if (!cred) return res.status(404).json({ error: req.t('Credential not found') });
  if (is_primary) db.prepare('UPDATE site_deploy_targets SET is_primary=0 WHERE site_id=?').run(site.id);
  const id = uid();
  db.prepare('INSERT INTO site_deploy_targets (id,site_id,credential_id,label,remote_path,is_primary) VALUES (?,?,?,?,?,?)')
    .run(id, site.id, credential_id, label, remote_path, is_primary ? 1 : 0);
  res.json({ ok: true, id });
});

// DELETE /api/deploy-targets/:id
app.delete('/api/deploy-targets/:id', auth, (req, res) => {
  const t = db.prepare(`SELECT t.* FROM site_deploy_targets t JOIN sites s ON s.id=t.site_id WHERE t.id=? AND s.user_id=?`).get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: req.t('Not found') });
  db.prepare('DELETE FROM site_deploy_targets WHERE id=?').run(t.id);
  res.json({ ok: true });
});

// ── REMOTE DEPLOY OPERATIONS ─────────────────────────────────────

// Helper: get sftp/ftp client from credential
async function getRemoteClient(credId, userId) {
  const row = db.prepare('SELECT * FROM deploy_credentials WHERE id=? AND user_id=?').get(credId, userId);
  if (!row) throw new Error('Credential not found');
  const password = decryptField(row.password, ENCRYPT_SECRET);
  return { row, password };
}

// GET /api/deploy/list?credentialId=X&path=Y — list remote directory
app.get('/api/deploy/list', auth, async (req, res) => {
  const { credentialId, path: remotePath = '/public_html' } = req.query;
  if (!credentialId) return res.status(400).json({ error: req.t('credentialId required') });
  try {
    const { row, password } = await getRemoteClient(credentialId, req.user.id);
    let entries = [];
    if (row.protocol === 'sftp' || row.protocol === 'ssh') {
      const SFTPClient = require('ssh2-sftp-client');
      const sftp = new SFTPClient();
      await sftp.connect({ host: row.host, port: row.port, username: row.username, password, readyTimeout: 12000 });
      const list = await sftp.list(remotePath).catch(() => []);
      entries = list.map(f => ({
        name: f.name, type: f.type === 'd' ? 'dir' : 'file',
        size: f.size, modified: f.modifyTime,
        path: remotePath.replace(/\/$/, '') + '/' + f.name,
      }));
      await sftp.end();
    } else {
      const ftp = require('basic-ftp');
      const client = new ftp.Client(12000);
      await client.access({ host: row.host, port: row.port, user: row.username, password, secure: row.protocol === 'ftps' });
      const list = await client.list(remotePath).catch(() => []);
      entries = list.map(f => ({
        name: f.name, type: f.isDirectory ? 'dir' : 'file',
        size: f.size, modified: f.rawModifiedAt,
        path: remotePath.replace(/\/$/, '') + '/' + f.name,
      }));
      client.close();
    }
    res.json({ entries, path: remotePath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/deploy/remote — delete remote file
app.delete('/api/deploy/remote', auth, async (req, res) => {
  const { credentialId, path: remotePath } = req.body;
  if (!credentialId || !remotePath) return res.status(400).json({ error: req.t('credentialId and path required') });
  try {
    const { row, password } = await getRemoteClient(credentialId, req.user.id);
    if (row.protocol === 'sftp' || row.protocol === 'ssh') {
      const SFTPClient = require('ssh2-sftp-client');
      const sftp = new SFTPClient();
      await sftp.connect({ host: row.host, port: row.port, username: row.username, password, readyTimeout: 12000 });
      await sftp.delete(remotePath);
      await sftp.end();
    } else {
      const ftp = require('basic-ftp');
      const client = new ftp.Client(12000);
      await client.access({ host: row.host, port: row.port, user: row.username, password, secure: row.protocol === 'ftps' });
      await client.remove(remotePath);
      client.close();
    }
    audit(req.user.id, 'deploy_remote_delete', req, remotePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/deploy/mkdir — create remote directory
app.post('/api/deploy/mkdir', auth, async (req, res) => {
  const { credentialId, path: remotePath } = req.body;
  if (!credentialId || !remotePath) return res.status(400).json({ error: req.t('credentialId and path required') });
  try {
    const { row, password } = await getRemoteClient(credentialId, req.user.id);
    if (row.protocol === 'sftp' || row.protocol === 'ssh') {
      const SFTPClient = require('ssh2-sftp-client');
      const sftp = new SFTPClient();
      await sftp.connect({ host: row.host, port: row.port, username: row.username, password, readyTimeout: 12000 });
      await sftp.mkdir(remotePath, true);
      await sftp.end();
    } else {
      const ftp = require('basic-ftp');
      const client = new ftp.Client(12000);
      await client.access({ host: row.host, port: row.port, user: row.username, password, secure: row.protocol === 'ftps' });
      await client.ensureDir(remotePath);
      client.close();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/deploy/diff — compare local file hashes vs remote, return sync states
// Body: { credentialId, remotePath, files: [{name, content_hash, last_deployed_hash}] }
app.post('/api/deploy/diff', auth, async (req, res) => {
  const { credentialId, remotePath = '/public_html', files = [] } = req.body;
  if (!credentialId) return res.status(400).json({ error: req.t('credentialId required') });
  try {
    const { row, password } = await getRemoteClient(credentialId, req.user.id);
    let remoteFiles = new Map();
    const listRemote = async (sftp, ftp) => {
      if (sftp) {
        const list = await sftp.list(remotePath).catch(() => []);
        list.forEach(f => { if (f.type !== 'd') remoteFiles.set(f.name, { size: f.size, modified: f.modifyTime }); });
      } else {
        const list = await ftp.list(remotePath).catch(() => []);
        list.forEach(f => { if (!f.isDirectory) remoteFiles.set(f.name, { size: f.size }); });
      }
    };

    if (row.protocol === 'sftp' || row.protocol === 'ssh') {
      const SFTPClient = require('ssh2-sftp-client');
      const sftp = new SFTPClient();
      await sftp.connect({ host: row.host, port: row.port, username: row.username, password, readyTimeout: 12000 });
      await listRemote(sftp, null);
      await sftp.end();
    } else {
      const ftp = require('basic-ftp');
      const client = new ftp.Client(12000);
      await client.access({ host: row.host, port: row.port, user: row.username, password, secure: row.protocol === 'ftps' });
      await listRemote(null, client);
      client.close();
    }

    const states = files.map(f => {
      const onRemote = remoteFiles.has(f.name);
      let state;
      if (!onRemote && !f.last_deployed_hash)  state = 'local';      // ⊘ never deployed
      else if (!onRemote && f.last_deployed_hash) state = 'missing_remote'; // ✕ was deployed, now gone
      else if (f.content_hash === f.last_deployed_hash) state = 'synced'; // ✓
      else if (f.content_hash !== f.last_deployed_hash) state = 'modified'; // ● changed locally
      else state = 'synced';
      return { name: f.name, state };
    });

    // Files on remote but not in local list
    const localNames = new Set(files.map(f => f.name));
    remoteFiles.forEach((_, name) => {
      if (!localNames.has(name)) states.push({ name, state: 'remote_only' }); // ↓ exists only on server
    });

    res.json({ states, remote_count: remoteFiles.size });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── MAIL BACKEND ─────────────────────────────────────────────────
// IMAP fetch + SMTP send. Credentials stored per user in settings JSON.
// Accounts saved by frontend to /api/mail/accounts/save. Credentials are
// encrypted in the account database and are never returned by the list API.

function encryptMail(text) { return encryptField(text, MAIL_ENCRYPT_SECRET); }
function decryptMail(b64)  { return decryptField(b64, MAIL_ENCRYPT_SECRET); }

db.exec(`
  CREATE TABLE IF NOT EXISTS mail_accounts (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    label      TEXT NOT NULL,
    email      TEXT NOT NULL,
    imap_host  TEXT NOT NULL,
    imap_port  INTEGER DEFAULT 993,
    imap_secure INTEGER DEFAULT 1,
    smtp_host  TEXT NOT NULL,
    smtp_port  INTEGER DEFAULT 587,
    smtp_secure INTEGER DEFAULT 0,
    username   TEXT NOT NULL,
    password   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mail_user ON mail_accounts(user_id);
`);

// GET /api/mail/accounts
app.get('/api/mail/accounts', auth, (req, res) => {
  const rows = db.prepare('SELECT id,label,email,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,username FROM mail_accounts WHERE user_id=?').all(req.user.id);
  res.json(rows);
});

// POST /api/mail/accounts/save
app.post('/api/mail/accounts/save', auth, (req, res) => {
  const { id, label, email, imapHost, imapPort=993, secure=true, smtpHost, smtpPort=587, smtpSecure=false, username, password } = req.body;
  if (!email || !imapHost || !username || !password) return res.status(400).json({ error: req.t('Missing required fields') });
  const enc = encryptMail(password);
  const now = new Date().toISOString();
  const accountId = id || uid();
  const existing = db.prepare('SELECT id FROM mail_accounts WHERE id=? AND user_id=?').get(accountId, req.user.id);
  if (existing) {
    db.prepare('UPDATE mail_accounts SET label=?,email=?,imap_host=?,imap_port=?,imap_secure=?,smtp_host=?,smtp_port=?,smtp_secure=?,username=?,password=? WHERE id=? AND user_id=?')
      .run(label||email, email, imapHost, parseInt(imapPort), secure?1:0, smtpHost||imapHost, parseInt(smtpPort), smtpSecure?1:0, username, enc, accountId, req.user.id);
  } else {
    db.prepare('INSERT INTO mail_accounts (id,user_id,label,email,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,username,password,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(accountId, req.user.id, label||email, email, imapHost, parseInt(imapPort), secure?1:0, smtpHost||imapHost, parseInt(smtpPort), smtpSecure?1:0, username, enc, now);
  }
  audit(req.user.id, 'mail_account_save', req, email);
  res.json({ ok: true, id: accountId });
});

// POST /api/mail/accounts/test — IMAP connection test
app.post('/api/mail/accounts/test', auth, async (req, res) => {
  const { imapHost, imapPort=993, secure=true, username, password } = req.body;
  if (!imapHost || !username || !password) return res.status(400).json({ error: req.t('Missing fields') });
  try {
    const Imap = require('imap');
    await new Promise((resolve, reject) => {
      const imap = new Imap({ user: username, password, host: imapHost, port: parseInt(imapPort), tls: !!secure, tlsOptions: { rejectUnauthorized: true, servername: imapHost }, authTimeout: 8000, connTimeout: 10000 });
      imap.once('ready', () => { imap.end(); resolve(); });
      imap.once('error', reject);
      imap.connect();
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// The webmail read and write path. The IMAP and SMTP work is in
// control/webmailClient.js so that it can be tested without a mail server;
// these handlers do nothing but find the account, decrypt its password and
// translate a failure into a status code.

const webmailClient = createWebmailClient();

function mailAccountFor(req, accountId) {
  const row = db.prepare('SELECT * FROM mail_accounts WHERE id=? AND user_id=?').get(accountId, req.user.id);
  if (!row) return null;
  return {
    row,
    account: {
      email: row.email,
      username: row.username,
      password: decryptMail(row.password),
      imapHost: row.imap_host,
      imapPort: row.imap_port,
      imapSecure: !!row.imap_secure,
      smtpHost: row.smtp_host,
      smtpPort: row.smtp_port,
      smtpSecure: !!row.smtp_secure,
    },
  };
}

// GET /api/mail/messages?accountId=X&folder=Y — the newest page of a folder.
// Each message is addressed by its IMAP UID and never by its position.
app.get('/api/mail/messages', auth, async (req, res) => {
  const { accountId, folder = 'INBOX', limit, offset } = req.query;
  if (!accountId) return res.status(400).json({ error: req.t('accountId required') });
  const found = mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try {
    res.json(await webmailClient.listMessages(found.account, { folder, limit, offset }));
  } catch (e) {
    console.error('[mail]', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// GET /api/mail/message?accountId=X&folder=Y&uid=N — one message, parsed.
app.get('/api/mail/message', auth, async (req, res) => {
  const { accountId, folder = 'INBOX', uid } = req.query;
  if (!accountId || !uid) return res.status(400).json({ error: req.t('accountId and uid required') });
  const found = mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try {
    res.json(await webmailClient.readMessage(found.account, { folder, uid }));
  } catch (e) {
    console.error('[mail]', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// GET /api/mail/search — asked of the server, because the server is the only
// thing that has the whole mailbox.
app.get('/api/mail/search', auth, async (req, res) => {
  const { accountId, folder = 'INBOX', q, limit } = req.query;
  if (!accountId) return res.status(400).json({ error: req.t('accountId required') });
  const found = mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try { res.json(await webmailClient.searchMessages(found.account, { folder, query: q, limit })); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// The verbs that change a mailbox. Each one names the folder and the UIDs it
// acts on, and each is refused when nothing is selected rather than applied to
// everything, which is the difference between a bug and a catastrophe.
app.post('/api/mail/flags', auth, async (req, res) => {
  const { accountId, folder, uids, add, remove } = req.body || {};
  const found = accountId && mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try {
    const result = await webmailClient.setFlags(found.account, { folder, uids, add, remove });
    res.json(result);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/mail/move', auth, async (req, res) => {
  const { accountId, folder, uids, to } = req.body || {};
  const found = accountId && mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try {
    const result = await webmailClient.moveMessages(found.account, { folder, uids, to });
    audit(req.user.id, 'mail_move', req, `${result.uids.length} message(s) ${folder} to ${result.to}`);
    res.json(result);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Deleting is written down. It is the one mail action a person cannot undo
// from the screen once it is permanent, so the record of who asked for it has
// to outlive the message.
app.post('/api/mail/delete', auth, async (req, res) => {
  const { accountId, folder, uids, permanent } = req.body || {};
  const found = accountId && mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try {
    const result = await webmailClient.deleteMessages(found.account, { folder, uids, permanent: !!permanent });
    audit(req.user.id, result.permanent ? 'mail_delete_permanent' : 'mail_delete', req,
      `${result.uids.length} message(s) from ${folder}${result.to ? ` to ${result.to}` : ''}`);
    res.json(result);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Making, renaming and removing folders. Renaming and removing are written
// down because both are unrecoverable: the client refuses them for the folders
// a mailbox depends on, and the record says who asked for the rest.
app.post('/api/mail/folder', auth, async (req, res) => {
  const { accountId, action, name, to } = req.body || {};
  const found = accountId && mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  const verbs = { create: 'createFolder', rename: 'renameFolder', delete: 'deleteFolder' };
  if (!verbs[action]) return res.status(400).json({ error: req.t('action must be create, rename or delete') });
  try {
    const result = await webmailClient[verbs[action]](found.account, { name, to });
    if (action !== 'create') audit(req.user.id, `mail_folder_${action}`, req, `${name}${to ? ` to ${to}` : ''}`);
    res.json(result);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/mail/draft', auth, async (req, res) => {
  const { accountId, draft, replacesUid } = req.body || {};
  const found = accountId && mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try { res.json(await webmailClient.saveDraft(found.account, { draft, replacesUid })); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// GET /api/mail/attachment — always downloaded, never rendered.
//
// The content type on the message is a stranger's claim about a stranger's
// file. Serving it back under that type means somebody's mailbox can put
// active content on this origin, so it goes out as a download of unknown bytes
// and the browser is told not to guess.
app.get('/api/mail/attachment', auth, async (req, res) => {
  const { accountId, folder = 'INBOX', uid, index } = req.query;
  if (!accountId || !uid) return res.status(400).json({ error: req.t('accountId and uid required') });
  const found = mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try {
    const file = await webmailClient.readAttachment(found.account, { folder, uid, index: index || 0 });
    const safeName = String(file.filename).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'attachment';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    audit(req.user.id, 'mail_attachment_download', req, `${safeName} from ${folder}:${uid}`);
    res.send(Buffer.from(file.content));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// POST /api/mail/send — compose, and reply, which is a compose that carries
// the threading headers.
//
// This one route takes a larger body than the rest of the app, because an
// attachment arrives base64-encoded and a ten megabyte file is fourteen
// megabytes of request. The limit is on this route alone: raising it globally
// would hand every other endpoint the same appetite.
app.post('/api/mail/send', auth, express.json({ limit: '14mb' }), async (req, res) => {
  const { accountId, to, cc, bcc, subject, text, inReplyTo, references, attachments, draftUid } = req.body || {};
  if (!accountId) return res.status(400).json({ error: req.t('accountId required') });
  const found = mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try {
    const result = await webmailClient.sendMessage(found.account, { to, cc, bcc, subject, text, inReplyTo, references, attachments, draftUid });
    audit(req.user.id, 'mail_send', req, `${to}${result.sentCopy.filed ? '' : ' (no Sent copy)'}`);
    res.json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// POST /api/mail/reply — kept because the panel calls it. It is the send path
// with the threading headers of the message being answered.
app.post('/api/mail/reply', auth, async (req, res) => {
  const { accountId, to, subject, text, inReplyTo, references } = req.body || {};
  if (!accountId || !to || !text) return res.status(400).json({ error: req.t('accountId, to, text required') });
  const found = mailAccountFor(req, accountId);
  if (!found) return res.status(404).json({ error: req.t('Account not found') });
  try {
    const result = await webmailClient.sendMessage(found.account, { to, subject, text, inReplyTo, references });
    audit(req.user.id, 'mail_reply', req, to);
    res.json(result);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// DELETE /api/mail/accounts/:id
app.delete('/api/mail/accounts/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id FROM mail_accounts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: req.t('Not found') });
  db.prepare('DELETE FROM mail_accounts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── PERMISSIONS MODEL ─────────────────────────────────────────────
// Per-site roles: owner | admin | editor | viewer

db.exec(`
  CREATE TABLE IF NOT EXISTS site_members (
    id         TEXT PRIMARY KEY,
    site_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'viewer',
    invited_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(site_id, user_id),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_site_members ON site_members(site_id);
`);

function siteRole(siteId, userId) {
  const site = db.prepare('SELECT user_id FROM sites WHERE id=?').get(siteId);
  if (site?.user_id === userId) return 'owner';
  const m = db.prepare('SELECT role FROM site_members WHERE site_id=? AND user_id=?').get(siteId, userId);
  return m?.role || null;
}

function requireSiteRole(minRole) {
  const HIERARCHY = { owner: 4, admin: 3, editor: 2, viewer: 1 };
  return (req, res, next) => {
    const siteId = req.params.siteId || req.params.id || req.body?.site_id;
    const role = siteRole(siteId, req.user.id);
    if (!role || HIERARCHY[role] < HIERARCHY[minRole]) {
      return res.status(403).json({ error: `Requires ${minRole} role` });
    }
    req.siteRole = role;
    next();
  };
}

// GET /api/sites/:id/members
app.get('/api/sites/:id/members', auth, (req, res) => {
  const role = siteRole(req.params.id, req.user.id);
  if (!role) return res.status(403).json({ error: req.t('No access') });
  const members = db.prepare(`
    SELECT sm.id, sm.role, sm.created_at, u.name, u.email
    FROM site_members sm JOIN users u ON u.id = sm.user_id
    WHERE sm.site_id=?
  `).all(req.params.id);
  const owner = db.prepare('SELECT id,name,email FROM users WHERE id=(SELECT user_id FROM sites WHERE id=?)').get(req.params.id);
  res.json({ members, owner, your_role: role });
});

// POST /api/sites/:id/members — invite by email
app.post('/api/sites/:id/members', auth, (req, res) => {
  const myRole = siteRole(req.params.id, req.user.id);
  if (!myRole || (myRole !== 'owner' && myRole !== 'admin')) return res.status(403).json({ error: req.t('Requires owner or admin') });
  const { email, role = 'viewer' } = req.body;
  if (!['admin','editor','viewer'].includes(role)) return res.status(400).json({ error: req.t('Invalid role') });
  const target = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (!target) return res.status(404).json({ error: req.t('User not found') });
  const id = uid(); const now = new Date().toISOString();
  try {
    db.prepare('INSERT OR REPLACE INTO site_members (id,site_id,user_id,role,invited_by,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, req.params.id, target.id, role, req.user.id, now);
    audit(req.user.id, 'site_member_add', req, `${email}:${role}`);
    res.json({ ok: true, id });
  } catch { res.status(500).json({ error: req.t('Could not add member') }); }
});

// PATCH /api/sites/:id/members/:memberId — change role
app.patch('/api/sites/:id/members/:memberId', auth, (req, res) => {
  const myRole = siteRole(req.params.id, req.user.id);
  if (!myRole || (myRole !== 'owner' && myRole !== 'admin')) return res.status(403).json({ error: req.t('Requires owner or admin') });
  const { role } = req.body;
  if (!['admin','editor','viewer'].includes(role)) return res.status(400).json({ error: req.t('Invalid role') });
  db.prepare('UPDATE site_members SET role=? WHERE id=? AND site_id=?').run(role, req.params.memberId, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/sites/:id/members/:memberId
app.delete('/api/sites/:id/members/:memberId', auth, (req, res) => {
  const myRole = siteRole(req.params.id, req.user.id);
  if (!myRole || (myRole !== 'owner' && myRole !== 'admin')) return res.status(403).json({ error: req.t('Requires owner or admin') });
  db.prepare('DELETE FROM site_members WHERE id=? AND site_id=?').run(req.params.memberId, req.params.id);
  res.json({ ok: true });
});

// ── GDPR EXPORT ───────────────────────────────────────────────────
app.get('/api/export', auth, (req, res) => {
  const user    = db.prepare('SELECT id,name,email,plan,created_at FROM users WHERE id=?').get(req.user.id);
  const files   = db.prepare('SELECT id,name,size,mime,folder,added_at FROM files WHERE user_id=?').all(req.user.id);
  const jrnl    = db.prepare('SELECT id,title,body,created_at FROM journal WHERE user_id=?').all(req.user.id);
  const bens    = db.prepare('SELECT * FROM beneficiaries WHERE user_id=?').all(req.user.id);
  const setts   = db.prepare('SELECT data FROM settings WHERE user_id=?').get(req.user.id);
  const sites   = db.prepare('SELECT id,name,domain,status,echo_context,created_at,updated_at FROM sites WHERE user_id=?').all(req.user.id).map(s => ({
    ...s,
    echo_context: (() => { try { return JSON.parse(s.echo_context); } catch { return {}; } })(),
    workspaces: db.prepare('SELECT id,name,type,sort_order,created_at FROM workspaces WHERE site_id=?').all(s.id).map(w => ({
      ...w,
      files: db.prepare('SELECT id,name,type,sync_state,created_at,updated_at FROM site_files WHERE workspace_id=?').all(w.id),
    })),
    deploy_targets: db.prepare('SELECT id,label,remote_path,is_primary,last_deployed FROM site_deploy_targets WHERE site_id=?').all(s.id),
    members: db.prepare('SELECT sm.id,sm.role,u.name,u.email FROM site_members sm JOIN users u ON u.id=sm.user_id WHERE sm.site_id=?').all(s.id),
  }));
  const mailAccounts = db.prepare('SELECT id,label,email,imap_host,imap_port,smtp_host,smtp_port,created_at FROM mail_accounts WHERE user_id=?').all(req.user.id);
  const deployCredentials = db.prepare('SELECT id,label,protocol,host,port,username,remote_dir,created_at FROM deploy_credentials WHERE user_id=?').all(req.user.id);
  audit(req.user.id, 'gdpr_export', req);
  res.json({ user, files, journal: jrnl, beneficiaries: bens, settings: setts ? JSON.parse(setts.data) : {}, sites, mail_accounts: mailAccounts, deploy_credentials: deployCredentials });
});

// ── PROVISIONING (account-scoped native panel actions) ───────────
db.exec(`
  CREATE TABLE IF NOT EXISTS provisioning_accounts (
    user_id            TEXT PRIMARY KEY,
    cpanel_user        TEXT NOT NULL,
    primary_domain     TEXT NOT NULL,
    domains            TEXT NOT NULL,
    allowed_dns_zones  TEXT NOT NULL,
    created_at         TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// JotPanel is the panel. cPanel, Plesk and DirectAdmin are accepted as archive
// sources by the portability service, never selected as the live operations
// engine. The mock is an explicit stage prop for the public demo only.
const panelAdapter = (process.env.JOTPANEL_PROVISIONING_ADAPTER ?? process.env.ARCA_PROVISIONING_ADAPTER) === 'mock'
  ? createMockProvisioningAdapter()
  : createNativeProvisioningAdapter({ db, usageService });
const provisioning = createProvisioningService({ adapter: panelAdapter, queue: actionStore });
console.log(`[provisioning] ${panelAdapter.name} adapter active${panelAdapter.name === 'mock-cpanel-whm' ? ' (explicit demo mode)' : ''}`);

// Always derives account context from the authenticated owner id, never from
// the request body. The legacy cpanel_user column is an internal compatibility
// field for old proposal validators; it is not a cPanel binding or credential.
function buildProvisioningAccountContext(userId) {
  const row = db.prepare('SELECT * FROM provisioning_accounts WHERE user_id=?').get(userId);
  if (row) {
    return {
      accountId: userId,
      cpanelUser: row.cpanel_user,
      primaryDomain: row.primary_domain,
      domains: JSON.parse(row.domains),
      allowedDnsZones: JSON.parse(row.allowed_dns_zones),
    };
  }
  const u = db.prepare('SELECT subdomain FROM users WHERE id=?').get(userId);
  const cpanelUser = (u?.subdomain || userId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'acct';
  const primaryDomain = `${cpanelUser}.jotpanel.invalid`; // explicit placeholder until the owner adds a real site
  db.prepare(`
    INSERT INTO provisioning_accounts (user_id,cpanel_user,primary_domain,domains,allowed_dns_zones)
    VALUES (?,?,?,?,?)
  `).run(userId, cpanelUser, primaryDomain, JSON.stringify([primaryDomain]), JSON.stringify([primaryDomain]));
  return { accountId: userId, cpanelUser, primaryDomain, domains: [primaryDomain], allowedDnsZones: [primaryDomain] };
}

app.get('/api/provisioning/actions', auth, (req, res) => {
  res.json({ durable: true, actions: provisioning.listActions({ accountId: req.user.id }).map(publicControlAction) });
});

app.post('/api/provisioning/propose', auth, async (req, res) => {
  try {
    const account = buildProvisioningAccountContext(req.user.id);
    const action = await provisioning.propose({ intent: req.body.intent, input: req.body.input, account });
    audit(req.user.id, 'provisioning_propose', req, action.label);
    res.json({ ok: true, action });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/provisioning/actions/:id/approve', auth, async (req, res) => {
  try {
    const existing = provisioning.getAction(req.params.id);
    if (!existing || existing.accountId !== req.user.id) return res.status(404).json({ error: req.t('Not found') });
    const action = await provisioning.approveAction(req.params.id, { approvedBy: req.user.id, confirmText: req.body.confirmText });
    audit(req.user.id, 'provisioning_approve', req, action.label);
    res.json({ ok: true, action });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/provisioning/actions/:id/reject', auth, async (req, res) => {
  try {
    const existing = provisioning.getAction(req.params.id);
    if (!existing || existing.accountId !== req.user.id) return res.status(404).json({ error: req.t('Not found') });
    const action = await provisioning.rejectAction(req.params.id, { rejectedBy: req.user.id, reason: req.body.reason });
    audit(req.user.id, 'provisioning_reject', req, action.label);
    res.json({ ok: true, action });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/provisioning/actions/:id/execute', auth, async (req, res) => {
  try {
    const existing = provisioning.getAction(req.params.id);
    if (!existing || existing.accountId !== req.user.id) return res.status(404).json({ error: req.t('Not found') });
    const account = buildProvisioningAccountContext(req.user.id);
    const action = await provisioning.executeApproved(req.params.id, { account });
    audit(req.user.id, 'provisioning_execute', req, action.label);
    res.json({ ok: true, action });
  } catch (e) {
    audit(req.user.id, 'provisioning_execute_failed', req, e.message);
    res.status(400).json({ error: e.message, action: publicControlAction(actionStore.get(req.params.id)) });
  }
});

// ── BOOTSTRAP API ─────────────────────────────────────────────────
//
// What is left of a router that used to be a second way to run this machine.
//
// It was eleven routes behind one static key: list every account, create one,
// delete one, overwrite anybody's password, suspend, restore, reset a second
// factor, mint a sign-in link for any account, mint a session as any account,
// read the audit record and read the usage feed. None of it went through
// `ownership.authorize`, none of it went through propose, approve and execute,
// and most of it wrote nothing to the audit record. It was reachable over the
// public internet: `https://<box>/admin/api/usage` answered 200 to the key
// alone, and every mutation route reached its handler the same way.
//
// A key is not an identity. It is the same password for everybody holding it,
// it cannot be revoked for one caller, and the record can only ever say that
// somebody with the key did something. Everything a person or a reseller does
// belongs to `account.create`, `account.suspend` and `account.unsuspend` in the
// catalogue, where the ownership hierarchy answers who may act on whom and the
// entitlements answer how many they may have.
//
// So four things are left here, and they are the ones with nobody to attribute
// them to yet or nowhere else to live:
//
//   - creating the first owner, which happens once, before any identity exists
//     to authorize it, and refuses to run a second time;
//   - a sign-in link, so that first owner can get in without a password
//     travelling through the installer's output;
//   - clearing a second factor, for the customer who lost the phone and the
//     recovery codes with it;
//   - the usage feed, which is numbers about accounts and changes nothing.
//
// They are mounted on their own express app on a loopback listener, so they are
// administered by somebody who is already on the machine. What used to be here
// is listed in `docs/ADMIN_API_BYPASS_VERIFICATION.md` with what replaced it.
const admin = express.Router();
admin.use(adminAuth);

// The first owner, and only the first. The installer creates the account that
// runs the box before there is any identity on the machine for the ownership
// engine to check, which is the one genuine bootstrap: a chicken-and-egg that
// authorization cannot answer because there is nobody to ask about yet.
//
// The moment there is one, that reason is gone and this refuses. A hosting
// company taking on a customer, a reseller taking on theirs and a billing
// system provisioning one all go through `account.create`, which puts the new
// account under whoever provided for it, inside the package they were sold, and
// writes the whole thing into the record. This route used to do none of that,
// so a caller with the key could add accounts that belonged to nobody and
// counted against no allocation.
admin.post('/accounts', (req, res) => {
  const { name, email, password, plan, storageGB, subdomain, serviceId } = req.body;
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0) {
    audit(null, 'bootstrap_account_refused', req, `${existing} account(s) already exist`);
    return res.status(409).json({
      error: req.t('This machine already has accounts. Creating one is account.create, which puts it under a provider and inside a package.'),
    });
  }
  if (!name || !email || !password) return res.status(400).json({ error: req.t('Missing fields') });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return res.status(409).json({ error: req.t('Email exists') });

  const id   = uid();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO users (id,name,email,password,plan,subdomain,storage_gb) VALUES (?,?,?,?,?,?,?)')
    .run(id, name, email, hash, plan||'starter', subdomain||id, storageGB||10);
  usageService.recordLifecycle(id, 'created', 'admin provisioned');
  db.prepare('INSERT INTO pub_folders (id,user_id,name,parent,site) VALUES (?,?,?,?,?)').run('root_'+id, id, 'root', null, 'default');
  db.prepare('INSERT INTO settings (user_id,data) VALUES (?,?)').run(id, JSON.stringify({ subdomain, whmcsServiceId: serviceId }));
  // An organization of their own, now rather than at the next restart, exactly
  // as `/api/register` has always done. This route did not, and the installer
  // creates the owner through it: the startup backfill had already run against
  // an empty database, so a freshly installed box had a user and no membership
  // at all. `/api/me` answered `is_operator: false` to the only account on the
  // machine, which shut the owner out of the licence screen, the accounts
  // screen and the whole hoster admin surface on first sign-in, until some
  // unrelated server reading happened to create the membership as a side
  // effect. Found by installing on a clean machine; it cannot be seen on a box
  // that has been developed on.
  try { ownership.ensureMembership(id); } catch (error) { audit(id, 'membership_not_created', req, error.message); }

  // And that organization becomes the entitlement root, now rather than at the
  // next restart, for exactly the reason the membership above is written here.
  // The boot migration marks the root, but it had already run against an empty
  // database by the time this route was called, so a freshly installed box had
  // an owner holding zero of every metric with source "missing": no site, no
  // database, no mailbox, and no package it could assign to a customer either.
  // See `ensureEntitlementRoot`. A failure here is recorded rather than thrown,
  // because an owner that exists and cannot yet provision is recoverable by a
  // restart, and an install that dies at the last step is not.
  try {
    const root = ensureEntitlementRoot();
    if (root && root.created) audit(id, 'bootstrap_entitlement_root', req, `${root.orgId} is this machine's entitlement root`);
    else if (!root) audit(id, 'entitlement_root_not_created', req, 'no hosting_company membership was found after creating the owner');
  } catch (error) { audit(id, 'entitlement_root_not_created', req, error.message); }

  // Written down as what it is. The actor is the machine's own installer,
  // because there is nobody else it could be: this runs once, from loopback,
  // before any identity exists.
  audit(id, 'bootstrap_owner_created', req, `${email} created as the first account on this machine`);
  res.json({ userId: id, email, plan: plan||'starter', subdomain: subdomain||id });
});

// A single-use sign-in link for an account. What it is for: a hosting company
// provisions a machine and hands the customer a way in that is not a password
// typed into a welcome email and read by everyone it passes. The link works
// once, expires in an hour by default, and the customer sets their own
// password from inside.
admin.post('/accounts/:id/login-link', (req, res) => {
  const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: req.t('Not found') });
  const minutes = Math.min(Math.max(parseInt(req.body?.minutes || '60', 10) || 60, 5), 60 * 24 * 7);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + minutes * 60000).toISOString();
  db.prepare('INSERT INTO magic_tokens (token,email,expires_at,used) VALUES (?,?,?,0)').run(magicHash(token), user.email, expires);
  audit(user.id, 'login_link_issued', req, `valid ${minutes} minutes, single use`);
  res.json({
    url: `https://${DOMAIN}/?magic=${token}`,
    email: user.email,
    expires_at: expires,
    single_use: true,
  });
});

// Suspending an account has to actually stop the account's services, not
// just the panel login — HOSTER_ADMIN_VERIFICATION.md found (and this was
// live-confirmed against a real demo customer) that a suspended account's
// website kept serving to anonymous visitors and its mail kept delivering,
// because suspension only ever touched `users.suspended`, which nothing
// outside `auth` and the login route reads. This walks every site the
// account owns (the same `resource_owners`/`memberships` ledger everything
// else here reads) and closes each channel in turn, per-domain, so one site
// failing to update does not block the others or leave the account record
// itself unchanged. Four channels: the website answers 503, mail is rejected
// at RCPT TO, SFTP is refused by sshd before authentication, and the account's
// backup timer is stopped. Panel login and the API were already blocked by
// `auth` re-reading `users.suspended` on every request.
async function setSitesSuspended(userId, suspended) {
  // Sites and mail are suspended together, per domain — the domain list is
  // the account's owned sites; a domain with mail but no site is a known,
  // narrow gap this pass does not cover (see the changelog entry for why).
  const { domainsByIdentity } = siteOwnershipByIdentity({ db });
  const domains = domainsByIdentity.get(userId) || [];
  const results = await Promise.all(domains.map(async d => {
    const site = await privilegedOps.run('site.suspend', { domain: d, suspended }).then(() => ({ ok: true })).catch(error => ({ ok: false, error: error.message }));
    const mail = await privilegedOps.run('mail.domain.suspend', { domain: d, suspended }).then(() => ({ ok: true })).catch(error => ({ ok: false, error: error.message }));
    // The other two ways into a suspended account. SFTP is a login the panel
    // never sees, and the backup timer is work the machine does for the
    // account with nobody signed in at all, so neither is covered by blocking
    // the panel or the website.
    const sftp = await privilegedOps.run('sftp.suspend', { domain: d, suspended }).then(() => ({ ok: true })).catch(error => ({ ok: false, error: error.message }));
    const cron = await privilegedOps.run('backup.schedule.suspend', { domain: d, suspended }).then(() => ({ ok: true })).catch(error => ({ ok: false, error: error.message }));
    return { domain: d, site, mail, sftp, cron };
  }));
  return results;
}

// A customer loses the phone and the recovery codes with it. Somebody has to
// be able to put that right or the account is gone, and that somebody is the
// hosting company, from the admin side, with the reset written into the record
// under the account it happened to. It only clears the second factor: the
// password is untouched, so this is not a way into an account, it is a way
// back to needing the password again.
admin.post('/accounts/:id/2fa/reset', (req, res) => {
  const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: req.t('Not found') });
  const before = twoFactor.status(user.id);
  db.transaction(() => {
    db.prepare('DELETE FROM two_factor_recovery WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM two_factor WHERE user_id=?').run(user.id);
  })();
  audit(user.id, 'two_factor_reset_by_hoster', req, before.enabled ? 'was on' : 'was not on');
  res.json({ ok: true, was_enabled: before.enabled, two_factor: twoFactor.status(user.id) });
});

// Gone from here, and where each one went. Kept as a list rather than as code
// so that adding one back is a decision somebody has to write down.
//
//   POST   /accounts/:id/sso        removed. It signed a session as any account
//                                   on the box and wrote nothing to the record,
//                                   so the audit log could not have shown that
//                                   it ever happened. Nothing called it. See
//                                   `docs/ROLES_AND_SURFACES.md` for the
//                                   standing decision that impersonation
//                                   belongs to the upgrade tier and has to be
//                                   attributable when it is built.
//   PUT    /accounts/:id/password   removed. It overwrote any account's
//                                   password with no authority check, no
//                                   length floor and no record. Nothing called
//                                   it. A hoster resetting a customer's
//                                   password is an account-lifecycle item and
//                                   will be a catalogue operation.
//   DELETE /accounts/:id            removed. It deleted the row and the uploads
//                                   directory and left the sites serving, the
//                                   mail arriving, the databases, the DNS zones
//                                   and the backups behind. Nothing called it.
//                                   Closing an account properly is its own item.
//   POST   /accounts/:id/suspend    removed, both of them. `account.suspend`
//   POST   /accounts/:id/unsuspend  and `account.unsuspend` do the same work
//                                   through the ownership engine, so a reseller
//                                   can stop its own customer and nobody else's.
//   GET    /accounts                removed. `app.get('/admin/api/accounts')`
//   GET    /audit                   above answers both to the operator's own
//                                   signed-in identity, and has since before
//                                   this router was looked at: these two were
//                                   shadowed by it and unreachable, which is
//                                   why asking for them with the key answered
//                                   401 rather than a list.

// Vendor-neutral feed: the same numbers as JSON for a billing system or CSV
// for the human who will actually use it first. No WHMCS assumptions here.
admin.get('/usage', (req, res) => {
  try {
    const range = { period: req.query.period, from: req.query.from, to: req.query.to };
    const reports = req.query.accountId
      ? [usageService.reportForAccount(req.query.accountId, range)]
      : usageService.reportAll(range);
    if (req.query.format === 'csv') {
      const label = (req.query.period || reports[0]?.period?.from?.slice(0, 10) || 'period').replace(/[^0-9-]/g, '');
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="jotpanel-usage-${label}.csv"` });
      return res.send(usageService.toCsv(reports));
    }
    res.json({ schema: 'jotpanel-usage-feed/v1', generated_at: new Date().toISOString(), accounts: reports });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// Where the bootstrap surface listens, and it is not on `app`.
//
// `app` is served twice: on 127.0.0.1:9999, which nginx proxies to the whole
// internet, and on the recovery port, which binds every interface itself so the
// owner can still reach the panel when nginx is the thing that is broken. A
// router mounted on `app` is therefore on the internet by default, and the
// second listener is easy to forget: the loopback check inside `adminAuth`
// existed for less than an hour before this listener was written, and in that
// hour it was the only thing standing between the recovery port and the
// bootstrap routes.
//
// So the routes get their own app and their own listener bound to 127.0.0.1.
// Nothing that is not already on this machine can open the socket, whatever any
// present or future nginx configuration says, and a route added to the wrong
// app is a 404 rather than a hole. The path stays `/admin/api` so that what
// calls it changes a port and nothing else.
const BOOTSTRAP_PORT = parseInt((process.env.JOTPANEL_BOOTSTRAP_PORT ?? process.env.ARCA_BOOTSTRAP_PORT) || '9998', 10);
if ((process.env.JOTPANEL_BOOTSTRAP_PORT ?? process.env.ARCA_BOOTSTRAP_PORT) !== 'off') {
  const bootstrap = express();
  bootstrap.use(express.json({ limit: '1mb' }));
  // So the installer can wait for this listener rather than assume it, the way
  // it already waits for the panel's. Both are bound in the same tick, but "the
  // main port answered, therefore this one is up" is the kind of assumption
  // that costs an install on a slow box, and that lesson is already written
  // into `wait_for_http`.
  bootstrap.get('/health', (req, res) => res.json({ ok: true, surface: 'bootstrap' }));
  bootstrap.use('/admin/api', admin);
  bootstrap.use((req, res) => res.status(404).json({ error: req.t('Not found') }));
  bootstrap.listen(BOOTSTRAP_PORT, '127.0.0.1', () => {
    console.log(`[jotpanel] Bootstrap surface on 127.0.0.1:${BOOTSTRAP_PORT}, loopback only`);
  }).on('error', e => console.warn(`[jotpanel] bootstrap port ${BOOTSTRAP_PORT} unavailable:`, e.message));
}

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── 404 / error handlers ──────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: req.t('Not found') }));
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') return res.status(403).json({ error: req.t('Invalid request') });
  console.error('[error]', err.message);
  res.status(500).json({ error: req.t('Internal error') });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jotpanel] Running on 127.0.0.1:${PORT}`);
  console.log(`[jotpanel] Domain: ${DOMAIN}`);
});

// The recovery listener, and the reason it exists.
//
// The panel's normal address is served by nginx, which is one of the things
// the panel is for fixing. Behind nginx, a panel cannot repair the web server
// that stopped serving it, so the first real outage is also the moment the
// product is unreachable. Every serious panel answers on an address of its
// own for this reason, and this is ours: 7443, close enough to 443 to be
// guessable and far enough from anyone else's number to sit beside them on a
// machine that already runs one.
const PANEL_PORT = parseInt((process.env.JOTPANEL_PANEL_PORT ?? process.env.ARCA_PANEL_PORT) || '7443');
function recoveryCredentials() {
  // A certificate the panel user can actually read. Let's Encrypt keys are
  // root-owned by design, so a configured pair is used when it is readable
  // and a self-signed pair is written next to the data otherwise. A warning
  // in the browser on a recovery port is a smaller failure than no way in.
  const certPath = (process.env.JOTPANEL_PANEL_CERT ?? process.env.ARCA_PANEL_CERT);
  const keyPath  = (process.env.JOTPANEL_PANEL_KEY ?? process.env.ARCA_PANEL_KEY);
  if (certPath && keyPath) {
    try { return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }; }
    catch (e) { console.warn('[jotpanel] configured panel certificate is not readable here:', e.message); }
  }
  const dir  = path.join(DATA_DIR, 'panel-tls');
  const crt  = path.join(dir, 'recovery.crt');
  const key  = path.join(dir, 'recovery.key');
  try {
    if (!fs.existsSync(crt) || !fs.existsSync(key)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      require('child_process').execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
        '-subj', `/CN=${DOMAIN || 'jotpanel'}`,
        '-keyout', key, '-out', crt,
      ], { stdio: 'ignore' });
      fs.chmodSync(key, 0o600);
      console.log('[jotpanel] wrote a self-signed certificate for the recovery port');
    }
    return { cert: fs.readFileSync(crt), key: fs.readFileSync(key) };
  } catch (e) {
    console.warn('[jotpanel] no certificate for the recovery port:', e.message);
    return null;
  }
}
if ((process.env.JOTPANEL_PANEL_PORT ?? process.env.ARCA_PANEL_PORT) !== 'off') {
  const creds = recoveryCredentials();
  if (creds) {
    require('https').createServer(creds, app).listen(PANEL_PORT, '0.0.0.0', () => {
      console.log(`[jotpanel] Recovery port https://${DOMAIN || '0.0.0.0'}:${PANEL_PORT} (survives nginx)`);
    }).on('error', e => console.warn(`[jotpanel] recovery port ${PANEL_PORT} unavailable:`, e.message));
  }
}
