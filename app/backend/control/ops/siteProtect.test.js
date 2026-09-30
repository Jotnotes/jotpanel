'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  hashPassword,
  verifyPassword,
  renderHtpasswd,
  parseHtpasswd,
  renderAuthLocation,
  addOrReplaceUser,
  removeUser,
} = require('./siteProtect');

const ALICE_HASH = hashPassword('alice-password');
const BOB_HASH = hashPassword('bob-password-2');

test('hash then verify round-trips and rejects a wrong password', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.match(hash, /^\{SHA\}[A-Za-z0-9+/]{27}=$/);
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('wrong horse battery staple', hash), false);
});

test('verify returns false for malformed hashes', () => {
  assert.equal(verifyPassword('correct horse battery staple', null), false);
  assert.equal(verifyPassword('correct horse battery staple', '{SHA}bad'), false);
});

test('short and multiline passwords are refused', () => {
  assert.throws(() => hashPassword('too-short'), /at least 10 characters/);
  assert.throws(() => hashPassword('long enough\nbut split'), /one line/);
});

test('render then parse round-trips to identical sorted bytes', () => {
  const rendered = renderHtpasswd([
    { username: 'bob', hash: BOB_HASH },
    { username: 'alice', hash: ALICE_HASH },
  ]);
  assert.equal(rendered, `alice:${ALICE_HASH}\nbob:${BOB_HASH}\n`);
  assert.equal(renderHtpasswd(parseHtpasswd(rendered).entries), rendered);
});

test('corrupt lines are skipped while good lines still parse', () => {
  const contents = `# managed elsewhere\nalice:${ALICE_HASH}\nmissing-a-colon\nbob:bad-hash\n\n`;
  assert.deepEqual(parseHtpasswd(contents), {
    entries: [{ username: 'alice', hash: ALICE_HASH }],
    skipped: ['missing-a-colon', 'bob:bad-hash'],
  });
});

test('whole-site protection is rendered at server scope', () => {
  const result = renderAuthLocation({
    path: '/',
    authFilePath: '/etc/nginx/protect/arca-example.com-root.htpasswd',
  });
  assert.equal(result.scope, 'server');
  assert.equal(result.text,
    '  # Managed by jotpanel-ops. Edit through the panel.\n'
    + '  auth_basic "Restricted";\n'
    + '  auth_basic_user_file /etc/nginx/protect/arca-example.com-root.htpasswd;\n');
  assert.doesNotMatch(result.text, /location/);
});

test('directory protection restores PHP inside the authenticated prefix', () => {
  const result = renderAuthLocation({
    path: '/admin',
    authFilePath: '/etc/nginx/protect/arca-example.com-admin.htpasswd',
    phpSocketPath: '/run/php/arca-example.com.sock',
  });
  assert.equal(result.scope, 'location');
  assert.equal(result.text,
    '  # Managed by jotpanel-ops. Edit through the panel.\n'
    + '  location ^~ /admin/ {\n'
    + '    auth_basic "Restricted";\n'
    + '    auth_basic_user_file /etc/nginx/protect/arca-example.com-admin.htpasswd;\n'
    + '    location ~ \\.php$ {\n'
    + '      auth_basic "Restricted";\n'
    + '      auth_basic_user_file /etc/nginx/protect/arca-example.com-admin.htpasswd;\n'
    + '      include snippets/fastcgi-php.conf;\n'
    + '      fastcgi_pass unix:/run/php/arca-example.com.sock;\n'
    + '    }\n'
    + '  }\n');
  assert.equal(result.text.match(/arca-example\.com-admin\.htpasswd/g).length, 2);
});

test('static directory protection omits the PHP handler', () => {
  const result = renderAuthLocation({
    path: '/admin',
    authFilePath: '/etc/nginx/protect/arca-example.com-admin.htpasswd',
  });
  assert.equal(result.text,
    '  # Managed by jotpanel-ops. Edit through the panel.\n'
    + '  location ^~ /admin/ {\n'
    + '    auth_basic "Restricted";\n'
    + '    auth_basic_user_file /etc/nginx/protect/arca-example.com-admin.htpasswd;\n'
    + '  }\n');
  assert.doesNotMatch(result.text, /fastcgi_pass/);
});

test('directory trailing slashes normalize to identical output', () => {
  const options = { authFilePath: '/etc/nginx/protect/arca-example.com-admin.htpasswd' };
  const plain = renderAuthLocation({ ...options, path: '/admin' });
  assert.deepEqual(renderAuthLocation({ ...options, path: '/admin/' }), plain);
  assert.deepEqual(renderAuthLocation({ ...options, path: '/admin//' }), plain);
});

test('nested protected paths keep their full prefix', () => {
  const result = renderAuthLocation({
    path: '/admin/reports',
    authFilePath: '/etc/nginx/protect/arca-example.com-admin-reports.htpasswd',
  });
  assert.match(result.text, /location \^~ \/admin\/reports\//);
});

test('unsafe nginx inputs are refused', () => {
  assert.throws(() => renderAuthLocation({
    path: '/admin/../etc',
    authFilePath: '/etc/nginx/protect/arca-example.com-admin.htpasswd',
  }), /not a path inside the site/);
  assert.throws(() => renderAuthLocation({
    path: '/admin',
    authFilePath: 'etc/nginx/protect/arca-example.com-admin.htpasswd',
  }), /absolute filesystem path/);
  assert.throws(() => renderAuthLocation({
    path: '/admin',
    authFilePath: '/etc/nginx/protect/arca-example.com-admin.htpasswd',
    realm: 'Staff "only"',
  }), /cannot contain a quote/);
});

test('addOrReplaceUser replaces without mutating its input', () => {
  const input = [{ username: 'alice', hash: ALICE_HASH }];
  const snapshot = structuredClone(input);
  const replacement = addOrReplaceUser(input, 'alice', BOB_HASH);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(replacement, [{ username: 'alice', hash: BOB_HASH }]);
  assert.notStrictEqual(replacement, input);
  assert.notStrictEqual(replacement[0], input[0]);
});

test('removeUser returns a new array and tolerates a missing username', () => {
  const input = [{ username: 'alice', hash: ALICE_HASH }];
  assert.deepEqual(removeUser(input, 'alice'), []);
  const unchanged = removeUser(input, 'bob');
  assert.deepEqual(unchanged, input);
  assert.notStrictEqual(unchanged, input);
  assert.notStrictEqual(unchanged[0], input[0]);
});

test('renderHtpasswd refuses malformed and duplicate entries', () => {
  assert.throws(() => renderHtpasswd([
    { username: 'alice', hash: ALICE_HASH },
    { username: 'alice', hash: BOB_HASH },
  ]), /appears more than once/);
  assert.throws(() => renderHtpasswd([{ username: 'bad:user', hash: ALICE_HASH }]), /username/);
  assert.throws(() => renderHtpasswd([{ username: 'alice', hash: 'not-a-hash' }]), /valid nginx/);
  assert.equal(renderHtpasswd([]), '');
});
