# Backups

The part of the panel worth being pedantic about, because the whole value of a backup is realised on
the worst day you will have.

---

## What a backup is here

A backup covers files, mail and databases, taken as parts, and it carries a manifest: a description
of exactly what is inside it, with a digest. The restore then lists exactly what came back. That
pairing is the point. A restore that returns less than the manifest promised is visible rather than
silent.

## Take one by hand before you schedule any

Watch it run once. You learn what it covers, how long it takes and how large it is, and those three
numbers decide the schedule far better than a guess does.

## Send it off the machine

A backup on the machine is a copy of your data on the disk that is going to fail. Connect a
destination under **Backup destinations**, then check the result of the first copy.

**What is offered today is another server over SFTP.** S3-compatible object storage, which covers S3
itself along with R2, B2, Wasabi and MinIO, is listed on that screen and disabled, marked coming
soon, and the reason is on the screen: it has been written and tested against a stand-in and never
run against a real bucket, and a backup destination that has only been tested against a stand-in is
not one the panel will offer you. The panel refuses it on the server as well, so the disabled option
is not the only thing stopping it.

**Confirmed and sent are different words.** A copy is confirmed when the destination has been asked
for its hash and agreed. Until then it is a copy that might be there. This is not a hypothetical
distinction: no offsite copy on any machine here had ever been confirmed until two faults were found
in a row, one where the store never asked the destination for a hash, and one where the description
of the backup carried no digest to compare against.

## Retention, which is where the surprises are

A destination with a keep ceiling drops the oldest copy when it makes a new one. A destination whose
quota is full stops making new copies rather than making room by deleting old ones. Both are correct,
and both look like "backups stopped working" if you have not read this.

Two suites failed here once purely for these two reasons, on a machine that had had ten runs against
it, and both passed first time on a fresh machine. Check the quota before you assume a fault.

## Scheduling

Set a schedule, and set the address that gets told when one fails. A backup system nobody hears from
is a backup system nobody knows is broken.

## Restoring

Restoring is destructive and asks you to type the word. It lists what came back.

**Practise it before you need it.** Restore something small onto a site that does not matter, and
read the list. The first time you exercise a restore should not be the morning the machine is on
fire.

## What the panel's own state is

The panel's database, in `/opt/jotpanel/data`, holds the accounts, the ownership records and the whole
approval record. It is the only copy and nothing else on the machine reconstructs it. Include it in
whatever backs up the machine itself, and move that copy off the box.
