# The first hour

The panel is installed and you are signed in as the owner. This is what to do before you put anything
real on the machine, in the order that costs least if you stop halfway.

---

## 1. Change the password, or better, add a passkey

If you signed in with the link the installer printed, you have no password yet. Set one, and then add
a passkey from the same screen. A passkey is the one credential that cannot be phished off you and
cannot be read out of a stolen database.

Print the recovery codes and put them somewhere that is not this machine. They are shown once. The
panel keeps only a hash of them, which is why nobody, including you, can read them back later.

## 2. Give the panel its name, if it does not have one

If you installed without a domain, the panel is answering on the machine's address with a certificate
it made itself, and your browser is complaining.

**Give the name at install if you can, and from Settings if you cannot.** Installing with `--domain`,
with the name already resolving to this machine, is the better path and the one that is proved: it
skips the restart. Settings now has a screen for it afterwards, which fetches a certificate and
restarts the panel, so whoever is signed in is signed out for a moment. Installing on an address is
fine for a machine that does not have a name yet.

Do not edit the configuration file by hand instead. That changes one of the three things and leaves
the machine disagreeing with itself.

## 3. Look at the firewall before you touch it

The installer opened 80, 443 and 22 and closed everything else, which is the right answer for almost
every machine.

If you are going to change it, arm the guard first. Arming copies the current rules aside, and the
machine puts them back after five minutes unless you confirm from a still-working connection that you
can still reach it. Arm one guard at a time. A second guard armed on top of the first is how a
snapshot gets lost.

## 4. Set up backups, and send them somewhere else

A backup that lives on the machine is not a backup. It is a copy of your data on the disk that is
going to fail.

Add an offsite destination, then take one backup by hand and watch it complete. Two things to check
on the result: that the copy was confirmed rather than merely sent, which means the destination was
asked for its hash and agreed, and what the retention setting is. A destination with a keep ceiling
drops the oldest copy when it makes a new one, and a full quota stops new copies rather than making
room.

Then set the schedule. [Backups](HOST_backups.md) has the rest.

## 5. Install only the stack you need

The panel lays down almost nothing on its own: a web server, a certificate client, a firewall and
Node. Everything else, so PHP, MariaDB, PostgreSQL, mail, spam filtering and DNS, arrives when you
ask for it.

That matters on a small machine, because the panel is about 150 MB and the stack is the rest. Spam
filtering alone is 150 to 300 MB. Install what you are actually going to use, and add the rest later
when you need it.

## 6. Make your first account, not your first website

Resist putting a site on the owner account. The owner runs the machine, and the account that runs the
machine should not also be the account that owns a customer's website.

Define a package first, which is what an account is allowed to use, then take on an account and put
it on that package. [Accounts, packages and limits](HOST_accounts-packages-and-limits.md).

## 7. Read the Approval desk once

Everything you did in the last hour is on it, with what was proposed, what ran and what the machine
said afterwards. Reading it once now is how you learn to read it later, when something has gone wrong
and you need to know what happened rather than what was supposed to happen.
