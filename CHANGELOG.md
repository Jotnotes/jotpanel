# Changelog

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
