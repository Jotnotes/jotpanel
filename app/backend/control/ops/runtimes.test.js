'use strict';

// Runtimes beyond PHP, tested where the danger actually is.
//
// The mechanism is one long-running process per site behind the reverse proxy
// that already exists, so the interesting parts are not "does Node run" but the
// two places customer input touches something that parses: the name of the file
// to start, which becomes a word inside a systemd unit, and the generated
// virtual host, which decides whether the program's own source is served to
// anybody who guesses the file name.

const assert = require('assert/strict');
const { renderSite, runtimeEntry, RUNTIMES } = require('./privilegedJobs');
const { getOperation } = require('./catalogue');

function siteWith(extra) {
  return { domain: 'example.com', aliases: [], document_root: 'public', user: 'site_example', php: null, ...extra };
}

function testTheStartingFileCannotBecomeAUnitDirective() {
  // A Linux file name may legally contain a newline. This one is about to be
  // written into a systemd unit, where a newline followed by User=root is a
  // root escalation inside a unit describing somebody's own application.
  assert.throws(() => runtimeEntry('app.js\nUser=root', RUNTIMES.node), /letters, digits/);
  assert.throws(() => runtimeEntry('app.js\n[Service]\nExecStartPre=/bin/sh', RUNTIMES.node), /letters, digits/);
  // Quotes and spaces would break out of the quoting in ExecStart.
  assert.throws(() => runtimeEntry('my app.js', RUNTIMES.node), /letters, digits/);
  assert.throws(() => runtimeEntry('app".js', RUNTIMES.node), /letters, digits/);
  assert.throws(() => runtimeEntry('app$(id).js', RUNTIMES.node), /letters, digits/);
  // And it is still a path inside the site.
  assert.throws(() => runtimeEntry('../../etc/passwd', RUNTIMES.node), /letters, digits|inside the site/);
  assert.throws(() => runtimeEntry('/etc/shadow', RUNTIMES.node), /ending \.js/);
}

function testAnOrdinaryStartingFileIsAccepted() {
  assert.equal(runtimeEntry('server.js', RUNTIMES.node), 'server.js');
  assert.equal(runtimeEntry('dist/main.mjs', RUNTIMES.node), 'dist/main.mjs');
  assert.equal(runtimeEntry('/app.py', RUNTIMES.python), 'app.py');
  assert.equal(runtimeEntry('build/app.jar', RUNTIMES.java), 'build/app.jar');
  // A compiled program has no extension to check, because Go and Rust produce
  // a file with no extension at all and that is the normal case for it.
  assert.equal(runtimeEntry('app', RUNTIMES.binary), 'app');
}

function testARuntimeCannotBePointedAtTheWrongKindOfFile() {
  // Pointing java at a shell script is how a runtime becomes a way to run a
  // command, so each language only starts from a file it could plausibly run.
  assert.throws(() => runtimeEntry('start.sh', RUNTIMES.java), /ending \.jar/);
  assert.throws(() => runtimeEntry('app.py', RUNTIMES.node), /ending \.js/);
  assert.throws(() => runtimeEntry('server.js', RUNTIMES.python), /ending \.py/);
}

function testEveryLanguageIsRunnableTheSameWay() {
  // The shape is the point. Adding a language is a row, and a row that does not
  // look like the others is a second mechanism nobody will maintain.
  for (const [id, spec] of Object.entries(RUNTIMES)) {
    assert.ok(spec.label, `${id} has no label`);
    assert.equal(typeof spec.args, 'function', `${id} does not say how it is started`);
    assert.ok(Array.isArray(spec.packages), `${id} does not say what it needs installed`);
    assert.ok(spec.example, `${id} does not say what a starting file looks like`);
    // Either an interpreter from a closed list of absolute paths, or nothing at
    // all because the program is its own runtime. Never a name to be searched
    // for on a path the customer could influence.
    if (spec.bin) assert.ok(spec.bin.every(candidate => candidate.startsWith('/')), `${id} names an interpreter by something other than an absolute path`);
  }
  assert.deepEqual(Object.keys(RUNTIMES).sort(), ['binary', 'dotnet', 'java', 'node', 'perl', 'python', 'ruby']);
}

function testAnApplicationSiteDoesNotServeItsOwnSource() {
  // The failure that turns a language runtime into a source-code leak: nginx
  // serving the document root alongside the proxy, so server.js and .env go to
  // anybody who guesses the name.
  const config = renderSite(siteWith({ runtime: { id: 'node', entry: 'server.js', port: 21000, unit: 'arca-app-example.com.service' } }));
  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:21000;/);
  assert.doesNotMatch(config, /try_files/);
  assert.doesNotMatch(config, /index index\.html/);
  // The proxy tells the application who asked, which it cannot otherwise know
  // from behind a reverse proxy, and leaves the certificate challenge reachable
  // so a certificate can still be issued while the application is serving.
  assert.match(config, /X-Forwarded-For \$proxy_add_x_forwarded_for/);
  assert.match(config, /X-Forwarded-Proto \$scheme/);
  assert.match(config, /acme-challenge/);
}

function testAPlainSiteIsUnchangedByAnyOfThis() {
  // The other half of the same question: a site with no application still gets
  // exactly the virtual host it got before, or this shipped a regression to
  // every existing site to add a feature none of them use.
  const config = renderSite(siteWith({}));
  assert.match(config, /try_files/);
  assert.doesNotMatch(config, /proxy_pass/);

  const php = renderSite(siteWith({ php: '8.3' }));
  assert.match(php, /fastcgi_pass/);
  assert.doesNotMatch(php, /proxy_pass/);
}

function testStoppingAnApplicationIsTypedNotClicked() {
  const clear = getOperation('runtime.clear');
  assert.equal(clear.confirm, 'STOP');
  // Because it takes the site off the thing that is serving it, and the summary
  // has to say that rather than imply a tidy-up.
  assert.match(clear.summary({ domain: 'example.com' }), /stops answering/);

  const set = getOperation('runtime.set');
  assert.match(set.summary({ domain: 'example.com', runtime: 'node', entry: 'server.js' }), /Whatever is serving example\.com now stops/);
}

function run() {
  const tests = [
    testTheStartingFileCannotBecomeAUnitDirective,
    testAnOrdinaryStartingFileIsAccepted,
    testARuntimeCannotBePointedAtTheWrongKindOfFile,
    testEveryLanguageIsRunnableTheSameWay,
    testAnApplicationSiteDoesNotServeItsOwnSource,
    testAPlainSiteIsUnchangedByAnyOfThis,
    testStoppingAnApplicationIsTypedNotClicked,
  ];
  for (const test of tests) { test(); console.log(`  \x1b[32m✓\x1b[0m ${test.name.replace(/^test/, '')}`); }
  console.log(`runtime tests passed (${tests.length})`);
}

run();
