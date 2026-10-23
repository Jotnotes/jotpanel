# Installing the services your machine runs

JotPanel is the control panel. The services it manages — a database, PHP, a mail server, DNS, spam
filtering, webmail — are separate, and they are installed when somebody asks for them.

Two ways to ask. One is in every published release. The other arrives with the next one.

---

## What the installer always puts down

Whatever else you choose, a new machine gets the panel, a **web server (nginx)**, a **certificate
client (certbot)**, a firewall and Node. That is why no profile below lists the web server: it is
already there.

A panel installed with nothing else is about 150 MB. The services are the rest of the machine, and
spam filtering alone is 150 to 300 MB, which is why a 1 GB box cannot carry everything.

---

## Adding one service at a time — available now

**This works in the published release.** In the panel, under **Server operations**, each missing
service is a single action you approve. The panel proposes it, you read the proposal, you approve,
it runs, and the panel reads the machine back afterwards to confirm the service is really there.

These are the services you can install this way, with the wording you will see on screen:

| On screen | What it is |
|---|---|
| Install MariaDB on this server | the default database |
| Install PostgreSQL on this server | PostgreSQL, instead of or beside MariaDB |
| Install nginx on this server | the web server, if it is ever missing |
| Install certbot on this server | the certificate client |
| Install PHP on this server | PHP for websites that need it |
| Install Postfix and Dovecot on this server | the mail server |
| Install Roundcube on this server | webmail in a browser |
| Install BIND on this server | DNS served from this machine |
| Install OpenDKIM on this server | signing outbound mail |
| Install rspamd spam filtering on this server | spam filtering |
| Install fail2ban on this server | brute-force protection |

Each one is a fixed, named job. You never type a package name and the panel never takes one: the
only thing it accepts is which service from this list, which is why a proposal cannot be turned into
an arbitrary command on your machine.

Install what you will actually use. Adding the rest later is this same screen, and nothing has to be
reinstalled to make room for it.

---

---

## Keeping those services patched

The services above are distribution packages, so they are patched the way the distribution patches
them. Under **Firewall & updates** the panel reads what is waiting and offers *"Install the waiting
security updates"*, which you approve by typing `UPDATE`. Afterwards the panel reads the machine
again rather than assuming the update worked.

Two things to know, because they are easy to get wrong.

**A package that looks unpatched may not be.** Ubuntu backports security fixes and leaves the
upstream version number alone. A fully patched PHP on Ubuntu 24.04 still reports `8.3.6`, while
upstream's fixed release for the October 2026 PHP flaws is `8.3.36`. Comparing those two numbers tells
you that a patched machine is vulnerable, which is wrong. What matters on Ubuntu is the full package
version and which pocket it came from, which is what the panel shows you.

**"Nothing waiting" is not the same as "that CVE is fixed."** The panel can tell you, accurately,
what your machine says is outstanding and when it last looked. It has no vulnerability feed, so it
cannot and does not tell you that a particular CVE is closed. A machine can have nothing waiting and
still be behind, if its package lists are stale, if a package is held, or if the archive has not
published the fix yet. To settle a named CVE, read the vendor's advisory for your release — for the
October 2026 PHP flaws on Ubuntu 24.04 that is **USN-8948-1**, which gives the fixed version as
`8.3.6-0ubuntu0.24.04.13` — and compare it with what is installed.

**Restart the workers afterwards.** Updating the PHP packages does not replace the PHP-FPM processes
already running. The panel lists the FPM unit for each version it finds, so restarting it is one more
action you approve.

---

## Related

- [The first hour](HOST_the-first-hour.md) — what to do on a new machine
- [How a change happens](HOST_how-a-change-happens.md) — the propose, approve, read-back loop
- [Keeping the machine healthy](HOST_keeping-the-machine-healthy.md)
