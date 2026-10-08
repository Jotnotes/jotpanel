# JotPanel

JotPanel is a server control panel for a VPS or a dedicated Linux machine. It manages the host and the
websites, mail, databases and DNS running on it, from one web interface, and it is free software
under the AGPL.

It is built around one rule: **the panel does not report success for anything it has not read back.**
After every change it asks the machine whether the change is there, and what it tells you is that
answer rather than the answer the operation gave. A green tick over an unchecked write is the one bug
that makes a panel worse than no panel.

That rule has a name: **VACP™**. Every change, whether you click it, ask Echo for it or your own AI
asks for it through MCP, is proposed, approved by a person, executed and then read back. MCP is how
your AI reaches the panel. VACP is what it meets when it gets there, and it is JotPanel's own.

[![Latest release](https://img.shields.io/github/v/release/Jotnotes/jotpanel?label=release&color=2d7d46)](https://github.com/Jotnotes/jotpanel/releases/latest)
[![Licence AGPL v3](https://img.shields.io/badge/licence-AGPL--3.0-blue)](LICENSE)
[![Debian and Ubuntu](https://img.shields.io/badge/runs%20on-Debian%20%7C%20Ubuntu-a81d33)](#what-a-machine-needs)
[![Stars](https://img.shields.io/github/stars/Jotnotes/jotpanel?style=flat&color=f5a623)](https://github.com/Jotnotes/jotpanel/stargazers)

**[jotpanel.jotnotes.com](https://jotpanel.jotnotes.com)** · [Install](#install) · [What it does](#what-it-does) · [Connect your own AI](#connect-your-own-ai) · [For hosting companies](#for-hosting-companies)

### Try it in one line

On a fresh Debian or Ubuntu machine, as root:

```bash
curl -fsSLo jotpanel-install https://github.com/Jotnotes/jotpanel/releases/latest/download/jotpanel-install && sudo bash jotpanel-install --domain panel.example.com --email you@example.com
```

That fetches the current release, checks it against its own published checksum and installs both
halves of the panel. There is no account to make first and nothing to pay, and the whole panel is
yours whether you ever register or not.

---

## What it does

**Sites.** A website, its document root, its PHP version, its aliases and its redirects. Each site
gets its own system user, its own PHP-FPM pool, its own socket and its own `open_basedir`. Password
protection on a directory covers the PHP files inside it, not only the static ones.

**Certificates.** Issue, renew and force HTTPS, with expiry watched for you.

**Mail.** Mailboxes, forwarders, auto-replies, catch-alls, quotas, spam filtering, the queue, and
DKIM, SPF and DMARC set up together rather than left as three separate errands.

**Databases.** MariaDB and PostgreSQL through one set of operations, on the same machine at the same
time if you want both. Users, grants, passwords and imports.

**DNS.** Zones and records, on this machine.

**Backups.** Scheduled or on demand, with offsite destinations, and a restore that lists exactly what
came back. An offsite copy counts as confirmed only when the destination has been asked for its hash.

**Accounts.** Server admin, reseller and end user, all three in the free panel. Packages set what an
account may use, an account cannot raise its own limits, and a parent cannot grant more than it
holds.

**Security.** A firewall with a guard that puts the rules back if a change cuts you off, fail2ban,
SSH keys, passkeys, two-factor codes and recovery codes.

**Moving in and out.** Sites and mail can be migrated from a cPanel archive, mail can be copied over
IMAP where there is no archive, and a whole account leaves as one ZIP whenever you want it to.

Seven runtime choices are supported: Node, Python, Ruby, Java, Perl, .NET and any compiled program,
including Go, Rust and Delphi. Six of the seven have served a real page. Adminer, phpMyAdmin and
WordPress install in one click.

## How a change happens

Every change is proposed, approved and then executed, and all three are recorded. The record says
what was asked for, who approved it, what ran, and what the machine said afterwards. Destructive
operations make the owner type the word.

Underneath, the panel runs as an unprivileged user with no way to become root. Privileged work goes
over a Unix socket to a separate root-owned service, which accepts named jobs from a fixed catalogue
and refuses anything else.

## Verified systems

Installed from a bare machine and driven through the function checks on each of these:

- Ubuntu 22.04, 24.04 and 26.04
- Debian 12 and 13

Ubuntu 24.04 LTS is the tested and supported platform.

## What a machine needs

| You are running | RAM | Disk | CPU |
|---|---|---|---|
| The panel only | 1 GB | 10 GB | 1 core |
| Web hosting, so sites, PHP and databases | 2 GB | 25 GB | 1 core, 2 is better |
| Everything, plus mail, DNS, spam filtering and backups | 4 GB | 40 GB | 2 cores |
| Echo listening and speaking, on top of any of the above | 4 GB | +2 GB | 2 cores |

Voice is optional and installed from inside the panel, never by the installer. It turns speech into text on your own machine, so it needs the room to do it: on a single core the panel falls back to the small speech model, which mishears unusual words like your own hostnames. Two cores and 4 GB is where it becomes pleasant to use.

Swap at least the size of RAM, which the installer creates for you when the machine has none. The
panel itself is about 150 MB across its two services, so what fills a small machine is the stack you
install under it. Measured figures are in [`docs/PANEL_SYSTEM_REQUIREMENTS.md`](docs/PANEL_SYSTEM_REQUIREMENTS.md).

## Install

```bash
sudo bash jotpanel-install --bundle-file ./jotpanel.tar.gz --domain panel.example.com --email owner@example.com
```

The installer prompts for the initial owner password if you do not supply one, and installs both
halves of the panel, because a panel without the privileged service is a panel where the firewall,
packages, mail, databases, sites and certificates all report themselves unavailable.

The panel's name is given with `--domain` at install time, or afterwards from Settings once the name
resolves to the machine. Giving it at install is the better path, because changing it later fetches a
certificate and restarts the panel. Leaving `--domain` off installs on the machine's address with a
certificate it makes itself, which suits a box that has no name yet.
`sudo bash jotpanel-install --help` lists everything. The complete guide, including what the machine
needs and how to check the result, is [`INSTALL.md`](INSTALL.md).

## Getting in

The panel answers on `https://` the name you installed it with. Port 7443 is a recovery surface that
answers directly rather than through the web server, so the panel is still reachable when the web
server is what is broken.

Sign in with the owner email and password, or with the single-use link the installer prints. Passkeys,
time-based codes and recovery codes are all supported and none of them are compulsory. Recovery codes
are shown once and stored hashed.

## Coming soon, and said so on the screen

A capability counts as supported when it has been made to work against the real thing and the result
was read back out of that real thing. Anything that has not met that bar says so where somebody would
rely on it, rather than being quietly present.

- **Migrating in from a cPanel archive** is marked *cPanel · coming soon*. The reader works and every
  step after it has run, but the only archives it has been given were built to the layout it expects.
- **Copying a mailbox in over IMAP** is marked *preview*. Reading a mailbox has been proved and
  writing into one has not.
- **Plesk and DirectAdmin archives are not read at all**, and the panel says so rather than failing
  partway.
- **S3-compatible backup destinations**, meaning S3 itself along with R2, B2, Wasabi and MinIO, are
  listed and disabled. Another server over SFTP is what ships. A destination tested only against a
  stand-in is not one this panel will offer for your backups.

## What it does not have

No vendor login on your machine, no backdoor, no support account. No telemetry and no phone-home. No
update button, because checking for one is a call. The panel installs and runs without registration,
which exists only to connect the optional assistant.

## Documentation

**For the person running a machine**

- [`INSTALL.md`](INSTALL.md): requirements, the install, and checking it
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md): every setting and what it does
- [`docs/UPGRADING.md`](docs/UPGRADING.md): what upgrading is, and what has been proved about it
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md): when something is wrong
- [`docs/guides/`](docs/guides/): the knowledge base, written for people rather than for developers

**For the person changing the code**

- [`CONTRIBUTING.md`](CONTRIBUTING.md): how work is done here, and why each rule exists
- [`SECURITY.md`](SECURITY.md): the security model, and how to report something
- [`CHANGELOG.md`](CHANGELOG.md): what changed in each release

## Free, and what is not

**The panel is free and nothing in it is gated.** Every licence check in the code is on an assistant
route, the panel says so itself, and it was proved by suspending, revoking and banning a real key and
then using the panel each time. Server admin, reseller and end user are all in the free panel.

Registration is free. It switches on Echo, the built-in assistant, which answers with the AI key you add
in Settings; the key stays on your server. A
panel that never registers is a complete panel, and your own AI can still connect through the MCP
gateway.

## For hosting companies

If you run JotPanel on machines you sell to other people, there is a hoster licence. It is the only
thing in this project that costs money and it buys the reseller and customer chain rather than any
part of the panel itself: one allocation you hold, keys you issue to your own customers, seats you
can split and hand on, and a portal where you manage all of it.

It is billed monthly on the number of servers you run it on, at **$15 a server for one to four, $10
for five to nineteen and $7 beyond twenty**, and you can cancel it yourself at any time. Cancelling
keeps your service to the date you have already paid for rather than cutting it off on the day you
ask.

**[Buy a hoster licence](https://license.jotnotes.com/checkout)** · [Manage a licence you already
have](https://license.jotnotes.com/portal) · [What you get, in full](https://jotpanel.jotnotes.com)

If your company needs an invoice rather than a card, write to jot@jotnotes.com with the number of
servers and we will send one.

## Connect your own AI

Already using Claude Code, Cursor or Codex? Create an API key in the panel and connect it through the
MCP gateway in [`app/mcp-gateway`](app/mcp-gateway/README.md). Your AI can read the machine and ask for
changes. VACP holds every one of them: nothing changes until a person approves it in the panel, and
the panel reads the result back. Every other panel lets your AI call tools. JotPanel lets your AI ask.

## Licence

VACP™ is a trademark of JotNotes, which coined the name for this approval loop. The code is free
software; the name is not part of the licence.


GNU Affero General Public License, version 3 or later. See [`LICENSE`](LICENSE) for the terms.
