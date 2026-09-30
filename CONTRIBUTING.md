# Contributing

The rules here are not style preferences. Each one is in this file because breaking it cost a day.

---

## The rule everything else follows from

**Do not report success for something you have not read back.** After a write, ask the machine
whether the change is there, and read the answer out of the thing underneath rather than out of the
response the operation gave you. A green tick over an unchecked write is the one bug that makes this
panel worse than no panel.

It also holds in reverse. **A red mark over an operation that worked is the same failure wearing the
other face**, and it is more expensive, because somebody then goes looking for a defect that is not
there.

## Built is not proved

A feature is two lines: what is built, and what is proved. Never collapse them.

- **Built** means the code exists and its unit tests pass. Say "built, unit tested, not run on a
  machine" and stop there.
- **Proved** means it ran against a live machine, the failure path was caused rather than simulated,
  and the outcome was read back out of the machine.

**A build that cannot be made to fail on purpose has not been built.** If there is no way to make an
operation fail, there is no evidence the check that would have caught the failure is even running.

A committed document is not progress. A design doc, a spec, a plan and a prompt are all paperwork,
because four confident commits about a feature read exactly like the feature.

## Working on the control path

`app/backend/control/` and `app/backend/control/ops/` are the path from a request to a change on the
machine. `docs/RULES_FOR_ANY_ASSISTANT.md` is required reading before touching it.

- A new capability is a new row in `control/ops/catalogue.js`, not a new mechanism. Propose, approve
  and execute are already built and are not re-implemented per feature.
- Parameters are cleaned by the row that declares them. Nothing reaches a command line unchecked.
- Risk levels mean something. `destructive` makes the owner type a word, and choosing a gentler level
  to avoid the prompt is a defect.
- The privileged service takes named jobs and nothing else. If a change needs it to take a command,
  the change is wrong.

## Testing

```bash
cd app/backend && npm run test:unit   # the offline suite, and it runs the two frontend suites too
cd app/frontend && npm test           # the frontend suites on their own
```

`npm test` in `app/backend` is a different thing: it drives every endpoint against a server that is
already running, so start one first or it fails for the wrong reason.

Against a machine, and only ever on the machine:

```bash
scripts/regression-remote.sh start  --host <box>
scripts/regression-remote.sh watch  --host <box>
scripts/regression-remote.sh fetch  --host <box>
```

The run lives on the machine under test as a transient systemd unit, not on your laptop. That is not
a preference. Two runs here survived a laptop going to sleep mid-run, and one survived an operating
system update.

Every suite ends in one of PASS, FAIL, INFRA_ERROR, BLOCKED or NOT_RUN. **Only FAIL is a product
failure.** Presenting any of the other four as one is how a clean run gets reported as a broken
product.

**A box that has had ten runs against it is not a clean box.** Never diagnose from an old machine.
Two suites failed here purely because a backup quota was exhausted and a retention ceiling had been
reached, and both passed first time on a fresh machine.

## Commits

- One item per commit, with a changelog entry in the same commit.
- **Product fixes and test-harness fixes go in separate commits.** That rule caught two mistakes in a
  single session: both times, what looked like a product failure was our own test being wrong.
- The changelog entry says what was wrong and what it cost, not just what changed.

## Prose

Plain English. No coder speak in anything a user reads, no invented jargon, and no em dashes. Short
sentences where the meaning is exact, longer ones where it is an explanation. If a message tells
somebody something failed, it says what to do next.

## Licence

Contributions are under AGPL-3.0-or-later, the same licence as the project.
