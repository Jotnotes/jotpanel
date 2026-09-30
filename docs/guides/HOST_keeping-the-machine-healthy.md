# Keeping the machine healthy

The half of running a server that is not a feature: services, scheduled jobs, logs, statistics and
knowing what a machine is actually doing.

---

## Services

Start, stop, restart and reload, and end a runaway process. Restarting and stopping interrupt
something that is running, so both are marked elevated and both say who did it.

Reboot exists as an operation. **It has never been run on any machine**, so treat it as untested and
reboot from your provider's console if it matters.

## Scheduled jobs

Cron commands with a note attached saying what each one is for. The note is not decoration. Six months
later, an unexplained job running at 4am is a thing nobody dares to remove and nobody can explain, and
it stays on the machine forever.

Failed jobs are counted where you can see them. A job that has been failing quietly for weeks is the
usual shape of this problem.

## Logs

Readable from the panel. The two that answer most questions are the web server's, for anything about
a request, and the panel's own journal, for anything about the panel. Between them and the Approval
desk, almost everything the machine knows is available without an SSH session.

## Statistics

Verified visits, pages and sources, and **no raw IP addresses are retained**. That is a deliberate
choice, and it is worth telling your customers, because it is a real difference from the analytics
they are used to and it is one fewer thing on your machine that a regulator can ask about.

## Usage

Storage, service time and assistant spend, exportable as a CSV. This is what you invoice from and
what you argue from when a customer disagrees with a bill.

## The numbers to watch

**`NRestarts` on the two panel services should be zero.** A climbing count means something is
crashing and being restarted, which looks healthy from a distance and is not.

**Swap.** A machine with no swap kills its largest process on a memory spike, and the largest process
is usually the database. So the symptom is a database that disappears for no reason while everything
else keeps running.

**Disk, before it is full and not after.** A full disk on a hosting machine takes out mail, the
databases and the backups at the same moment, and the backups are what you were counting on.

## What to check weekly

Ten minutes, and in this order:

1. Did the backups run, and was the offsite copy confirmed rather than sent.
2. Any certificate expiring in the next two weeks.
3. Failed scheduled jobs.
4. Waiting security updates.
5. Disk and memory against what they were last week, because the trend matters more than the number.
