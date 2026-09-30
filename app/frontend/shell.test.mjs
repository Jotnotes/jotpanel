// Shell-split invariants.
//
// Two entry points over one application drift. These are the properties that
// have to hold for the standalone panel and the Arca desktop to stay the same
// product, checked without a browser so they are checked every time.
//
//   node --experimental-strip-types shell.test.mjs   (plain node is enough)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { APPLICATION_UI, auditRowsToCsv, filterAuditRows, filterControlActions, scheduledJobFormProblem, scheduledJobRunTone } from './panel-helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

// The panel is its own file. Almost everything below is a property of the free
// panel rather than of the desktop, so `source` is the panel's source and the
// desktop's is read separately for the few checks that are about the boundary
// between them.
const source = readFileSync(join(here, 'control-panel.jsx'), 'utf8');
// The desktop is a separate product and is absent from the public JotPanel
// repository; the checks about the boundary run wherever it is present.
const HAS_DESKTOP = existsSync(join(here, 'arca-webos.jsx'));
const desktop = HAS_DESKTOP ? readFileSync(join(here, 'arca-webos.jsx'), 'utf8') : '';

// The tool list is a pure function of a few badge numbers, so it can be
// evaluated here without React. Pulling it out of the source rather than
// importing the JSX keeps this test dependency-free.
function loadToolGroups() {
  const start = source.indexOf('export function panelToolGroups(');
  assert.notEqual(start, -1, 'panelToolGroups must stay a single exported definition');
  // Walk past the parameter list first — it destructures, so its braces are
  // not the body's.
  let paren = 0, i = source.indexOf('(', start);
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++;
    else if (source[i] === ')' && --paren === 0) { i++; break; }
  }
  const bodyStart = source.indexOf('{', i);
  let depth = 0, end = -1;
  for (let j = bodyStart; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  const body = source.slice(bodyStart, end);
  // The real signature, read out of the source rather than copied here.
  //
  // It used to be a hand-written duplicate of the parameter list, and when
  // `operator` was added to the real function this file kept the old list, so
  // the extracted body referenced a name that did not exist and the whole test
  // threw on import. It had been failing that way, unnoticed, because nothing
  // runs the frontend tests: `npm run test:unit` is backend only. A test that
  // guards the panel and desktop split is worth more than that, so the one
  // thing that drifted is now taken from the file it is testing.
  const signature = source.slice(source.indexOf('(', source.indexOf('export function panelToolGroups')), bodyStart).trim();
  // Supply the formatting and translation helpers used by the extracted list.
  const fn = new Function('panelFormatBytes', 't', `return (function panelToolGroups${signature} ${body})`);
  return fn(() => '0 B', text => text)({});
}

function loadSections() {
  const match = source.match(/export const PANEL_SECTIONS = \[([\s\S]*?)\];/);
  assert.ok(match, 'PANEL_SECTIONS must stay declared');
  // Comments first. The list carries one explaining why `admin` is in it, and
  // splitting on commas without stripping it turned that entry into the
  // comment plus the name, so `admin` was silently not in the set at all.
  return [...match[1].replace(/\/\/.*$/gm, '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

const groups = loadToolGroups();
const sections = new Set(loadSections());
const tools = groups.flatMap(group => group.tools);

// 1. Every tool must work in the standalone panel. A tool with only a window
//    target is reachable on the desktop and dead in the panel, which is the
//    exact drift this file exists to catch.
for (const tool of tools) {
  assert.ok(tool.section, `"${tool.label}" has no section, so it would be dead in the standalone panel`);
  assert.ok(sections.has(tool.section), `"${tool.label}" points at section "${tool.section}", which the panel does not render`);
}

// 2. Anything that opens a desktop window must also name the section the panel
//    shows instead, and that section must be one the panel really renders.
for (const tool of tools.filter(t => t.app)) {
  assert.ok(tool.section, `"${tool.label}" opens the ${tool.app} window but names no panel section`);
}

// 3. The list is single-source. A second definition is how the shells diverge.
assert.equal(source.split('export function panelToolGroups(').length - 1, 1, 'panelToolGroups is defined more than once');

// 4. Both entry points mount the same component rather than a copy of it, and
//    the dependency runs one way only. The panel may not reach into the
//    desktop's file, because anything it reaches for has to ship with it, and
//    that is how the whole upgrade front end came to be in the customer bundle.
const panelEntry = readFileSync(join(here, 'panel.jsx'), 'utf8');
assert.match(panelEntry, /import \{[^}]*ControlPanelApp[^}]*\} from '\.\/control-panel\.jsx'/,
  'the standalone panel must mount the same ControlPanelApp, not its own copy');
assert.doesNotMatch(panelEntry, /function ControlPanelApp/, 'the standalone panel must not redefine the panel');
assert.doesNotMatch(panelEntry, /arca-webos/, 'the standalone panel entry must not reach the desktop');
assert.doesNotMatch(source, /from ["'][^"']*arca-webos/,
  'control-panel.jsx must not import the desktop, or publishing the panel publishes the desktop');
if (HAS_DESKTOP) {
  assert.match(desktop, /from ["']\.\/control-panel\.jsx["']/,
    'the desktop must import the panel rather than carry a second copy of it');
  assert.doesNotMatch(desktop, /export function ControlPanelApp/,
    'ControlPanelApp must be defined once, in control-panel.jsx');
}

// 3b. The list of sections cannot drift from the sections that exist. It was
//     short by two, `backuphealth` and `backups`, both reachable from the
//     panel's own navigation, so a tool pointing at either would have been
//     called dead by check 1 while working perfectly.
//     Scoped to the panel's own body, because Settings has sections of its own
//     that are nothing to do with this list.
const panelBody = (() => {
  const from = source.indexOf('export function ControlPanelApp(');
  assert.notEqual(from, -1, 'ControlPanelApp must stay a single exported definition');
  const to = source.indexOf('\nfunction ', from);
  return source.slice(from, to === -1 ? undefined : to);
})();
const drawn = new Set([...panelBody.matchAll(/section === "([a-z]+)" &&/g)].map(m => m[1]));
for (const section of drawn) {
  assert.ok(sections.has(section), `the panel draws "${section}" and PANEL_SECTIONS does not list it`);
}

// 4b. The panel must not name the desktop's own screens. Every name it
//     mentions is a name it has to ship, and Settings is where that leaks:
//     two of its sections exist only where there is a desktop, so the desktop
//     hands them in rather than the panel branching on them. Comments are
//     stripped first, because the comment explaining this rule names them.
const panelCode = source.replace(/^\s*\/\/.*$/gm, '');
for (const desktopOnly of ['AppearanceSection', 'ALL_APPS', 'InstalledAppsSection', 'MarketplaceApp', 'EchoBar', 'BuilderApp']) {
  assert.ok(!panelCode.includes(desktopOnly),
    `control-panel.jsx names ${desktopOnly}, so the free panel ships it`);
}
assert.match(source, /desktopSections/, 'Settings must take its desktop-only sections as a prop');
if (HAS_DESKTOP) assert.match(desktop, /desktopSections=\{\{/, 'the desktop must hand Settings its own sections');

// 4c. The panel has to set the OS tokens on :root itself. Files, Mail and
//     Settings are wrapped in `.ap-embed`, which redeclares them, but the host
//     administration screen is drawn straight into the panel and its whole
//     stylesheet is written in var(--os-*). Move the skin out of the panel and
//     that screen loses every colour it has, with nothing failing to build.
assert.match(source, /function applySkin\(/, 'the panel must carry applySkin: it is what sets the OS tokens on :root');
assert.match(source, /applySkin\(localStorage\.getItem\("aos_skin"\)/, 'the panel must apply a skin at load');
assert.doesNotMatch(source, /className="ap-embed"><AdminApp/, 'if admin is ever embedded, this rule can be revisited');

// 5. The embedded surfaces take their colours from the shell. If a component
//    that mounts inside the panel paints itself with a fixed dark value, a
//    person who only ever sees the standalone panel meets a dark rectangle.
const embed = source.match(/\.ap-embed\{([\s\S]*?)\}/);
assert.ok(embed, '.ap-embed must declare the panel palette for embedded apps');
for (const token of ['--os-ink', '--os-win', '--os-txt', '--os-border', '--os-panel', '--os-accent-txt', '--os-danger-txt']) {
  assert.ok(embed[1].includes(token), `.ap-embed must redeclare ${token} for anything mounted inside it`);
}
for (const [name, text] of [['control-panel.jsx', source], ...(HAS_DESKTOP ? [['arca-webos.jsx', desktop]] : [])]) {
  assert.doesNotMatch(text, /background: "#0a0c14"/, `${name}: Settings must not paint itself dark regardless of shell`);
  assert.equal((text.match(/rgba\(255,255,255,/g) || []).length, 0,
    `${name}: translucent layers must be mixed from --os-ink so they follow the shell`);
}

// 6. A stack install changes the capability surface. The execution refresh
// must bypass the engine cache or a successful install still looks unavailable
// until somebody happens to click Refresh after the cache expires.
assert.match(source, /runQuiet\(`execute-\$\{action\.id\}`[\s\S]*?true\);/,
  'executing an action must force a fresh capability probe');
assert.match(source, /server\/capabilities\$\{refreshCapabilities \? "\?refresh=1" : ""\}/,
  'a forced panel refresh must reach the backend capability refresh flag');

// 7. The jobs form catches requests the backend is guaranteed to refuse, and
// the run-state colours do not call an in-progress run a failure.
assert.equal(scheduledJobFormProblem({ schedule:'0 3 * * *', command:'backup' }), 'Use a job name between 2 and 120 characters.');
assert.equal(scheduledJobFormProblem({ name:'Backup', schedule:'0 3 * *', command:'backup' }),
  'Use five cron fields: minute, hour, day, month, weekday.');
assert.equal(scheduledJobFormProblem({ name:'Backup', schedule:'61 3 * * *', command:'backup' }),
  'Check cron field 1: 61.');
assert.equal(scheduledJobFormProblem({ name:'Backup', schedule:'0 3 * * *' }), 'Enter the command to run.');
assert.equal(scheduledJobFormProblem({ name:'Backup', schedule:'0 3 * * *', command:'backup' }), '');
assert.equal(scheduledJobRunTone('running'), 'info');
assert.equal(scheduledJobRunTone('timed_out'), 'bad');

// 8. Admin JSON is not success by definition. Failed HTTP responses must
// reject, and the console is reached by being signed in rather than by holding
// a shared key.
assert.match(source, /async function adminApiRequest[\s\S]*?if \(!response\.ok\)[\s\S]*?throw error;/,
  'admin requests must reject non-success HTTP responses');
// This used to check that the key was stored only after it was accepted. There
// is no key now, which is the stronger version of the same guarantee: nothing
// to store, nothing to leak out of a browser, nothing to share between people.
assert.doesNotMatch(source, /aos_admin_key/,
  'the console must not keep a shared admin key anywhere');
assert.doesNotMatch(source, /"x-admin-key"/,
  'the console must not authenticate with a shared key');
assert.match(source, /async function adminApiRequest[\s\S]*?Authorization:`Bearer \$\{readPanelStorage\("jwt"\)/,
  'admin requests must carry the signed-in session');
assert.match(source, /const me = await adminApiRequest\("\/api\/me"\);[\s\S]*?setAuthed\(!!me\.is_operator\)/,
  'access is decided by asking the server who is signed in');

// 9. The two records can be narrowed without changing their source rows, and
// spreadsheet export cannot turn audit detail into a formula.
const controlRows = [
  { id:'one', label:'Create site', status:'pending', summary:'example.test' },
  { id:'two', label:'Restart mail', status:'executed', summary:'postfix' },
];
assert.deepEqual(filterControlActions(controlRows, { query:'site', status:'pending' }).map(row=>row.id), ['one']);
assert.deepEqual(filterControlActions(controlRows, { status:'executed' }).map(row=>row.id), ['two']);
const auditRows = [
  { ts:'2026-08-21', user_id:'alice', action:'site_create', details:'example.test', ip:'127.0.0.1' },
  { ts:'2026-08-20', user_id:'bob', action:'login', details:'=HYPERLINK("bad")', ip:'127.0.0.2' },
];
assert.equal(filterAuditRows(auditRows, { query:'alice' }).length, 1);
assert.equal(filterAuditRows(auditRows, { action:'login' })[0].user_id, 'bob');
assert.match(auditRowsToCsv(auditRows), /"'=HYPERLINK\(""bad""\)"/,
  'CSV cells that could execute as formulas must be neutralized');

// 10. The host screen follows the operator layout contract: permanent
// navigation at the left and identity plus state in the top bar.
const adminSource = source.slice(source.indexOf('function AdminApp()'), source.indexOf('// ── API PROVIDER MANAGER'));
assert.match(adminSource, /<aside className="ad-sidebar"/,
  'host administration must keep its navigation in a sidebar');
assert.match(adminSource, /<header className="ad-topbar"/,
  'host administration must carry identity and state in a top bar');
assert.doesNotMatch(adminSource, /📊 Overview|👥 Users|📋 Audit Log|⚙️ Platform/,
  'host navigation must use the panel icon system rather than emoji tabs');
assert.doesNotMatch(adminSource, /\/suspend`|\/unsuspend`|\/sso`|method:"PATCH"|method:"DELETE"/,
  'host administration must not call the legacy direct-write routes');
assert.match(adminSource, /Account changes are not offered from this screen/,
  'the read-only account screen must name the missing approval path');
assert.match(adminSource, /Platform configuration is read-only here/,
  'the read-only platform screen must name the missing approval path');

// 11. Application metadata stays UI-only, and missing capability or context is
// explained in words rather than represented by a dead Install button.
assert.deepEqual(Object.keys(APPLICATION_UI).sort(), ['phpmyadmin','wordpress']);
for (const [id, app] of Object.entries(APPLICATION_UI)) {
  assert.ok(app.icon && app.description && app.parameters.length, `${id} needs complete UI metadata`);
}
assert.doesNotMatch(source, /disabled=\{!!ops\.busy\|\|!app\.available\|\|!domain\}/,
  'an unavailable catalogue application must not render a disabled Install button');

// A key for an AI can read and ask; it must never be offered approval, the
// firewall, the console, SSH keys, accounts or everything. The list is read
// from the source so a new area cannot slip one in unseen.
{
  const block = /const AI_KEY_AREAS = \[([\s\S]*?)\n\];/.exec(source);
  assert.ok(block, 'the Connect your AI areas are declared');
  const scopes = [...block[1].matchAll(/"([a-z0-9.*_-]+)"/g)].map(m => m[1]).filter(v => v.includes('.') || v === '*');
  assert.ok(scopes.length > 0, 'the areas name scopes');
  for (const scope of scopes) {
    assert.ok(scope !== '*' && !/^(control|firewall|console|sshkey|account|entitlements|packages|fail2ban|capability|stack)\b/.test(scope), `an AI key must not be offered ${scope}`);
  }
}

console.log(`shell tests passed — ${tools.length} tools, all openable in both shells`);
