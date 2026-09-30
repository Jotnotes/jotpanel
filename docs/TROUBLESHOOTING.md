# When something is wrong

Ordered by how often it happens, and each one says how to tell it apart from the thing next to it
that looks identical from outside.

---

## The panel does not answer at all

```bash
systemctl status jotpanel jotpanel-ops nginx
journalctl -u jotpanel -n 100 --no-pager
curl -fsS http://127.0.0.1:9999/health
```

Work from the inside out. If `127.0.0.1:9999` answers and the public address does not, the panel is
fine and nginx or the certificate is not. If it does not answer, the panel is the problem and the
journal says why in the first screen.

**When nginx is what is broken, the panel is still reachable.** Port 7443 is the recovery surface and
it answers directly rather than through nginx. That is what it is for.

## A change I approved did not happen

Open the Approval desk and read the row. Every operation records what was proposed, who approved it,
what ran and what the machine said afterwards, whether it worked or not.

**A red row is not always a defect.** The panel refusing a firewall rule that would have locked you
out of the box, or refusing a tool the machine has nothing to run it with, is the product working.
Read the message on the row before treating it as a bug. Applying security updates on a machine that
has none waiting is the most common example: it reports nothing to do, which is an answer and not a
failure.

## The panel says an operation is unavailable

Almost always the privileged service. The panel runs unprivileged and reaches root only through a
Unix socket to `jotpanel-ops`, so when that service is down or the socket is unreachable, the firewall,
packages, mail, databases, sites and certificates all report themselves unavailable together. One
unavailable thing is a missing stack; everything unavailable at once is the socket.

```bash
systemctl status jotpanel-ops
sudo -u jotpanel test -w /run/jotpanel-ops/ops.sock && echo reachable
```

The other cause is that the stack is genuinely not installed. Mail operations need Postfix and
Dovecot on the machine, database operations need MariaDB or PostgreSQL, and the panel installs none
of them until somebody asks.

## A certificate did not issue

The name has to resolve to this machine before the authority will issue for it, and the authority
rate-limits repeated attempts against the same name. Both failures look the same from the panel.

- Check the name answers with this machine's address, from off the machine.
- Check port 80 is open. The challenge uses it even though the result is for 443.
- If you have been installing onto the same name repeatedly, you are rate-limited, and
  `--cert-staging` is how to keep working while that clears.

**Never point a certificate test at the panel's own hostname.** Reissuing for the name nginx is
serving the panel on has taken the web server down here before, which is why the test harness
refuses to do it.

## Mail is not being delivered

In this order, because each one is cheaper to check than the next.

1. The queue, in the panel. A queue that is growing is a delivery problem, an empty queue with no
   arrivals is an acceptance problem, and they have nothing to do with each other.
2. DKIM, SPF and DMARC. The panel sets these up and can tell you what it published. Mail from a
   domain with no SPF record and no DKIM signature is filed as spam by the large providers as a
   matter of policy, and nothing on your machine is wrong.
3. The receiving side. Whether a message was accepted is on your machine and is knowable. What the
   recipient's provider then did with it is not.

## A backup did not restore

Look at the manifest first. Every backup carries a description of what is in it and a digest, and
the restore lists exactly what came back, so a restore that returns less than the manifest promised
is visible rather than silent.

**An offsite copy is only confirmed when the destination has been asked for its hash.** A copy that
was sent and never confirmed is a copy that might be there.

Retention is the most common surprise. A destination with a `keep` ceiling drops the oldest copy
when it makes a new one, and a quota that is full stops new copies rather than making room by
deleting old ones.

## The machine is out of memory

Check swap first. A box with no swap kills its largest process on a memory spike, and the largest
process is usually the database, so what you see is the database going away for no reason while the
panel keeps running.

Then look at the stack rather than the panel. The panel is about 150 MB across both services.
Spam filtering is 150 to 300 MB, the database is 150 to 400 MB, and those two are what fill a small
machine. `docs/PANEL_SYSTEM_REQUIREMENTS.md` has the per-service figures.

## I am locked out by the firewall

The firewall guard exists for exactly this, and it is something you arm before the risky change
rather than something that is always on. Arming it copies the current rules aside and has the machine
put them back in five minutes unless you confirm from a still-working connection that you are still
connected. So if a change did lock you out and the guard was armed, do nothing: wait, and the machine
undoes it for you. Arm one at a time. A second guard armed over a first is how a snapshot gets lost.

Reaching a machine you cannot SSH into means your provider's console, which is out of the panel's
reach entirely and always will be.

## Nothing here matches

`journalctl -u jotpanel -u jotpanel-ops -n 200 --no-pager` and the Approval desk between them hold almost
everything the panel knows. The panel's rule is that it does not report success for anything it has
not read back afterwards, so where it says something worked, it asked the machine.
