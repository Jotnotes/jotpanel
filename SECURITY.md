# Security

How JotPanel is built to contain a mistake, what it deliberately does not have, and how to report
something you have found.

Reports go to `security@jotnotes.com`, which forwards to a monitored mailbox. Confirmed answering
2026-08-30.

---

## Reporting a vulnerability

Write to `security@jotnotes.com` with enough detail to reproduce it. Please do not open a public
issue for anything that exposes a machine, an account or a tenant boundary until it is fixed.

You will get an acknowledgement, and then either a fix or an explanation of why the behaviour is
intended. Where a report leads to a change, the changelog entry says what was wrong, because a
changelog that only records features teaches people to skip it.

## The shape of the thing

**The panel cannot become root.** It runs as an unprivileged user. Every privileged operation is a
named job sent over a Unix socket to a separate root-owned service, `jotpanel-ops`, which accepts jobs
from a fixed catalogue and refuses anything else. The catalogue is a file, `control/ops/catalogue.js`,
and a new capability is a new row in it rather than a new mechanism. There is no shell escape in that
path because there is no shell in it: the panel names a job and hands it parameters that are cleaned
against the job's own rules first.

**Every change is proposed, approved and then executed, and all three are recorded.** The record says
what was asked for, who approved it, what ran, and what the machine said when it was asked afterwards
whether the change was there. A destructive operation asks the owner to type the word.

**The panel does not report success for anything it has not read back.** That is the rule the product
is built on. A green tick over an unchecked write is the one bug that makes a panel worse than no
panel.

**Each website is its own system user**, with its own PHP-FPM pool, its own socket and its own
`open_basedir`. Password protection on a directory covers the PHP files inside it and not just the
static ones, which is a place other panels have leaked.

**File operations do not follow symlinks.** A security review in August 2026 found cPanel's symlink
escalation living here, where `chown` and `chmod` followed a link out of the account. Ownership and
mode changes use `lchown` and `O_NOFOLLOW` now. The same review found two passwords being passed in
a way that put them in the process list, where any user on the machine can read them, and both were
moved.

**Credentials are encrypted at rest**, including backup destinations, under a secret generated on
your machine at install. There is no vendor copy of it. Lose it and nothing encrypted with it comes
back, which is the honest cost of nobody else holding it.

**The firewall has a guard.** Arm it before a rule that could cut you off, and the machine puts the
old rules back after a few minutes unless you confirm from a still-working connection that you can
still reach it.

**Your own AI keys go into a vault on the server, never the browser.** A key is written once and
never shown again: the panel answers with a fingerprint, not even the last few characters. Saving and
removing keys has its own budget per person, failed attempts included, and every save, removal and
refusal is recorded without any part of the key. Removing or replacing a key destroys its encrypted
copy rather than just marking it.

**Known limit of that vault.** The keys are encrypted with a secret held in `/opt/jotpanel/.env`, on
the same machine as the database. That protects a copied database file or a stray database export. It
does not protect against someone who has root on the machine, or who can read that file: they can
decrypt every stored key. If that matters to you, keep provider keys with spending limits set at the
provider, and remove them from the panel when you stop using them.

## Signing in

Passkeys, time-based codes and recovery codes are all supported. Recovery codes are shown once and
stored hashed, so a stolen database does not hand somebody the way back in.

Rate limiting sits in front of sign-in. One thing worth knowing if you are testing your own
deployment: a 429 from the rate limiter is the doorman, not the door. It is never evidence that an
authorization control refused you, and treating it as such would pass a test that a completely broken
control would also pass.

## What JotPanel deliberately does not have

- **No vendor login on your machine.** The vendor's control is the licence and the update channel.
  There is no support account, no backdoor and no break-glass.
- **No telemetry and no phone-home.** The panel installs and runs without registration, and does not
  check for updates, because checking is a call.
- **No update button**, for the same reason. You upgrade when you decide to.
- **No agent that runs model output.** Where the assistant is enabled, model endpoints are chosen by
  the host, a bring-your-own key is a key and nothing more, and raw model output never drives
  execution. It proposes, a person approves, and the executor only accepts named jobs from the
  catalogue.

## What is yours to get right

The panel manages the machine, and there is a great deal it cannot manage for you.

- **The operating system's own updates.** The panel can install waiting security updates and will
  tell you when there are none, but it does not decide when to reboot your machine.
- **SSH.** Key access, and turning password authentication off, is yours.
- **Your provider's console.** It reaches the machine below anything the panel can protect, and it is
  the way back in when the machine will not answer. Protect it accordingly.
- **Backups that leave the box.** A backup on the machine is not a backup. Configure a destination,
  and check that the copy was confirmed rather than merely sent.

## Licence

JotPanel is AGPL-3.0-or-later and comes with no warranty. Read `LICENSE`.
