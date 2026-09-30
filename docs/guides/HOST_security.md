# Security

What the panel protects, what it hands to you, and the two mistakes that lock people out of their own
machines.

---

## The shape of it

The panel cannot become root. It runs unprivileged, and every privileged operation is a named job
sent over a socket to a separate root-owned service that accepts jobs from a fixed list and refuses
anything else. There is no shell in that path. A new capability is a new entry on the list, not a new
way in.

Every change is proposed, approved and recorded, with the name of whoever approved it, whether it
worked or not.

## The firewall

The installer opened 80, 443 and 22 and closed everything else.

**Arm the guard before a risky change.** Arming copies the current rules aside and has the machine
put them back after five minutes unless you confirm, from a connection that still works, that you can
still reach the machine. If a change does lock you out and the guard was armed, do nothing and wait.
The machine undoes it for you.

Arm one guard at a time. A second guard armed over the first is how the snapshot of the original
rules gets lost.

## Blocked addresses

fail2ban watches for repeated failures and blocks the source. The panel can unban an address, which
is the operation you want at eleven at night when a customer has locked themselves out of SFTP.

## Signing in

Passkeys, time-based codes and recovery codes are all here. Use a passkey for the owner account. It
is the one credential that cannot be phished and cannot be read out of a stolen database.

Recovery codes are shown once and stored hashed. Print them, keep them off this machine.

One thing worth knowing if you test your own deployment: a 429 from the rate limiter is the doorman,
not the door. It is never evidence that a permission check refused somebody, because a completely
broken permission check would also produce it.

## SSH keys

Added and removed as operations, so the record shows who added a key and when. Turning off password
authentication on SSH entirely is yours to do on the machine, and it is worth doing.

## Updates

The panel can install the waiting security updates. On a machine with none waiting it says so, which
reads as a red row and is an answer rather than a failure. Some updates want a reboot afterwards and
the panel does not decide that for you.

## What is not the panel's to protect

**Your provider's console.** It reaches underneath everything on this page, and it is also the way
back in when the machine will not answer at all. Protect it like the root account it effectively is.

**Your own laptop.** A panel with perfect authorization is one stolen session away from being
somebody else's panel.

**The backups.** Anywhere a backup lands is somewhere your customers' data lives. A destination with
weak credentials is a copy of everything, sitting somewhere you are not watching.
