// Does it actually render.
//
// The panel and the desktop are two files that import from each other in one
// direction, and the faults that split creates do not show up in a build. A
// binding that moved to the wrong side still builds. A module-scope value read
// before the file that sets it has run still builds. Both then produce a blank
// screen or a screen with no colours, in front of somebody, later.
//
// So this renders every panel section and both shells to a string, without a
// browser, and a fault becomes a failed render here instead.
//
//   node render.test.mjs
//
// It bundles through esbuild, which is already a dependency of Vite, and it
// stubs the browser rather than emulating it: renderToString never runs an
// effect, so nothing here needs to answer a fetch.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(`${here}/package.json`);
const esbuild = require_('esbuild');
const React = require_('react');
const { renderToString } = require_('react-dom/server');

// ── the browser, in as few lines as renderToString needs ──────────
const store = new Map();
const style = { setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; } };
const node = () => ({ style, setAttribute(){}, getAttribute(){ return null; }, appendChild(){}, removeChild(){}, remove(){}, classList:{ add(){}, remove(){} } });
const browser = {
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k,v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  window: { location:{ origin:'https://panel.test', href:'https://panel.test/' }, addEventListener(){}, removeEventListener(){}, matchMedia:() => ({ matches:false, addEventListener(){}, removeEventListener(){} }) },
  document: { documentElement:{ ...node(), style }, body:node(), head:node(), createElement:node, getElementById:() => null, querySelector:() => null, addEventListener(){}, removeEventListener(){} },
  navigator: { userAgent:'node', language:'en' },
  fetch: () => new Promise(() => {}),
  indexedDB: { open: () => ({ onupgradeneeded:null, onsuccess:null, onerror:null, result:null }) },
  speechSynthesis: { getVoices: () => [], speak(){}, cancel(){} },
  Audio: function () { return { play(){}, pause(){}, volume:0 }; },
};

async function load(entry) {
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: here, loader: 'jsx' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/server'], logLevel: 'warning',
  });
  const module_ = { exports: {} };
  const context = vm.createContext({ ...browser, globalThis: undefined, require: require_, module: module_, exports: module_.exports, console });
  context.globalThis = context;
  vm.runInContext(built.outputFiles[0].text, context, { filename: 'bundle.cjs' });
  return module_.exports;
}

const panel = await load(`export * from './control-panel.jsx'; export { setLanguage, t } from './i18n.js';`);
const panelSource = readFileSync(new URL('./control-panel.jsx', import.meta.url), 'utf8');
const serverSitesSource = panelSource.slice(panelSource.indexOf('function ServerSites'), panelSource.indexOf('function SiteApplications'));
assert.ok(serverSitesSource.indexOf('Add a domain or subdomain') < serverSitesSource.indexOf('<strong>{t("Sites")}</strong>') && serverSitesSource.indexOf('Add a domain or subdomain') < serverSitesSource.indexOf('Run a site with something other than PHP'),
  'the add-domain card must appear at the top, before the sites table and runtime card');
assert.equal(panel.serverUnavailableMessage('mailadmin'), 'The mail server is not installed yet');
assert.equal(panel.serverUnavailableMessage('database.list'), 'The database server is not installed yet');
assert.equal(panel.serverUnavailableMessage('service.list'), "This isn't available on this server yet");
assert.ok(panelSource.includes('<summary style={{fontSize:10.5,cursor:"pointer",color:"#667385"}}>{t("Details")}</summary>'),
  'technical capability reasons must be hidden behind a Details disclosure');
const backupsSource = panelSource.slice(panelSource.indexOf('function ServerBackups'), panelSource.indexOf('function ServerMail'));
assert.ok(backupsSource.indexOf('/api/platform/config') < backupsSource.indexOf('/api/deploy/credentials'),
  'Backups must read the deploy switch before requesting credentials');
assert.ok(backupsSource.includes('config?.deployPushEnabled === true'),
  'Backups must request credentials only when deploy push is explicitly enabled');
const mailAdminSource = panelSource.slice(panelSource.indexOf('function ServerMailAdmin'), panelSource.indexOf('function ServerSites'));
assert.ok(mailAdminSource.includes('Generate a password') && mailAdminSource.includes('generate:["password"]'),
  'the mailbox form must offer server-side password generation');
// The desktop is a separate product, absent from the public JotPanel repository.
const HAS_DESKTOP = (await import('node:fs')).existsSync(new URL('./arca-webos.jsx', import.meta.url));
const desktop = HAS_DESKTOP ? await load(`export { default as ArcaWebOS, LoginScreen, ProjectManagerApp } from './arca-webos.jsx';`) : null;

const user = { id: 1, email: 'owner@example.test', name: 'Owner' };
let rendered = 0;

// 1. Every section the panel says it has must render. The list is the panel's
//    own, so a section added later is covered without touching this file.
for (const section of panel.PANEL_SECTIONS) {
  const html = renderToString(React.createElement(panel.ControlPanelApp, { user, standalone:true, initialSection:section, onOpenApp(){}, onSignOut(){} }));
  assert.ok(html.length > 500, `panel section "${section}" rendered almost nothing`);
  rendered++;
}

// 2. The four screens the panel mounts that the desktop also opens in a window.
for (const [name, props] of [
  ['SettingsApp', { standalone:true, installed:new Set(), onInstall(){}, onUninstall(){} }],
  ['ProjectsSettings', {}], ['FilesApp', {}], ['MailApp', {}], ['AdminApp', {}],
]) {
  assert.ok(renderToString(React.createElement(panel[name], props)).length > 100, `${name} rendered almost nothing`);
  rendered++;
}

const residentProjects = renderToString(React.createElement(panel.ProjectsSettings));
for (const label of ['Projects', 'Build plan', 'Create plan']) {
  assert.ok(residentProjects.includes(label), `Resident projects first paint does not show "${label}"`);
}

// Files has a second, authenticated rendering path. Effects do not run here,
// but the server-mode shell and its four places still have to render rather
// than letting the local fallback be the only path this suite proves.
store.set('arca_server', 'https://panel.test');
store.set('arca_jwt', 'test-session');
const serverFiles = renderToString(React.createElement(panel.FilesApp));
for (const place of ['My Files', 'Public', 'Shared', 'Trash']) {
  assert.ok(serverFiles.includes(place), 'server-mode FilesApp did not render ' + place);
}
store.delete('arca_server');
store.delete('arca_jwt');
rendered++;

// 3. The desktop, which imports the panel rather than containing it.
for (const [name, el] of HAS_DESKTOP ? [['LoginScreen', React.createElement(desktop.LoginScreen, { onAuth(){} })], ['ArcaWebOS', React.createElement(desktop.ArcaWebOS)]] : []) {
  assert.ok(renderToString(el).length > 500, `${name} rendered almost nothing`);
  rendered++;
}

// 3b. The project manager's own screen, rendered on its own rather than only as
// part of the shell. It is the one surface that draws nothing until a fetch
// answers, and renderToString never runs an effect, so this proves the empty
// state draws rather than throwing on a null brief — which is exactly what a
// person sees for the first second every time they open it.
if (HAS_DESKTOP) {
  const empty = renderToString(React.createElement(desktop.ProjectManagerApp));
  assert.match(empty, /No projects yet/, 'the project manager does not draw its empty state');
  rendered++;
}

// 4. Settings is given its desktop-only sections rather than containing them,
//    so the shell decides. A section nobody hands in is not offered.
const settings = extra => renderToString(React.createElement(panel.SettingsApp, { installed:new Set(), onInstall(){}, onUninstall(){}, ...extra }));
const standalone = settings({ standalone:true });
const withSections = settings({ desktopSections:{ apps:React.createElement('div'), appearance:React.createElement('div') } });
const withNone = settings({});
for (const label of ['Appearance', 'Installed Apps']) {
  assert.ok(!standalone.includes(label), `the standalone panel must not offer ${label}`);
  assert.ok(withSections.includes(label), `a shell that hands in ${label} must get it`);
  assert.ok(!withNone.includes(label), `a shell that hands in nothing must not offer ${label}`);
}
assert.ok(standalone.includes('AI Connections') && withSections.includes('AI Connections'), 'both shells keep the sections that are not desktop-only');

// A tool appears only where a probe proved permission, and absent means absent
// rather than greyed out. The domain card is the newest thing to obey that, and
// it is worth an assertion because it is also the first screen for an operation
// that restarts the panel: what that costs has to be readable before the button
// rather than discovered after it.
{
  const api = () => Promise.resolve({});
  const held = renderToString(React.createElement(panel.PanelDomain, { ops: { api, can: () => true, propose() {}, busy: false } }));
  const notHeld = renderToString(React.createElement(panel.PanelDomain, { ops: { api, can: () => false, propose() {}, busy: false } }));
  assert.ok(held.includes('answers on'), 'the domain card draws where the capability is held');
  assert.equal(notHeld, '', 'and draws nothing where it is not — no disabled button, no empty card');
  assert.ok(held.includes('signed out for a moment'), 'the restart is stated before the button');
  assert.ok(held.includes('disabled'), 'and the button is refused until a name and an address are typed');
  console.log('domain card checks passed — drawn only where permitted, and honest about the restart');
}

// The one thing a standalone webmail cannot do, and the judgement behind it.
//
// Every sentence the mail client says about whether a message will arrive comes
// out of one pure function, so what it will and will not claim is testable
// without a mail server. The two rules worth an assertion are the two that make
// it trustworthy: it stays silent when nothing is wrong, and it never reports a
// domain as fine when nobody actually asked.
{
  const advise = panel.mailDeliveryAdvice;
  const healthy = {
    address: 'sales@lakeside.example',
    dkim: { domain:'lakeside.example', signing:true, keys:[{ selector:'arca', dns_name:'arca._domainkey.lakeside.example', dns_value:'v=DKIM1; p=AAAA' }] },
    auth: { domain:'lakeside.example', findings:[], dkim:{ present:true, keys:[{ selector:'arca' }] } },
    queue: { messages:[], count:0 },
  };
  const quiet = advise(healthy);
  assert.equal(quiet.quiet, true, 'a domain with nothing wrong says nothing in the compose window');
  // Compared by length rather than by deepEqual: these arrays are made inside
  // the sandbox the bundle runs in, so they are structurally equal to a plain
  // [] and not reference-equal to one.
  assert.equal(quiet.notes.length, 0);
  assert.equal(quiet.fixes.length, 0);

  // Nothing answered. This is the case that must not read as a clean bill of
  // health: silence here would tell somebody their mail is fine when the panel
  // never looked.
  const unasked = advise({ address:'sales@lakeside.example' });
  assert.equal(unasked.quiet, false, 'a domain nothing was asked about is not reported as fine');
  assert.equal(unasked.authKnown, false);
  assert.equal(unasked.queueKnown, false);

  // The failure a client on somebody else's server cannot see: the key is on
  // this machine, the mail is signed with it, and the record was never
  // published, so every message fails a check nobody is told about.
  const unpublished = advise({ ...healthy, auth: { ...healthy.auth, dkim:{ present:false, keys:[] } } });
  assert.ok(unpublished.notes.some(note => /not published/.test(note.sentence)),
    'a key this server signs with that DNS does not carry is named');
  const publish = unpublished.fixes.find(fix => fix.operation === 'dns.record.create');
  assert.ok(publish, 'and the fix is offered as an operation');
  assert.equal(publish.input.label, 'arca._domainkey', 'aimed at the selector this machine actually uses');
  assert.equal(publish.input.value, 'v=DKIM1; p=AAAA', 'carrying the record off the machine rather than one composed here');
  assert.ok(unpublished.fixes.some(fix => fix.operation === 'mailauth.setup'));

  // A stuck message is somebody's. It is sorted by who sent it, so the person
  // reading is shown their own and told plainly how many others there are
  // rather than being shown the whole machine's spool.
  const stuck = advise({
    ...healthy,
    queue: { count:2, messages:[
      { id:'AAAA1111', sender:'sales@lakeside.example', recipients:['buyer@example.net'], reason:'connect timed out' },
      { id:'BBBB2222', sender:'someone@lakeside.example', recipients:['x@example.net'], reason:null },
    ] },
  });
  assert.equal([...stuck.stuck.mine].map(row => row.id).join(), 'AAAA1111');
  assert.equal([...stuck.stuck.others].map(row => row.id).join(), 'BBBB2222');
  assert.equal(stuck.level, 'problem', 'a message of your own sitting in the queue is not a quiet state');
  assert.equal(stuck.quiet, false);

  // An empty queue and a queue nobody read are different answers, and the
  // second one is never drawn as the first.
  assert.equal(advise(healthy).queueKnown, true);
  assert.equal(advise({ ...healthy, queue:null }).queueKnown, false);

  console.log('mail delivery advice checks passed — silent when right, never green when unasked');
}

console.log(`render tests passed — ${rendered} surfaces rendered, both shells`);

// Reuse the imported module: re-importing would hide frozen module-load labels.
const englishGroups = panel.panelToolGroups();
for (const language of ['fr', 'es', 'pt', 'de', 'nl']) {
  panel.setLanguage(language);
  const groups = panel.panelToolGroups();
  assert.equal(groups[0].title, panel.t('Websites & files'));
  assert.equal(groups[0].tools[0].label, panel.t('Domains & sites'));
  assert.deepEqual(groups.flatMap(group => group.tools.map(tool => tool.section)),
    englishGroups.flatMap(group => group.tools.map(tool => tool.section)), 'language must not change navigation IDs');
  for (const section of panel.PANEL_SECTIONS) {
    const html = renderToString(React.createElement(panel.ControlPanelApp, { user, standalone:true, initialSection:section, onOpenApp(){}, onSignOut(){} }));
    assert.ok(html.length > 500, `${language}: ${section} renders after changing language`);
  }
}
panel.setLanguage('en');
assert.equal(panel.panelToolGroups()[0].title, englishGroups[0].title);
console.log('language-switch render checks passed — five languages, same imported module');
