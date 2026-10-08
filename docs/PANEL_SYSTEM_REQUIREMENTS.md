# System requirements — the free panel

**Canonical for what a machine needs to run JotPanel.** Written 2026-08-27. Navigator is the
other product from this tree and has its own page, `NAVIGATOR_SYSTEM_REQUIREMENTS.md`; the floors
the installer enforces are shared, because it is one installer. This is the
source for the knowledge base article and the website copy, so it is written to be readable by
somebody choosing a VPS rather than by somebody reading code.

Two rules it follows, because a requirements page that gets either wrong costs support tickets.

**A minimum is not one number, it is a number per job.** A box running the panel and nothing else and
a box running the panel plus mail plus databases plus DNS are different machines. Publishing a single
figure means either turning away people the product would have served, or letting people install onto
a box that will fall over in week three. Both are worse than three honest rows.

**Measured is marked, estimated is marked.** The panel's own figures below were measured on this
build. The third-party services the panel can install are marked as typical idle footprints, because
they have not been measured on a live JotPanel box yet. Section 7 says what would settle that.

---

## 1. The short version, for the website

| You are running | RAM | Disk | CPU |
|---|---|---|---|
| **The panel only** — trying it out, or running it beside services you manage elsewhere | **1 GB** | 10 GB | 1 core |
| **Web hosting** — websites, PHP and databases | **2 GB** | 25 GB | 1 core, 2 better |
| **Everything** — the above plus mail, DNS, spam filtering and backups | **4 GB** | 40 GB | 2 cores |

**Swap: at least as much as RAM, on every one of these.** It is not optional on the smaller two, and
section 4 says why.

Anything 64-bit with systemd. Ubuntu 24.04 LTS is the tested and supported platform today; see
section 6 for everything else and its honest status.

---

## 2. What the panel itself costs

Measured on this build, 2026-08-27, production mode, panel shell, no assistant:

| Process | Resident memory | What it is |
|---|---|---|
| `jotpanel.service` | **80 MB** | the panel, its API and its database |
| `jotpanel-ops.service` | **~45 MB** | the privileged half; a bare Node process is 45 MB and this one is a socket listener that shells out |
| nginx | 10 to 20 MB | typical |
| **Panel total** | **≈ 150 MB** | |

Plus the operating system. A minimal Ubuntu 24.04 server idles at roughly 150 to 250 MB, so a box
that has installed JotPanel and nothing else sits near **400 MB**.

On disk the panel is small: the release bundle is 617 KB, its dependencies are 48 MB, and Node
itself is the largest single item. The installer requires 4 GB free, which is about the install and
not about hosting anything.

**So the panel is not what fills a small machine.** Everything in the next section is.

## 3. What fills the machine is the stack, not the panel

The installer lays down very little: nginx, certbot, ufw and Node. Every other service arrives only
when somebody asks for it, from the catalogue in `privilegedJobs.js`. That is why the panel-only row
above is genuinely 1 GB, and why the other two rows exist.

Typical idle footprints, **estimated rather than measured on an JotPanel box**:

| Stack | Installed when you want | Typical idle |
|---|---|---|
| `php` | to serve PHP sites | 30 to 60 MB per worker |
| `database` (MariaDB) | databases | 150 to 400 MB, mostly the InnoDB buffer pool, and tunable |
| `postgres` | PostgreSQL instead of or beside MariaDB | 100 to 200 MB |
| `mail` (Postfix, Dovecot) | mailboxes | 50 to 80 MB together |
| `antispam` (rspamd, Redis) | spam filtering | **150 to 300 MB, the largest single item** |
| `dns` (BIND9) | writing DNS records rather than only reading them | 30 to 50 MB |
| `fail2ban` | brute-force protection | 30 to 50 MB |
| `dkim` (OpenDKIM) | signing outbound mail | 10 to 20 MB |
| `webmail` (Roundcube) | webmail | PHP-FPM, as above |

Add the mail row, the antispam row and a database to a 1 GB box and it is full before a single
visitor arrives. That is the whole reason the tiers exist, and it is also why DirectAdmin publishes
4 GB: their installer puts the lot on by default, and ours does not.

## 4. Swap, which matters more than the RAM number

**Have swap at least equal to RAM.** On a small box this is the difference between a slow minute and
a service disappearing.

Without swap, a memory spike does not slow the machine down, it makes the kernel choose a process to
kill, and it chooses the largest. That is usually MariaDB, or the panel. The failure then looks like
JotPanel crashing at random, when what actually happened is that a backup and a PHP request wanted memory
at the same moment on a box with no give in it.

**The installer handles this for you since 2026-08-27, proved on a real machine on 2026-08-28.** It reads the machine's swap along with its
memory, and where there is none it makes a swap file matching RAM, capped at 4 GB, then verifies it
is actually active before writing anything to `/etc/fstab`.

It declines to touch the machine, and says so rather than failing quietly, in every case where making
swap would be presumptuous or unsafe: a container, where swap belongs to the host; btrfs, ZFS or
anything else that wants its swap file made its own way; a filesystem type it could not read; a disk
without room to spare the file while keeping the install's 4 GB free; and a `/swapfile` that already
exists, which is never overwritten. An administrator who manages swap themselves passes `--no-swap`.

Existing swap is left alone. If it is under half of RAM the installer points that out and still does
not touch it.

**A swap file that cannot be made is a warning and never a refusal.** The install continues, and
anything half-made is removed rather than left behind.

If you would rather do it yourself before installing:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 5. Where the numbers come from, against the market

For anyone asking why ours is lower than the panel they last used.

| Panel | Published minimum RAM | Note |
|---|---|---|
| **JotPanel (panel only)** | **1 GB** | measured at ~150 MB for the panel itself |
| HestiaCP | 1 GB | and it reaches 1 GB by leaving ClamAV and SpamAssassin out |
| Plesk Obsidian | 1 GB + 1 GB swap | |
| CyberPanel | 2 GB realistically | Python and Django with several daemons |
| DirectAdmin | 4 GB, plus 4 GB swap | their own forums report it running in 512 MB to 1 GB |
| cPanel and WHM | no current published figure; the heaviest in practice | 500 to 800 MB at rest with its services |

We are lower than DirectAdmin for a reason worth saying out loud in the copy: the panel installs
almost nothing by default and adds services only when asked, so a box only carries what its owner
actually uses.

## 6. Operating systems

**Supported and proved: Ubuntu 24.04 LTS, 64-bit.** That is the machine everything in this product
has been proved on, including a clean install from the release installer on a machine that had never
seen the code.

**Expected to work and not yet proved: other apt-based systems**, meaning Debian 12 and later Ubuntu
LTS releases. The installer's apt path is shared, and the PHP stack deliberately uses unversioned
package names so it pulls whatever that distribution's current PHP is.

**Designed for and not built: RHEL, Rocky, Alma, Fedora, SUSE, Arch, Alpine, FreeBSD and OpenBSD.**
The translation layer that makes this possible is described in `PANEL_OS_SUPPORT.md` and the matrix
script exists at `scripts/matrix.sh`, which has not been run against this build.

**Requires systemd**, checked by the installer, which is why Alpine and the BSDs are a real port
rather than a package list.

Do not publish a distro list wider than this one. "Runs on all major Linux distributions" is the goal
and is not yet a fact, and a control panel that fails to install is the one thing this market
remembers.

## 7. What would make section 3 measured rather than estimated

One pass on a live box, worth doing before this reaches the website. Install each stack in turn on a
throwaway VPS, record resident memory after ten idle minutes, then again under a small load, and
replace the estimated column with real figures. The panel already has the readings to do it: the
operator's health screen reports the machine's own memory and the accounts screen reports per-account
storage. Two hours, one destroyed VPS, and the requirements page stops containing anything that was
reasoned rather than seen.

## 8. What the installer enforces, and what it says

**Done 2026-08-27.** The preflight and this page now agree, and there is a test that fails if they
stop agreeing.

A cloud instance sold as 1 GB reports about 955 MB, so a floor of 1024 turned away exactly the
machines the 1 GB row describes. Each floor is now the sold size less about five per cent: **950,
1950 and 3900 MB**. A machine below the first is refused with all three published tiers in the
refusal, so somebody on a 512 MB box is told what to buy rather than only what is wrong.

A machine that passes is told which tier it is in, in the same words as section 1. A 1 GB box is told
it is enough for the panel itself and that hosting wants 2 GB and mail wants 4 GB. A 2 GB box is told
it is enough for websites, PHP and databases and that mail wants 4 GB. A 4 GB box is told it is
enough for the full stack.

**Proved by `scripts/test-preflight.sh`**, 34 checks, which sources the installer in library mode so
it runs the real functions rather than a copy that can drift from them. It covers the three tiers at
the figures those machines actually report, both sides of the floor, the machine the old 1024 floor
refused, every reason not to make swap, and the rollback when making it fails. Two mutations were
tried against it to confirm it bites: restoring the 1024 floor fails five checks, and letting swap
provisioning overwrite an existing file fails one.

**And proved on a real machine, 2026-08-28.** A Vultr 1 GB VPS reporting 955 MB, Ubuntu 24.04, built
for the test and destroyed afterwards. It was accepted, told which tier it was in, given a 955 MB
swap file at mode 600 that `mkswap` and `swapon` both accepted and the kernel reported, persisted to
fstab, unchanged and automatically active after a reboot, and left entirely alone when the installer
ran again. Evidence in `PANEL_PREFLIGHT_VERIFICATION.md`.

Worth knowing for the copy: **a stock Vultr Ubuntu 24.04 image already ships 2.3 GB of swap**, so on
that provider the creation branch never fires and the existing swap is simply left alone. The
creation path is for the images that ship without any, which several providers do.
