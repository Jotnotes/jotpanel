import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directoryName = path.dirname(fileURLToPath(import.meta.url));

function checks(source) {
  assert.match(source, /onClick=\{\(\) => approveRule\(rule\)\}/,
    'a waiting rule is approved only from its visible button');
  assert.match(source, /onClick=\{approvePlan\}/,
    'a plan is approved only from its visible button');
  assert.match(source, /body: JSON\.stringify\(\{ seenHash: rule\.hash \}\)/,
    'rule approval sends the hash on the rule being displayed');
  assert.match(source, /body: JSON\.stringify\(\{ seenHash: plan\.plan\.hash \}\)/,
    'plan approval sends the hash on the plan being displayed');
  assert.match(source, /plan\.run\?\.state !== "running"[\s\S]*?\}, 3000\);/,
    'a running plan is polled every three seconds');
  assert.match(source, /plan\.plan\.rough[\s\S]*?t\("ROUGH"\)/,
    'rough plans are visibly labelled');
  assert.match(source, /step\.blockedReason[\s\S]*?step\.blockedReason/,
    'the reason for a blocked step is shown');
  assert.match(source, /step\.resumedAt[\s\S]*?t\("Resumed"\)/,
    'a resumed step is shown as resumed');
}

const sourceFile = path.join(directoryName, 'control-panel.jsx');
const source = fs.readFileSync(sourceFile, 'utf8');
checks(source);

const mutants = [
  ['waiting rule button', 'onClick={() => approveRule(rule)}', 'onClick={() => {}}'],
  ['plan approval button', 'onClick={approvePlan}', 'onClick={() => {}}'],
  ['rule content hash', 'body: JSON.stringify({ seenHash: rule.hash })', 'body: JSON.stringify({})'],
  ['plan content hash', 'body: JSON.stringify({ seenHash: plan.plan.hash })', 'body: JSON.stringify({})'],
  ['three-second running poll', '}, 3000);', '}, 9000);'],
  ['rough label', '{t("ROUGH")}', '{t("PLAN")}'],
  ['blocked reason', '{step.blockedReason}</div>', '{t("Unknown")}</div>'],
  ['resumed marker', '{t("Resumed")}</div>', '{t("Continued")}</div>'],
];

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-projects-mutants-'));
try {
  for (const [index, [name, find, replacement]] of mutants.entries()) {
    assert.equal(source.split(find).length - 1, 1, `${name}: mutation target must be unique`);
    const file = path.join(directory, `mutant-${index}.jsx`);
    fs.writeFileSync(file, source.replace(find, replacement));
    let outcome = 'STILL PASSES';
    try { checks(fs.readFileSync(file, 'utf8')); }
    catch (error) { outcome = error instanceof assert.AssertionError ? 'CAUGHT' : `CRASHED (${error.message})`; }
    assert.equal(outcome, 'CAUGHT', `${name}: removing the defence must fail with an AssertionError`);
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('Resident projects checks passed (buttons, exact hashes, polling, rough, blocked and resumed; 8 defences caught when removed)');
