# Installing JotPanel

This is the complete install guide for the free panel. It covers what the machine needs, what the
installer does to it, how to check the result, and how to remove it again. If you want the one
command and nothing else, it is in section 3.

Everything here describes `app/deploy/install.sh`, which is the only supported way in. A panel put
together by hand is not the same product, because half of what the installer does is the privileged
service, the socket between the two halves and the firewall around them.

---

## 1. What the machine needs

A 64-bit Linux box with systemd, and root on it. Ubuntu 24.04 LTS is the tested and supported
platform. Ubuntu 22.04 and 26.04 and Debian 12 and 13 have each been installed from bare metal and
driven through the function checks by `scripts/matrix.sh`.

Size the box for the job you are giving it, not for the panel. The panel itself is about 150 MB of
resident memory across its two services. What fills a small machine is the stack you install
underneath it.

| You are running | RAM | Disk | CPU |
|---|---|---|---|
| The panel only | 1 GB | 10 GB | 1 core |
| Web hosting, so sites, PHP and databases | 2 GB | 25 GB | 1 core, 2 is better |
| Everything, so the above plus mail, DNS, spam filtering and backups | 4 GB | 40 GB | 2 cores |
| Echo listening and speaking, on top of any of the above | 4 GB | +2 GB | 2 cores |

Voice is optional and is installed from inside the panel, never by the installer. Speech becomes text on your own machine, so it needs the room to do it: on a single core the panel falls back to the small speech model, which mishears unusual words like your own hostnames. Two cores and 4 GB is where it becomes pleasant to use.

Swap at least the size of RAM on every one of those. The installer creates it for you when the
machine has none, up to 4 GB, and `--no-swap` turns that off. Without swap a memory spike ends with
the kernel killing the largest process on the box rather than the machine slowing down for a moment.

The installer requires 4 GB free disk before it starts. That figure is about installing, not about
hosting anything.

`docs/PANEL_SYSTEM_REQUIREMENTS.md` has the measured numbers behind this table and the per-stack
footprints.

## 2. Before you run it

**Point the name at the machine first.** Create an A record for the panel's hostname, for example
`panel.example.com`, and let it resolve before you install. The installer asks a certificate
authority for a certificate during the run, and that request fails if the name does not answer.

**Giving the panel its name is an install-time decision.** Pass `--domain`, with the name already
resolving to this machine. **There is no screen anywhere in the panel for changing it afterwards.**
The operation exists in the machinery and nothing draws it, so plan the name before you install
rather than expecting to attach one later.

**You can still install without a name**, and it is the right answer for a machine that has an
address before it has a hostname, or for an image in a provider's marketplace. Leave `--domain` off
and the panel answers on the address with a certificate it makes itself. From
`scripts/install-on-box.sh` the same thing is `--no-domain`, which it requires rather than assumes,
so a missing flag is never read as a decision. Your browser will warn about that certificate, and the
installer prints its fingerprint at the end so you can check you are looking at the right machine
before you click through.

**Ports.** The installer opens 80, 443 and 22, and closes everything else. Port 7443 is the recovery
surface, which answers directly rather than through nginx so you can still reach the panel when
nginx is the thing that is broken. If you install the local engine it listens on 11434 and the
firewall blocks it from outside.

**Have the release bundle ready.** There is no downloads host, so you either build the bundle with
`scripts/build-customer-bundle.sh` and copy it over, or use `scripts/install-on-box.sh` from a
checkout, which builds it locally and hands it to the machine for you.

## 3. The command

With the bundle already on the machine:

```bash
sudo bash jotpanel-install --bundle-file ./jotpanel.tar.gz --domain panel.example.com --email owner@example.com
```

From a checkout on your own laptop, against a machine you can reach by SSH:

```bash
scripts/install-on-box.sh --host 192.0.2.10 --domain panel.example.com --email owner@example.com
```

The installer prompts for the initial owner password when you do not supply one, and refuses
anything shorter than 12 characters. In
`--non-interactive` mode it generates one instead and hands you a single-use sign-in link, so a
provisioning system never has to invent a password.

### Options

| Option | What it does |
|---|---|
| `--domain NAME` | DNS name for the panel. Leave it off to install on the machine's address. The built-in help still calls it required, which is now out of date. |
| `--email ADDRESS` | Owner login and the address the certificate authority is given. Required. |
| `--password VALUE` | Initial owner password. Prompted for when omitted. |
| `--bundle-file PATH` | Release bundle already on this machine. |
| `--bundle-url URL` | Release bundle to fetch. |
| `--bundle-sha256 HASH` | Expected checksum. Otherwise `URL.sha256` is used. |
| `--install-dir PATH` | Install location. Default `/opt/jotpanel`. |
| `--cert-staging` | Issue from the Let's Encrypt staging authority. Untrusted by browsers, and the right choice when you are installing onto the same name repeatedly, because the real authority rate-limits that. |
| `--with-resident` | Install a local AI model for Echo (needs about 8 GB of memory), bound to loopback only. |
| `--no-swap` | Do not create a swap file. Read section 1 before using it. |
| `--non-interactive` | Refuse missing values instead of prompting, and generate the password. |
| `--license-key VALUE` | Licence key, written to the install config. |
| `--json PATH` | Write a machine-readable result, including the single-use sign-in link, for a provisioning system to read. Written 0600. |
| `--help` | The complete list. |

## 4. What the installer actually does

It installs two services, not one, and it treats both as part of a successful install.

- **`jotpanel.service`** is the panel, its API and its database. It runs as an unprivileged user and has
  no way to become root.
- **`jotpanel-ops.service`** is the privileged half. It is root-owned, reachable only over a Unix socket,
  and it accepts named jobs from a fixed catalogue and nothing else.

A panel installed without the privileged service is a panel where the firewall, packages, mail,
databases, sites and certificates all report themselves unavailable. That is why the installer
verifies the socket before it calls the install finished.

Around those it lays down nginx, certbot, ufw and Node, and nothing else. Every other service, so
PHP, MariaDB, PostgreSQL, Postfix, Dovecot, rspamd, BIND and the rest, arrives only when somebody
asks for it from inside the panel.

The owner account is created at the end over a loopback surface on port 9998 that refuses once any
account exists. Creating the second account is `account.create` inside the panel, which puts it under
a provider and inside a package.

Nothing registers, phones home or contacts JotNotes. Registration is offered in the Registration screen later.
It is free and only switches on Echo, which then answers with the AI key you add in Settings.

## 5. Checking the install

The installer writes `/opt/jotpanel/install-report.txt`, readable by root and the `jotpanel` group. It
records the bundle checksum, the Node version, whether HTTPS verified, whether the privileged socket
answered and is reachable by the panel user, the firewall and log probes, and whether the password
was supplied or generated.

By hand, on the machine:

```bash
systemctl status jotpanel jotpanel-ops
curl -fsS https://panel.example.com/health
journalctl -u jotpanel -n 50 --no-pager
```

Two things worth reading rather than glancing at. `NRestarts=0` on both units means neither service
has fallen over since it started, which is the number that matters on a fresh install. And the panel
answering on the address is not the same as the certificate being trusted, so open it in a browser
once.

## 6. First sign-in

Open `https://panel.example.com`. Sign in with the owner email and the password you supplied, or with
the single-use link the installer printed, which works once and expires in an hour.

What to do in the first hour is `docs/guides/HOST_the-first-hour.md`.

## 7. Upgrading

`docs/UPGRADING.md`.

## 8. Removing it

Stop and disable both services, then remove the install directory, the nginx site and the systemd
units:

```bash
sudo systemctl disable --now jotpanel jotpanel-ops
sudo rm -rf /opt/jotpanel
sudo rm -f /etc/systemd/system/jotpanel.service /etc/systemd/system/jotpanel-ops.service
sudo rm -f /etc/nginx/sites-enabled/jotpanel /etc/nginx/sites-available/jotpanel
sudo systemctl daemon-reload && sudo systemctl reload nginx
```

That removes the panel and everything it stored, including its database, its uploads and its record
of every action ever approved on the machine. Take a backup and move it off the box first if any of
that matters.

It does not remove the services the panel installed for you. Websites, databases, mailboxes and DNS
zones are not the panel's to delete, and they are all still there and still running after the panel
is gone.
