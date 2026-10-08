// The password form: does it exist, and does it behave.
//
// `POST /api/me/password` shipped with no user interface at all, so this file
// covers the form added for it. Two harnesses, because the two questions need
// different machinery:
//
//   1. Does it render, in the section a person would look in? That is the
//      harness `render.test.mjs`, `shell.test.mjs` and
//      `hoster-optional-fleet.test.mjs` use: bundle through esbuild, stub the
//      browser in as few lines as `renderToString` needs, run no effect.
//
//   2. Does it refuse a mismatched confirmation, show the server's own words,
//      ask for a code only when the account has a factor, and replace the
//      stored session with the fresh token? None of that is visible in a
//      string. `renderToString` runs no effect and no handler, and this tree
//      has no test renderer and no DOM. So the second half swaps `react` and
//      `react/jsx-runtime` for about sixty lines of stand-ins: real hook
//      semantics over a slot array, and elements kept as plain descriptors.
//      The component under test is the real one, bundled from the real file.
//
//   node password-form.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(`${here}/package.json`);
const esbuild = require_('esbuild');
const React = require_('react');
const { renderToString } = require_('react-dom/server');

// An unhandled rejection from a form that posts a password is exactly the kind
// of fault this file exists to catch, and node reports one by exiting after the
// assertions have passed.
process.on('unhandledRejection', error => {
  console.error('an unhandled rejection escaped the password form:', error);
  process.exit(1);
});

// ── the browser, in as few lines as either harness needs ───────────
const store = new Map();
const style = { setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; } };
const node = () => ({ style, setAttribute(){}, getAttribute(){ return null; }, appendChild(){}, removeChild(){}, remove(){}, classList:{ add(){}, remove(){} } });
const localStorageStub = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k,v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const browser = {
  localStorage: localStorageStub,
  window: { location:{ origin:'https://panel.test', href:'https://panel.test/' }, addEventListener(){}, removeEventListener(){}, matchMedia:() => ({ matches:false, addEventListener(){}, removeEventListener(){} }) },
  document: { documentElement:{ ...node(), style }, body:node(), head:node(), createElement:node, getElementById:() => null, querySelector:() => null, addEventListener(){}, removeEventListener(){} },
  navigator: { userAgent:'node', language:'en' },
  // Never resolves, so a reading stays in its loading state and no effect is
  // needed by the first harness.
  fetch: () => new Promise(() => {}),
  indexedDB: { open: () => ({ onupgradeneeded:null, onsuccess:null, onerror:null, result:null }) },
  speechSynthesis: { getVoices: () => [], speak(){}, cancel(){} },
  Audio: function () { return { play(){}, pause(){}, volume:0 }; },
};

async function build(entry) {
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: here, loader: 'jsx' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom/server'], logLevel: 'warning',
  });
  return built.outputFiles[0].text;
}

function run(code, requireShim) {
  const module_ = { exports: {} };
  const context = vm.createContext({ ...browser, globalThis: undefined, require: requireShim || require_, module: module_, exports: module_.exports, console });
  context.globalThis = context;
  vm.runInContext(code, context, { filename: 'bundle.cjs' });
  return module_.exports;
}

const ENTRY = `export * from './control-panel.jsx';`;
const code = await build(ENTRY);

// ══ 1. It renders, and it renders inside the existing section ══════
const panel = run(code);
const user = { id: 1, email: 'owner@example.test', name: 'Owner' };
const sectionHtml = id => renderToString(React.createElement(panel.ControlPanelApp,
  { user, standalone:true, initialSection:id, onOpenApp(){}, onSignOut(){} }));

const security = sectionHtml('twofactor');
for (const expected of ['Your password', 'The password you have now', 'Your new password', 'Your new password again', 'Change my password']) {
  assert.ok(security.includes(expected), `the password form does not render "${expected}" in the sign-in security section`);
}
// In that section and not in a new one of its own: the neighbours this form was
// put beside are on the same screen.
// (Account recovery codes draws nothing until its reading comes back, and no
// effect runs here, so it is not among these.)
for (const neighbour of ['Passkeys', 'Two-factor authentication', 'Sign-in security']) {
  assert.ok(security.includes(neighbour), `"${neighbour}" is no longer on the screen the password form was added to`);
}
// And the panel's own section list did not grow a section for it.
assert.ok(panel.PANEL_SECTIONS.includes('twofactor'), 'the sign-in security section is gone from the panel');
assert.ok(!panel.PANEL_SECTIONS.some(id => /password/i.test(id)), 'a separate password section was invented rather than using the security screen');
assert.ok(!sectionHtml('settings').includes('The password you have now'), 'the password form leaked onto the Settings screen');

// A password manager has to recognise both halves, or it offers to save the old
// password over the new one.
assert.ok(/autoComplete="current-password"/.test(security), 'the current-password box is not marked for a password manager');
assert.equal((security.match(/autoComplete="new-password"/g) || []).length, 2,
  'both new-password boxes must be marked new-password, so a manager offers to save the new one');
assert.equal((security.match(/<input[^>]*type="password"/g) || []).length >= 3, true, 'the three password boxes must be masked');

// The second-factor box is not drawn before the server has said whether this
// account has one. `renderToString` runs no effect, so this is the first paint.
assert.ok(!security.includes('A code from your authenticator app, or a recovery code'),
  'the second-factor box is drawn before the server has said the account has a factor');
console.log('  the form renders in the sign-in security screen, beside the passkeys and the second factor');

// The floor the hint states is the floor the route applies, held against the
// route\'s own constant rather than against a number typed twice.
const { MIN_LENGTH } = require_(join(here, '..', 'backend', 'control', 'changePassword.js'));
assert.equal(panel.MIN_NEW_PASSWORD_LENGTH, MIN_LENGTH,
  `the form states a floor of ${panel.MIN_NEW_PASSWORD_LENGTH} and the route applies ${MIN_LENGTH}`);
assert.equal(MIN_LENGTH, 12, 'the product floor is twelve, not the eight of the closed public sign-up path');
console.log(`  the stated floor is the route's own MIN_LENGTH of ${MIN_LENGTH}`);

// ══ 2. A hook renderer, so the handlers can actually be run ════════
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

function hookHarness() {
  const FRAGMENT = { shim: 'Fragment' };
  const element = (type, props) => ({ type, props: props || {} });
  const jsxRuntime = { jsx: element, jsxs: element, Fragment: FRAGMENT };

  let slots = [];
  let index = 0;
  let effects = [];
  let draw = () => {};
  let rendering = false;

  const useMemo = (fn, deps) => {
    const i = index++;
    if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
    return slots[i].value;
  };
  const react = {
    Fragment: FRAGMENT,
    useState(initial) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[i];
      return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; draw(); }];
    },
    useRef(initial) { const i = index++; if (!slots[i]) slots[i] = { current: initial }; return slots[i]; },
    useMemo,
    useCallback: (fn, deps) => useMemo(() => fn, deps),
    useEffect(fn, deps) {
      const i = index++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) { slots[i] = { deps }; effects.push(fn); }
    },
  };

  const requireShim = name => (name === 'react' ? react : name === 'react/jsx-runtime' ? jsxRuntime : require_(name));

  // Mount one component. `tree` is whatever it last returned; `settle` flushes
  // effects and the microtasks they start.
  function mount(Component, props) {
    slots = []; effects = []; let tree = null;
    draw = () => {
      if (rendering) throw new Error('a render started inside a render');
      rendering = true;
      index = 0;
      try { tree = Component(props); } finally { rendering = false; }
    };
    draw();
    const settle = async () => {
      for (let pass = 0; pass < 8; pass += 1) {
        const queued = effects; effects = [];
        queued.forEach(fn => fn());
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!effects.length) break;
      }
    };
    return { settle, get tree() { return tree; }, redraw: draw };
  }
  return { mount, requireShim };
}

const { mount, requireShim } = hookHarness();
const shimmed = run(code, requireShim);
assert.equal(typeof shimmed.PasswordSection, 'function', 'PasswordSection is not exported');

// Walking the descriptor tree. Function components are left unexpanded: this
// file is about one component, and expanding its neighbours would only put
// their faults in its results.
const nodes = (n, out = []) => {
  if (n == null || typeof n === 'boolean') return out;
  if (Array.isArray(n)) { n.forEach(child => nodes(child, out)); return out; }
  if (typeof n !== 'object') return out;
  out.push(n);
  nodes(n.props?.children, out);
  return out;
};
const textOf = n => nodes(n)
  .flatMap(el => [el.props?.placeholder, el.props?.['aria-label'], ...[].concat(el.props?.children ?? [])])
  .filter(v => typeof v === 'string' || typeof v === 'number')
  .join('\u0001');
const boxFor = (n, label) => nodes(n).find(el => el.type === 'input' && el.props['aria-label'] === label);
const submitOf = n => nodes(n).find(el => el.type === 'button' && typeof el.props.onClick === 'function');
const type = (box, value) => box.props.onChange({ target: { value } });

// An `api` stand-in with the real one's contract: it resolves the parsed body
// and throws `new Error(data.error)` on a refusal. Every call is recorded.
function fakeApi(answers) {
  const calls = [];
  const api = async (path, opts = {}) => {
    calls.push({ path, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const answer = answers[path];
    if (typeof answer === 'function') return answer();
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`nothing stubbed for ${path}`);
    return answer;
  };
  return { api, calls, posts: () => calls.filter(c => c.path === '/api/me/password') };
}

const CHANGE = '/api/me/password';
const CURRENT = 'the-old-one-9999';
const NEXT = 'a-long-enough-new-one';

// ── 2a. A mismatched confirmation is refused here, not posted ──────
{
  const { api, calls, posts } = fakeApi({ '/api/2fa': { enabled: false, expected: false, role: 'owner' } });
  const view = mount(shimmed.PasswordSection, { api });
  await view.settle();

  type(boxFor(view.tree, 'The password you have now'), CURRENT);
  type(boxFor(view.tree, 'Your new password'), NEXT);
  type(boxFor(view.tree, 'Your new password again'), NEXT + 'x');

  // Said while typing, before anything is pressed.
  assert.ok(textOf(view.tree).includes('The two new passwords do not match.'),
    'a mismatched confirmation is not pointed out while typing');
  // The button refuses to be pressed.
  assert.equal(submitOf(view.tree).props.disabled, true, 'the button is live with a mismatched confirmation');
  // And the handler refuses even if it is called anyway, which is the defence
  // that survives somebody loosening the `disabled` expression.
  await submitOf(view.tree).props.onClick();
  assert.equal(posts().length, 0, 'a mismatched confirmation was posted to the server');
  assert.ok(textOf(view.tree).includes('do not match'), 'the refusal is not shown to the person');
  assert.equal(calls.length, 1, 'something other than the posture reading was requested');

  // Matching it makes the button live, and nothing was sent in the meantime.
  type(boxFor(view.tree, 'Your new password again'), NEXT);
  assert.equal(submitOf(view.tree).props.disabled, false, 'a matching confirmation does not make the button live');
  assert.equal(posts().length, 0);
  console.log('  a mismatched confirmation is refused in the form, and never reaches the route');
}

// ── 2b. The code box appears only for an account with a factor ─────
{
  const off = fakeApi({ '/api/2fa': { enabled: false, expected: true, role: 'owner' } });
  const plain = mount(shimmed.PasswordSection, { api: off.api });
  await plain.settle();
  assert.equal(boxFor(plain.tree, 'A code from your authenticator app, or a recovery code'), undefined,
    'an account with no second factor is asked for a code it cannot produce');

  const on = fakeApi({ '/api/2fa': { enabled: true, expected: true, role: 'owner', recovery_codes_left: 7 } });
  const withFactor = mount(shimmed.PasswordSection, { api: on.api });
  await withFactor.settle();
  const codeBox = boxFor(withFactor.tree, 'A code from your authenticator app, or a recovery code');
  assert.ok(codeBox, 'an account with a second factor is not asked for a code');
  assert.equal(codeBox.props.autoComplete, 'one-time-code', 'the code box is not marked as a one-time code');
  assert.ok(textOf(withFactor.tree).includes('a code is needed too'), 'the screen does not say a code is needed');

  // The route refuses without it, so the form must not offer to try.
  type(boxFor(withFactor.tree, 'The password you have now'), CURRENT);
  type(boxFor(withFactor.tree, 'Your new password'), NEXT);
  type(boxFor(withFactor.tree, 'Your new password again'), NEXT);
  assert.equal(submitOf(withFactor.tree).props.disabled, true, 'the button is live with the required code missing');

  // And the code really is in the request, under the name the route reads.
  const answers = { '/api/2fa': { enabled: true, expected: true, role: 'owner', recovery_codes_left: 7 } };
  answers[CHANGE] = { ok: true, token: 'fresh.jwt.value', user: { id: 1, name: 'Owner', email: 'owner@example.test' }, note: 'noted' };
  const sending = fakeApi(answers);
  const live = mount(shimmed.PasswordSection, { api: sending.api });
  await live.settle();
  type(boxFor(live.tree, 'The password you have now'), CURRENT);
  type(boxFor(live.tree, 'Your new password'), NEXT);
  type(boxFor(live.tree, 'Your new password again'), NEXT);
  type(boxFor(live.tree, 'A code from your authenticator app, or a recovery code'), ' 123456 ');
  await submitOf(live.tree).props.onClick();
  assert.equal(sending.posts()[0].body.code, '123456', 'the code is not sent, or not trimmed, under the name the route reads');
  console.log('  the second-factor box appears only for an account that has one, and its code is sent with the password');
}

// ── 2c. The server's own error text is what the person reads ───────
for (const sentence of [
  'That password is not right',
  'Choose a password of at least 12 characters.',
  'That code is not right',
]) {
  const answers = { '/api/2fa': { enabled: false, expected: false, role: 'owner' } };
  answers[CHANGE] = new Error(sentence);
  const { api } = fakeApi(answers);
  const view = mount(shimmed.PasswordSection, { api });
  await view.settle();
  type(boxFor(view.tree, 'The password you have now'), 'wrong-but-long-enough');
  type(boxFor(view.tree, 'Your new password'), NEXT);
  type(boxFor(view.tree, 'Your new password again'), NEXT);
  await submitOf(view.tree).props.onClick();
  const shown = textOf(view.tree);
  assert.ok(shown.includes(sentence), `the route said "${sentence}" and the screen does not say it`);
  // Shown as the panel shows a refusal, so a screen reader announces it.
  const alert = nodes(view.tree).find(el => el.props?.role === 'alert');
  assert.ok(alert && textOf(alert).includes(sentence), `"${sentence}" is not in the alert region`);
  // And the boxes are left as they were, so a wrong code is not a retyped
  // password.
  assert.equal(boxFor(view.tree, 'Your new password').props.value, NEXT, 'a refusal cleared the form');
}
console.log("  three refusals: the route's own sentence is what the screen says, in its alert region");

// ── 2d. On success the fresh token replaces the stored one ─────────
{
  store.clear();
  store.set('jotpanel_jwt', 'stale.jwt.value');
  store.set('jotpanel_user', JSON.stringify({ id: 1, name: 'Owner', email: 'owner@example.test' }));
  const NOTE = 'Your password is changed. Sessions already signed in elsewhere stay signed in until they expire.';
  const answers = { '/api/2fa': { enabled: false, expected: false, role: 'owner' } };
  answers[CHANGE] = { ok: true, token: 'fresh.jwt.value', user: { id: 1, name: 'Owner', email: 'owner@example.test', plan: 'free' }, note: NOTE };
  const { api, posts } = fakeApi(answers);
  const view = mount(shimmed.PasswordSection, { api });
  await view.settle();
  type(boxFor(view.tree, 'The password you have now'), CURRENT);
  type(boxFor(view.tree, 'Your new password'), NEXT);
  type(boxFor(view.tree, 'Your new password again'), NEXT);
  await submitOf(view.tree).props.onClick();

  // The request the route documents, and nothing else in it.
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].opts.method, 'POST');
  assert.equal(posts()[0].path, CHANGE, 'the password must not travel in a path or a query string');
  assert.ok(!/[?=]/.test(posts()[0].path), 'the request path carries a query string');
  assert.deepEqual(posts()[0].body, { current_password: CURRENT, new_password: NEXT },
    'the posted body is not the pair the route reads');

  // The session in hand was minted before the change. This is the assertion
  // that catches a form which changes the password and then carries on using
  // the old token.
  assert.equal(store.get('jotpanel_jwt'), 'fresh.jwt.value',
    'the fresh token did not replace the stored session, so the panel keeps using one minted before the change');
  assert.equal(JSON.parse(store.get('jotpanel_user')).plan, 'free', 'the refreshed account row was not stored');

  // The server's sentence, which is honest about other sessions. Not a claim
  // that everything else was signed out, because it was not.
  const status = nodes(view.tree).find(el => el.props?.role === 'status');
  assert.ok(status && textOf(status).includes(NOTE), "the route's own note is not what the screen shows");
  assert.ok(/stay signed in until they expire/.test(textOf(view.tree)), 'the honest sentence about other sessions is gone');
  assert.ok(!/signed out everywhere|all other sessions (were|are) (ended|signed out)/i.test(textOf(view.tree)),
    'the screen claims other sessions were signed out, which the route does not do');

  // Nothing cached. Every box is empty again and no password is in storage.
  for (const label of ['The password you have now', 'Your new password', 'Your new password again']) {
    assert.equal(boxFor(view.tree, label).props.value, '', `"${label}" still holds a password after the change`);
  }
  for (const [key, value] of store) {
    assert.ok(!String(value).includes(CURRENT) && !String(value).includes(NEXT),
      `a password was written into client storage under ${key}`);
  }
  assert.equal(textOf(view.tree).includes(NEXT), false, 'the new password is drawn into the page as text');
  console.log('  on success: the documented body, the fresh token stored, the honest note shown, every box cleared');
  store.clear();
}

// ── 2e. The source itself, for the two faults a render cannot show ─
{
  const source = readFileSync(join(here, 'control-panel.jsx'), 'utf8');
  const form = source.slice(source.indexOf('export function PasswordSection'), source.indexOf('function TwoFactorSection'));
  assert.ok(form.length > 500, 'PasswordSection was not found in control-panel.jsx');
  assert.doesNotMatch(form, /console\.(log|warn|error|info|debug)/, 'the password form logs');
  assert.doesNotMatch(form, /(localStorage|sessionStorage|indexedDB)\./, 'the password form reaches for client storage directly');
  assert.doesNotMatch(form, /writePanelStorage\(\s*["'](?!jwt|user)/, 'the password form writes something other than the session to storage');
  console.log('  nothing logged, nothing stored but the session the sign-in screen already stores');
}

console.log('password form tests passed — in its section, refuses a mismatch, asks for a code only when there is one, speaks the server\'s words, and replaces the session');
