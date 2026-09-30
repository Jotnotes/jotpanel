# Websites and certificates

---

## What a website is here

Creating a website makes more than a folder. It gets its own system user, its own PHP-FPM pool, its
own socket and its own `open_basedir`, so one site cannot read another site's files even though they
sit on the same machine.

That is the difference between a panel that separates accounts and one that only appears to. It also
means a site is a real thing you can point at from outside the panel, and removing one removes all of
it rather than leaving a user behind.

## PHP and other runtimes

Set the PHP version per site. Changing it swaps the pool the site runs in.

Seven runtime choices are supported: Node, Python, Ruby, Java, Perl, .NET and any compiled program,
which covers Go, Rust and Delphi. Six of the seven have served a real page. A runtime is installed,
set on a site, restarted and cleared as four separate operations, so a broken deployment is one
restart away from being back rather than a reinstall.

## Aliases and redirects

An alias serves the same site under another name. A redirect sends one name to another. Both are
operations, so both are recorded, and both are read back off the web server configuration afterwards
rather than assumed.

## Password protecting a directory

Protection covers the PHP files inside the directory, not only the static ones. Several panels get
this wrong and leave `admin.php` reachable inside a protected `/admin`. Set it, then check it from a
browser that is not signed in.

## One-click applications

Adminer, phpMyAdmin and WordPress install onto a site in one operation.

## Certificates

Issue, renew and force HTTPS. Expiry is watched and the panel tells you before it matters.

Three things cause almost every failed issue, and they look identical from inside the panel:

**The name does not resolve to this machine yet.** Check from off the machine, not from the machine,
because a local answer proves nothing about what the certificate authority sees.

**Port 80 is closed.** The challenge uses port 80 even though the certificate is for 443.

**You are rate limited.** The authority limits repeated requests for the same name. If you have been
reinstalling onto the same hostname, that is what this is. Use the staging authority while you work,
and switch back when the machine is real. A staging certificate is not trusted by browsers, which is
the point of it.

**Never test a certificate against the panel's own hostname.** Reissuing for the name your web server
is serving the panel on has taken the web server down here before. Use a second name.

## Files

Upload, write, rename, move, archive, extract, create folders and delete, with the same propose and
approve loop as everything else, and with one property that is not obvious from the outside: **file
operations do not follow symlinks out of the site.** A link pointing inside the site works. A link
pointing out of it is refused, and the message says so. That is the escalation that has bitten other
panels, and it is tested here on purpose.

SFTP is enabled and disabled per site, so a developer gets access for a week and loses it again
without anybody rebuilding an account.
