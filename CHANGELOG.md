# Changelog

## v1.0.0

The first public release of JotPanel, the free server control panel.

## What it is

JotPanel is a server control panel for a VPS or a dedicated Linux machine. It manages the host and the websites, mail, databases and DNS running on it, from one web interface. It is free software under the AGPL.

It is built around one rule: the panel does not report success for anything it has not read back. After every change it asks the machine whether the change is there, and what it tells you is that answer rather than the answer the operation gave.

## What's in it

### Hosting panel

- **Sites.** A website, its document root, its PHP version, its aliases and its redirects. Each site gets its own system user, its own PHP-FPM pool, its own socket and its own `open_basedir`. Password protection on a directory covers the PHP files inside it, not only the static ones.
- **Certificates.** Issue, renew and force HTTPS, with expiry watched for you.
- **Mail.** Mailboxes, forwarders, auto-replies, catch-alls, quotas, spam filtering, the queue, and DKIM, SPF and DMARC set up together.
- **Databases.** MariaDB and PostgreSQL through one set of operations, on the same machine at the same time if you want both. Users, grants, passwords and imports.
- **DNS.** Zones and records, on this machine.
- **Backups.** Scheduled or on demand, with offsite destinations, and a restore that lists exactly what came back. An offsite copy counts as confirmed only when the destination has been asked for its hash.
- **Accounts.** Server admin, reseller and end user, all three in the free panel. Packages set what an account may use, an account cannot raise its own limits, and a parent cannot grant more than it holds.
- **Moving in and out.** Sites and mail can be migrated from a cPanel archive, mail can be copied over IMAP where there is no archive, and a whole account leaves as one ZIP whenever you want it to.
- Seven runtime choices: Node, Python, Ruby, Java, Perl, .NET and any compiled program, including Go, Rust and Delphi. Six of the seven have served a real page. Adminer, phpMyAdmin and WordPress install in one click.

### VACP, Echo and your own AI

- **VACP™**, JotPanel's approval loop: every change, from a click, from Echo or from your own AI through MCP, is proposed, approved by a person, executed and read back. An AI can ask; only a person approves.

- Every change is proposed, approved and then executed, and all three are recorded. The record says what was asked for, who approved it, what ran, and what the machine said afterwards.
- Destructive operations make the owner type the word.
- **Ask Echo**, the built-in assistant, at the top of the panel. It answers with your own Anthropic or OpenAI key, kept in the server's encrypted vault and never sent to JotNotes. Free registration switches it on. A request for a change comes back as a proposal that waits for you in Activity.
- A destructive-sounding request gets a question, not an answer. A correction is recorded and drafts the change for approval.
- Rules can be drafted in the panel and put in force only with a person's approval, bound to the exact content they saw.
- Build goals show the proposed steps, label rough plans, and wait for separate Approve and Run button presses.
- A run that dies is taken over at the next start. Its in-flight call is marked interrupted and never re-sent, and the step it was on starts again with a fresh brief and says it resumed.
- The routing record lists the kind of work, the model, why, how the request was read, what was sent by field name and size, time and failed checks. Never the words.
- Routing learns. Work a model gets accepted counts for it; answers rejected by review, and answers a person corrects, count against it for that kind of work.

### Bring your own AI and the MCP gateway

- Bring your own AI keys. Keys go straight to the encrypted vault through `/api/ai/keys` and are listed by fingerprint. The browser keeps only which providers are connected.
- Keys an older panel left behind in browser storage are moved to the vault on first use and wiped from the browser.
- Only the brief leaves the box. Specialist work gets a brief written from the ledger: the project, the rules in force, open requirements, the assistant's previous reply and the current request. Secrets are removed by value, and a last check refuses to send anything still holding a secret.
- Models on the box or on the person's own device still get the whole conversation, since it doesn't leave their machines.
- **Connect your AI**: make a scoped key in the panel, and the MCP gateway connects Claude Code, Cursor, Codex or any MCP client with it. It can read and propose, never approve. It needs no registration and is Apache 2.0.

### Security

- The panel runs as an unprivileged user with no way to become root. Privileged work goes over a Unix socket to a separate root-owned service, which accepts named jobs from a fixed catalogue and refuses anything else.
- A firewall with a guard that puts the rules back if a change cuts you off, fail2ban, SSH keys, passkeys, two-factor codes and recovery codes.
- No vendor login on your machine, no backdoor, no support account. No telemetry and no phone-home. No update button, because checking for one is a call.
- The panel installs and runs without registration. Registration is free and only connects Echo.
- Every licence check in the code is on an assistant route, and it was proved by suspending, revoking and banning a real key and then using the panel each time.

## Install

On a fresh Ubuntu 24.04 server, as root, with the panel's name already pointing at the machine:

```bash
curl -fsSLo jotpanel-install https://github.com/Jotnotes/jotpanel/releases/download/v1.0.0/jotpanel-install && sudo bash jotpanel-install --domain panel.example.com --email you@example.com
```

The installer downloads this release, checks it against its published SHA-256, and installs both
halves of the panel. It asks for the owner password if you do not give one. Leave `--domain` off to
install on the machine's address with a certificate it makes itself. `sudo bash jotpanel-install --help`
lists everything, and [`INSTALL.md`](INSTALL.md) is the full guide.

Tested from a bare machine on Ubuntu 22.04, 24.04 and 26.04 and Debian 12 and 13. Ubuntu 24.04 LTS is
the supported platform.

## Known limits

- **The key vault's encryption secret sits in `/opt/jotpanel/.env` on the same machine.** A copied database file is useless on its own, but anyone with root on the machine can decrypt the stored AI keys. See [`SECURITY.md`](SECURITY.md).
- **Migrating in from a cPanel archive** is marked *cPanel · coming soon*. The reader works and every step after it has run, but the only archives it has been given were built to the layout it expects.
- **Copying a mailbox in over IMAP** is marked *preview*. Reading a mailbox has been proved and writing into one has not.
- **Plesk and DirectAdmin archives are not read at all**, and the panel says so rather than failing partway.
- **S3-compatible backup destinations**, meaning S3 itself along with R2, B2, Wasabi and MinIO, are listed and disabled. Another server over SFTP is what ships. A destination tested only against a stand-in is not one this panel will offer for your backups.
- **Drafted rule patterns are rough.** They did not catch SERIAL in testing, so check them before approving.
- A capability counts as supported when it has been made to work against the real thing and the result was read back out of that real thing. Anything that has not met that bar says so where somebody would rely on it, rather than being quietly present.

## Licence

The panel is free software under the GNU Affero General Public License, version 3 or later. The MCP
gateway in `app/mcp-gateway` is Apache 2.0. Nothing in the panel is gated: server admin, reseller and
end user are all included.
