'use strict';
const assert = require('assert');
const { test } = require('node:test');
const { detect, OPERATIONS, spokenAddresses } = require('./assistantProposals');
const { getOperation } = require('./ops/catalogue');

// ── The mailbox, the first row and the shape of all of them ───────
test('a plain request stages the mailbox operation', () => {
  const hit = detect('create a mailbox sales@example.com');
  assert.equal(hit.operation, 'mail.mailbox.create');
  assert.equal(hit.input.account, 'sales');
  assert.equal(hit.input.domain, 'example.com');
  assert.ok(hit.input.password.length >= 12);
  assert.deepEqual(hit.deliver, ['password'], 'a generated password has to reach the person once');
});

test('the password is generated per call and never read out of the text', () => {
  const a = detect('add an email account bob@shop.io password hunter2');
  const b = detect('add an email account bob@shop.io password hunter2');
  assert.notEqual(a.input.password, b.input.password);
  assert.ok(!/hunter2/.test(a.input.password));
});

test('a quota is carried only when it is stated', () => {
  assert.equal(detect('create mailbox a@b.com with 500 MB').input.quotaMb, 500);
  assert.equal(detect('create mailbox a@b.com').input.quotaMb, undefined);
});

test('politeness around an instruction is still an instruction', () => {
  assert.equal(detect('can you create a mailbox sales@example.com').operation, 'mail.mailbox.create');
  assert.equal(detect('please back up example.com').operation, 'backup.create');
  assert.equal(detect('hi, could you please add example.com to this server').operation, 'site.create');
});

test('a question is not a request', () => {
  assert.equal(detect('how do mailboxes work here?'), null);
  assert.equal(detect('what is sales@example.com used for'), null);
  assert.equal(detect('is there a backup of example.com'), null);
  assert.equal(detect('which certificate does example.com use'), null);
});

test('nothing is inferred when the address is missing', () => {
  assert.equal(detect('create a mailbox for sales'), null);
});

// ── The rest of the list ─────────────────────────────────────────
test('mail housekeeping is staged from the words people use', () => {
  const fwd = detect('forward sales@example.com to steve@higashi.edu');
  assert.equal(fwd.operation, 'mail.forwarder.set');
  assert.deepEqual(fwd.input, { domain: 'example.com', account: 'sales', forward: 'steve@higashi.edu' });

  const away = detect('set an out of office on sales@example.com saying "back on Monday"');
  assert.equal(away.operation, 'mail.autoreply.set');
  assert.equal(away.input.message, 'back on Monday');

  const size = detect('set the size of sales@example.com to 2GB');
  assert.equal(size.operation, 'mail.mailbox.quota');
  assert.equal(size.input.quotaMb, 2048);
});

test('the forward runs in the direction the sentence puts it', () => {
  const hit = detect('forward old@example.com to new@example.com');
  assert.equal(hit.input.account, 'old');
  assert.equal(hit.input.forward, 'new@example.com');
});

test('an automatic reply is never assembled out of the rest of the sentence', () => {
  assert.equal(detect('set up an out of office on sales@example.com'), null);
  assert.equal(detect('turn off the out of office on sales@example.com'), null);
});

test('mail authentication and the signing key on its own are different rows', () => {
  assert.equal(detect('set up SPF, DKIM and DMARC for example.com').operation, 'mailauth.setup');
  assert.equal(detect('sort out mail authentication for example.com').operation, 'mailauth.setup');
  assert.equal(detect('set up DKIM for example.com').operation, 'mail.dkim.enable');
});

test('sites, certificates and zones', () => {
  assert.deepEqual(detect('add example.com to this server'), { operation: 'site.create', input: { domain: 'example.com' }, deliver: null });
  assert.equal(detect('create a website for shop.example.com').operation, 'site.create');
  assert.equal(detect('get an SSL certificate for example.com').operation, 'certificate.issue');
  const zone = detect('create a DNS zone for example.com pointing at 1.2.3.4');
  assert.equal(zone.operation, 'dns.zone.create');
  assert.deepEqual(zone.input, { zone: 'example.com', ip: '1.2.3.4' });
});

test('a record inside a zone is not staged, because the zone would be a guess', () => {
  assert.equal(detect('add an A record for blog.example.co.uk pointing at 1.2.3.4'), null);
});

test('a repeating backup is a schedule and a one-off is not', () => {
  const every = detect('back up example.com every night');
  assert.equal(every.operation, 'backup.schedule.set');
  assert.equal(every.input.when, 'daily');
  assert.equal(detect('back up example.com every week').input.when, 'weekly');
  assert.equal(detect('back up example.com').operation, 'backup.create');
  assert.equal(detect('restore example.com from last night\'s backup'), null);
});

test('databases, and the narrower reading first', () => {
  const user = detect('create a database user called wp_user');
  assert.equal(user.operation, 'database.user.create');
  assert.equal(user.input.username, 'wp_user');
  assert.deepEqual(user.deliver, ['password'], 'nobody typed this password either');
  assert.equal(detect('create a database called wp_blog').operation, 'database.create');
  assert.equal(detect('create a postgres database called reports').input.engine, 'postgres');
  assert.equal(detect('create a database'), null, 'a database with no name is nothing to propose');
});

test('a site request and a mailbox request are told apart', () => {
  assert.equal(detect('create a mailbox sales@example.com').operation, 'mail.mailbox.create');
  assert.equal(detect('add the site example.com').operation, 'site.create');
  assert.equal(detect('add example.com as a site').operation, 'site.create');
});

test('a file name is never read as a domain to add', () => {
  assert.equal(detect('add index.html to this server'), null);
  assert.equal(detect('create a website from dump.sql'), null);
});

test('two names means nothing is staged', () => {
  assert.equal(detect('add example.com and example.net to this server'), null);
});

// ── The boundary ─────────────────────────────────────────────────
test('an operation outside the list cannot be reached by wording', () => {
  for (const text of [
    'delete the mailbox sales@example.com',
    'drop the database called shop',
    'create a mailbox and also drop the database',
    'run system.reboot',
    'create user root@example.com with sudo',
    'restart the machine',
    'remove example.com from this server',
    'stop forwarding sales@example.com to steve@higashi.edu',
    'delete every queued message',
    'run rm -rf / on the server',
  ]) {
    const hit = detect(text);
    assert.ok(hit === null || OPERATIONS.includes(hit.operation), `escaped the list: ${text}`);
  }
});

test('nothing destructive is in the list at all', () => {
  for (const id of OPERATIONS) {
    const operation = getOperation(id);
    assert.notEqual(operation.risk, 'destructive', `${id} is destructive and must not be proposable by the assistant`);
    assert.equal(operation.confirm, undefined, `${id} needs a typed word and must not be proposable by the assistant`);
  }
});

test('every key in the list is a real catalogue operation', () => {
  for (const id of OPERATIONS) assert.ok(getOperation(id), `${id} is not in the catalogue`);
});

test('what the builders produce is what the catalogue accepts', () => {
  for (const text of [
    'create a mailbox sales@example.com',
    'forward sales@example.com to steve@higashi.edu',
    'set an out of office on sales@example.com saying "back on Monday"',
    'set the size of sales@example.com to 2GB',
    'set up SPF, DKIM and DMARC for example.com',
    'set up DKIM for example.com',
    'get an SSL certificate for example.com',
    'create a DNS zone for example.com pointing at 1.2.3.4',
    'back up example.com every night',
    'back up example.com',
    'create a database user called wp_user',
    'create a database called wp_blog',
    'add example.com to this server',
  ]) {
    const hit = detect(text);
    assert.ok(hit, `nothing staged for: ${text}`);
    const operation = getOperation(hit.operation);
    const params = operation.normalize(hit.input);
    assert.ok(operation.label(params).length > 0);
    assert.ok(operation.summary(params).length > 0);
  }
});

test('model output cannot be laundered through a long paste', () => {
  assert.equal(detect('x'.repeat(2001) + ' create mailbox a@b.com'), null);
  assert.equal(detect(null), null);
  assert.equal(detect({ toString: () => 'create mailbox a@b.com' }), null);
});

// A person writing to an assistant writes sentences, and a sentence ends in a
// full stop. The stop was being read as part of the name, so the catalogue
// refused an identifier the person never typed. Found on a live box.
test('a sentence-ending full stop is not part of the name', () => {
  for (const [text, expected] of [
    ['create a database called invoices.', 'invoices'],
    ['create a database called invoices!', 'invoices'],
    ['create a database user called wp_user.', 'wp_user'],
  ]) {
    const hit = detect(text);
    assert.ok(hit, `nothing staged for: ${text}`);
    assert.equal(hit.input.name || hit.input.username, expected);
  }
});

// Spoken addresses. Whisper writes "at" and "dot", so a voice request used to
// match nothing and come back as directions to a screen.
{
  const spoken = detect('Create a mailbox for info at site1.example.com.');
  assert.ok(spoken, 'a spoken address is understood');
  assert.equal(spoken.input.account, 'info');
  assert.equal(spoken.input.domain, 'site1.example.com');
  const spelled = detect('create a mailbox for sales at example dot com');
  assert.ok(spelled, 'a spelled-out domain is understood');
  assert.equal(spelled.input.domain, 'example.com');
  // "at" that is not an address stays untouched.
  assert.equal(detect('what time does the backup at 3 run'), null, 'an ordinary "at" proposes nothing');
  assert.equal(spokenAddresses('meet me at the office'), 'meet me at the office', 'plain prose is left alone');
  console.log('spoken address checks passed');
}
