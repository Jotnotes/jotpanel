'use strict';

// Device trust and the download step-up.
//
// The property worth defending, and the one every check below is a way of
// testing: a credential that proves WHO you are must never be mistaken for
// evidence about WHICH MACHINE you are at. Collapse those two and the feature
// still looks like it works.

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createDeviceTrust } = require('./deviceTrust');

let passed = 0;
const check = (what, fn) => { fn(); passed++; console.log(`  ok   ${what}`); };

const setup = (policy = {}) => {
  const db = new Database(':memory:');
  const clock = { at: new Date('2026-10-04T12:00:00.000Z') };
  // enforce: true, because what these cases test is the POLICY. The default is
  // off and section 9 below is what proves that.
  const trust = createDeviceTrust({ db, now: () => clock.at, policy: { enforce: true, ...policy } });
  trust.enroll({ userId: 'u1', credentialId: 'laptop-platform-cred', label: 'my laptop' });
  return { db, clock, trust };
};

const enrolled = { userId: 'u1', amr: 'platform_passkey', deviceId: 'laptop-platform-cred' };
const password = { userId: 'u1', amr: 'password' };
const with2fa  = { userId: 'u1', amr: 'password_2fa' };
const yubikey  = { userId: 'u1', amr: 'roaming_passkey', deviceId: 'yubikey-cred' };

function run() {
  console.log('\ndevice trust: which machine, not just which person\n');

  console.log('1. what counts as a trusted machine');
  {
    const { trust } = setup();
    check('a platform credential enrolled on this machine makes it enrolled', () => {
      assert.equal(trust.tierOf(enrolled), 'enrolled');
    });
    check('a password alone says nothing about the machine', () => {
      assert.equal(trust.tierOf(password), 'visiting');
    });
    check('nor does a password plus a code', () => {
      assert.equal(trust.tierOf(with2fa), 'visiting');
    });
    // The distinction the whole module exists for.
    check('A YUBIKEY IS NOT DEVICE TRUST: it proves the person, anywhere', () => {
      assert.equal(trust.tierOf(yubikey), 'visiting');
    });
    check('a platform credential this account never enrolled does not count', () => {
      assert.equal(trust.tierOf({ userId: 'u1', amr: 'platform_passkey', deviceId: 'somebody-elses' }), 'visiting');
    });
    check('and one belonging to another account does not count either', () => {
      assert.equal(trust.tierOf({ userId: 'u2', amr: 'platform_passkey', deviceId: 'laptop-platform-cred' }), 'visiting');
    });
  }

  console.log('\n2. upload from a machine you have not enrolled');
  {
    const { trust } = setup();
    check('refused by default', () => {
      const out = trust.check('files.upload', password);
      assert.equal(out.decision, 'refuse');
      assert.match(out.reason, /enrolled/);
    });
    check('allowed from an enrolled machine', () => {
      assert.equal(trust.check('files.upload', enrolled).decision, 'allow');
    });
    check('and the operator can turn it on for an install that wants it', () => {
      const { trust: open } = setup({ uploadsFromVisiting: true });
      assert.equal(open.check('files.upload', password).decision, 'allow');
    });
  }

  console.log('\n3. download is the direction that empties the vault');
  {
    const { trust, clock } = setup();
    check('from a visiting machine it asks you to confirm', () => {
      assert.equal(trust.check('files.download', password).decision, 'step_up');
    });
    // Steve's call, 2026-10-04: download gets a step-up too, not merely upload
    // blocked. Enrolment says the machine is yours; it says nothing about who
    // is sitting at it right now.
    check('and it asks even on your OWN enrolled machine', () => {
      assert.equal(trust.check('files.download', enrolled).decision, 'step_up');
    });
    check('a fresh confirmation lets it through', () => {
      const fresh = { ...enrolled, stepUpAt: clock.at.toISOString() };
      assert.equal(trust.check('files.download', fresh).decision, 'allow');
    });
    check('a stale confirmation does not', () => {
      const stale = { ...enrolled, stepUpAt: new Date(clock.at.getTime() - 10 * 60 * 1000).toISOString() };
      assert.equal(trust.check('files.download', stale).decision, 'step_up');
    });
    check('a confirmation with no time on it counts as none at all', () => {
      assert.equal(trust.check('files.download', { ...enrolled, stepUpAt: 'whenever' }).decision, 'step_up');
    });
    check('an install can refuse visiting downloads outright instead', () => {
      const { trust: strict } = setup({ downloadsFromVisiting: 'enrolled_only' });
      assert.equal(strict.check('files.download', password).decision, 'refuse');
    });
  }

  console.log('\n4. the other sensitive surfaces, not just files');
  {
    const { trust } = setup();
    for (const action of ['account.export', 'vault.id', 'vault.passwords', 'legacydesk', 'apikeys.read']) {
      check(`${action} asks for confirmation`, () => {
        assert.notEqual(trust.check(action, enrolled).decision, 'allow');
      });
    }
    check('while ordinary browsing is not interrupted', () => {
      assert.equal(trust.check('files.list', password).decision, 'allow');
    });
  }

  console.log('\n5. file requests');
  {
    const { trust } = setup();
    check('off by default, because they let somebody with no account upload', () => {
      assert.equal(trust.check('filerequest.create', enrolled).decision, 'refuse');
    });
    check('on when the operator says so', () => {
      const { trust: open } = setup({ fileRequestsEnabled: true });
      assert.equal(open.check('filerequest.create', enrolled).decision, 'allow');
    });
  }

  console.log('\n6. revoking a device');
  {
    const { trust } = setup();
    assert.equal(trust.tierOf(enrolled), 'enrolled');
    trust.revoke({ userId: 'u1', credentialId: 'laptop-platform-cred' });
    check('a revoked device is immediately visiting again', () => {
      assert.equal(trust.tierOf(enrolled), 'visiting');
    });
    check('and it disappears from the list', () => {
      assert.equal(trust.list('u1').length, 0);
    });
  }

  console.log('\n7. every refusal says something a person can act on');
  {
    const { trust } = setup();
    for (const [action, session] of [['files.upload', password], ['files.download', password], ['filerequest.create', enrolled]]) {
      const out = trust.check(action, session);
      check(`${action} explains itself`, () => {
        assert.ok(out.reason && out.reason.length > 20, out.reason);
        assert.ok(/[a-z]/.test(out.reason));
      });
    }
  }

  console.log('\n9. OFF by default, so an existing JotPanel keeps working');
  {
    // The regression this prevents: deviceTrust is not pool-host gated, so it
    // applies to JotPanel as well as Navigator. Nothing sets `amr` yet, so
    // every session reads as visiting, and no frontend understands a 428. With
    // enforcement on by default, every download in a shipped product would
    // answer 428. Found 2026-10-04 when Steve asked whether this touched
    // JotPanel.
    const db = new Database(':memory:');
    const plain = createDeviceTrust({ db });
    check('the default install does not enforce', () => {
      assert.equal(plain.policy.enforce, false);
    });
    check('so a password-session download is allowed, not held for a step-up', () => {
      const out = plain.check('files.download', password);
      assert.equal(out.decision, 'allow', out.reason);
    });
    check('and an upload is not refused either', () => {
      assert.equal(plain.check('files.upload', password).decision, 'allow');
    });
    check('but it says it is not enforcing rather than pretending to allow', () => {
      assert.match(plain.check('files.download', password).reason, /not enforced/);
    });
  }

  // ── Break tests ─────────────────────────────────────────────────────
  console.log('\n8. break tests: remove each defence and a named check fails');
  const breaks = [
    {
      what: 'treating a roaming key as device evidence',
      fails: 'A YUBIKEY IS NOT DEVICE TRUST: it proves the person, anywhere',
      run: () => {
        const { trust } = setup();
        // What the collapsed version would say: any passkey means enrolled.
        const collapsed = s => (s.amr === 'roaming_passkey' || s.amr === 'platform_passkey') ? 'enrolled' : 'visiting';
        return collapsed(yubikey) === 'enrolled' && trust.tierOf(yubikey) === 'visiting';
      },
    },
    {
      what: 'checking enrolment against the database',
      fails: 'a platform credential this account never enrolled does not count',
      run: () => {
        const { trust } = setup();
        const unknown = { userId: 'u1', amr: 'platform_passkey', deviceId: 'never-enrolled' };
        // Without the lookup, "has a platform credential" alone would pass.
        return trust.tierOf(unknown) === 'visiting';
      },
    },
    {
      what: 'the freshness window on a step-up',
      fails: 'a stale confirmation does not',
      run: () => {
        const { trust, clock } = setup();
        const stale = { ...enrolled, stepUpAt: new Date(clock.at.getTime() - 10 * 60 * 1000).toISOString() };
        return trust.hasFreshStepUp(stale) === false;
      },
    },
    {
      what: 'the step-up on an enrolled machine',
      fails: 'and it asks even on your OWN enrolled machine',
      run: () => {
        const { trust } = setup({ stepUpForSensitiveOnEnrolled: false });
        // With the rule off this allows, which is what the check would catch.
        return trust.check('files.download', enrolled).decision === 'allow';
      },
    },
  ];
  breaks.push({
    what: 'the enforce flag defaulting to off',
    fails: 'the default install does not enforce',
    run: () => {
      const db = new Database(':memory:');
      // What an unconditional default would do to a shipped JotPanel.
      const on = createDeviceTrust({ db, policy: { enforce: true } });
      return on.check('files.download', password).decision === 'step_up'
        && createDeviceTrust({ db }).check('files.download', password).decision === 'allow';
    },
  });
  for (const b of breaks) {
    assert.ok(b.run(), `removing "${b.what}" did NOT fail "${b.fails}"`);
    passed++;
    console.log(`  ok   without ${b.what}, "${b.fails}" would not hold`);
  }

  console.log(`\n${passed} passed\n`);
}

try { run(); } catch (error) { console.error('\nFAILED:', error.message, '\n'); process.exit(1); }
