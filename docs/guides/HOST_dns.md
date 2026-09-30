# DNS

The panel runs DNS on this machine. Zones and records, created and deleted, with the same propose,
approve and read-back loop as everything else.

---

## Whether you want this at all

You do not have to serve DNS from the machine that serves the websites. Plenty of good hosting runs
DNS somewhere else entirely, at a registrar or a specialist, and there are two honest reasons to.

**A single machine is a single point of failure for DNS.** If the box is down, the sites are down
anyway, but so is everything else on those domains, including mail routing to a mail server that is
still perfectly healthy somewhere else.

**Delegating DNS elsewhere is one less service to run**, and one less thing on a 2 GB machine.

Run it here when you want the whole account in one place, when your customers are not going to manage
records themselves, or when you are selling a service where you own the whole path.

## Zones

A zone is created for a domain and it can be deleted again. That second half is worth a sentence,
because it did not exist until recently: the panel could create a zone it had no way to remove, and
an audit found leftover zones on three machines. Removing a zone is now the same kind of operation as
creating one, with the same ownership check, the same confirmation and the same record.

## Records

Created and deleted individually, and read back off the machine afterwards rather than out of the
answer the operation gave.

## The two mistakes that cost the most

**Changing a record before the old one has expired everywhere.** Lower the time-to-live first, wait
for the old value to age out, then change it. Doing it the other way is how a domain half-moves for
two days.

**Deleting a zone that is still delegated to you.** The domain does not fall back to something else,
it stops resolving. Move the delegation first, confirm it has moved, then remove the zone.
