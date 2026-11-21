# Changelog

## v1.0.3

**A security update. Everyone running JotPanel v1.0.2 or earlier should upgrade.** Nothing else changed in this release: it is v1.0.2 with one file corrected (`control/ops/privilegedJobs.js`) and a test added.

## What was wrong

The database import ran an uploaded SQL file as the MariaDB `root` account, with the command-line client's own commands switched on. Anyone who could import into a database on your panel (an account holder importing into their own database, or anyone you had approved to do so) could, with a crafted file:

- read or change every other database on the server, and create themselves a database administrator account, because the file ran with full server privileges; and
- run commands on the server as root, through the client's own `system`, `source`, `tee` and `pager` lines, which the client obeys before the server sees them.

PostgreSQL imports had the same second problem: the file ran as the `postgres` superuser through `psql`, whose own `\!` and `COPY ... TO PROGRAM` run commands.

If you are the only person who can sign in to your panel and you only import files you wrote or trust, you were not exposed to a second party, but you should still upgrade. We know of no case of this being used against a JotPanel install.

## What changed

- A MariaDB import now runs as a temporary account that has privileges on that one database and nothing else, locked whenever no import is running, limited to two connections and a statement time (default 300 seconds, `JOTPANEL_IMPORT_MAX_STATEMENT_SECONDS` to change it).
- The client runs with `--binary-mode`, which switches off `system`, `source`, `tee` and `pager` for piped input and keeps `DELIMITER`, so an ordinary dump with routines, views, triggers and events still imports.
- **Loading a SQL file into a PostgreSQL database through the panel is no longer offered.** The panel says so in plain words. Dump and restore the panel itself makes are unchanged. Use `psql` on the server if you need to load data into PostgreSQL.

## How it was checked

Against real MariaDB 10.11 and PostgreSQL 16 on a test machine: each attack above is run through the panel's own import job and the machine is asked whether anything happened. 29 checks pass, including that an ordinary dump still imports and that a statement running past the limit is stopped by the server. This release was not put through a fresh-server install; the only code change is the one file, and the installer and upgrader are unchanged from v1.0.2.

## How to upgrade

Follow `docs/UPGRADING.md` with the v1.0.3 bundle and its checksum from the release page. The upgrade is transactional and keeps the previous release at `/opt/jotpanel/app.previous`.

To report a problem: `security@jotnotes.com`.

## v1.0.2

JotPanel ships as JotPanel. This release is about the boundary between this panel and the other
product built from the same source, and about two things a person could not do.

## The boundary

The customer bundle is now panel-only, and a test says so rather than a habit.
`app/deploy/BUNDLE_EXCLUDE.panel.txt` names, with reasons, the fourteen files that belong to the
other product — the machine adapters, the fleet collector and its enrollment, the activation route
and the per-guest console — and removes them after staging and before the allowlist gate, so the
gate is unchanged and still fail-closed. A path named there that the bundle does not have fails the
build, which is what stops a rename from quietly shipping something again.

**The panel could not have started with those files simply removed**, and that was measured rather
than reasoned about: their `require`s were eager and top-level, and only the services they build
were gated. They are now loaded through `optionalModule`, which returns nothing when a module is
absent from this product and still throws when a module is genuinely missing from a broken install,
so a half-built server is not mistaken for a working one. The routes that depended on them answer
plainly instead of failing: `/api/activation/state` says *"This product does not activate"*.

## A password a person can change

There was no way for a signed-in person to change their own password. There is now:
`POST /api/me/password`, and a form on **Account → Sign-in security**, above passkeys.

It takes no account id of any kind, which is the structural answer to the route that was removed
from here for overwriting any account's password without authority. The current password is proved
in the same request with the sign-in path's own comparison; the floor is the twelve characters the
installer and `account.create` already apply, not the eight that the closed public-registration path
still names; the hash is bcrypt at the same cost as every other password write. A second factor, if
there is one, is required as well, and is left enrolled afterwards, because a password change must
not quietly lower what protects the account.

**What it does not do, said plainly:** other sessions are not signed out. A session here is a signed
token with no server-side record, so there is nothing to revoke without changing the middleware that
account recovery, the recovery ceremony and the second factor all share. The person who changed the
password gets a new token, and the panel tells them in words that their other sessions last until
they expire. Account recovery is untouched.

## The tests a customer receives

`npm test` on an installed panel used to run a suite written for an earlier product. It expected
public sign-ups, which a real install closes, so it failed twenty-four of forty-five checks on a
perfectly healthy machine. `npm test` is now six JotPanel suites that need no server, no network and
no credentials, and they pass inside the bundle. The old file is still in the repository, wired to
nothing, and `CONTRIBUTING.md` says what it was for.

## Also

- The loopback bootstrap surface had no language middleware, so every refusal and every missing
  field on it answered with a stack trace instead of the sentence the handler wrote — seven paths,
  including the ones an operator meets by running the installer twice. One shared middleware, now
  used by both surfaces. The three calls the installer makes were on the success paths and were
  never broken; what was broken was being told why anything had failed.
