# Host admin: connecting a control panel

For the hosting company operating a deployment. Your customers never see any of this.

---

## What this does

The assistant can run a hosting account by being talked to. "Create a mailbox for sales",
"add this DNS record", "why did the SSL fail". Every one of those is proposed first, approved by a
human, then executed against your panel, with a record written either way.

It reaches your panel through an adapter. Which adapter runs is decided by your environment at
boot, and nothing in the product changes when you swap one for another.

## The three states

| State | When | What your customers get |
|---|---|---|
| **Mock** | Default, nothing configured | Everything works and nothing is real. Correct for trials and demos. |
| **Hestia** | `HESTIA_*` set | Reads against your live panel. Writes off unless you turn them on. |
| **cPanel** | `CPANEL_WHM_*` set | Built, never validated against a live box. Wins if both are set. |

## Connecting HestiaCP

In Hestia, enable the API and generate an access key pair. Then set these on the box running
JotNotes and restart it:

```bash
HESTIA_HOST=panel.yourcompany.com
HESTIA_PORT=8083
HESTIA_ACCESS_KEY=...
HESTIA_SECRET_KEY=...
```

An API hash works instead of the key pair (`HESTIA_API_HASH`), and so does a username and password
(`HESTIA_USER`, `HESTIA_PASSWORD`), though the key pair is the one to use. If your panel presents a
self-signed certificate, add `HESTIA_TLS_INSECURE=1`, and understand that you are turning off
certificate checking when you do.

## Confirming it worked

Read the log on startup. This is the only reliable confirmation, because an unconfigured or
half-configured adapter falls back to the mock silently rather than failing:

```bash
journalctl -u jotnotes | grep provisioning
```

A connected panel says so and names the host. If you see nothing, the mock is running and your
customers are talking to a simulation.

## Writes are off, and leave them off at first

Reads are safe. Writes are not yet, and the reason is specific rather than cautious boilerplate.
Hestia's API takes POSITIONAL arguments, so the order is the entire contract, and none of the
command signatures in this adapter have been confirmed against a live Hestia box. A wrong argument
order on a write does not error. It silently creates the wrong object, which means a mailbox whose
password ends up in the username field, and you find out from the customer.

Before enabling writes, run each write command once against a scratch account on a real box and
check what was actually created. Then:

```bash
HESTIA_ALLOW_WRITES=1
```

The startup log tells you which mode you are in and says plainly when writes are enabled on
unverified signatures.

## cPanel

The adapter exists and is wired dormant. It has never run against a live WHM, and it honestly
cannot express an FTP source-IP allowlist, which cPanel has no native concept of. Treat it as
unbuilt until somebody validates it against a real box. If both panels are configured, cPanel is
chosen.

## Known limits, so they do not surprise you

**One panel per deployment.** The adapter is chosen from environment variables at boot, so every
customer on a deployment shares the same panel. If your customers each need their own panel
attached, that is a different build and it does not exist yet: the credentials would have to move
out of the environment and into per-account encrypted storage, the way mail and deploy credentials
already work.

**Restart to change it.** Adapter selection happens once at boot.

**An open question worth raising with your vendor.** Two design documents disagree about whether a
licensed deployment ever contacts the vendor. One promises no phone-home at all and sells that as
a feature, the other plans periodic licence checks with a grace window. Ask which one your contract
is on, because the answer decides whether your box needs outbound access to a vendor endpoint.
