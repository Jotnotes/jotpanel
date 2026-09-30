# How a change happens

Every change to this machine goes through the same three steps, whoever is making it. It is worth
five minutes to understand, because it is the thing that makes the rest of the panel readable.

---

## Propose, approve, execute

**Propose.** You ask for something. Nothing has happened yet. The panel writes down what was asked
for, in words: not "site.create" but "create the website example.com". A proposal costs nothing and
changes nothing, so proposing something to see what it says it will do is a reasonable thing to do.

**Approve.** A person says yes. Their name goes on it. Destructive changes ask you to type a word
first, because a click is not a decision.

**Execute.** The change runs, and then the panel asks the machine whether the change is actually
there. That answer is what you are shown.

All three are recorded, always, whether the change worked or not.

## Why the third step exists

Because the alternative is a panel that tells you what it asked for rather than what happened.

A command that returns without an error has not proved anything. The file may not have been written,
the service may not have reloaded, the record may not exist. So after a website is created the panel
looks for the website, after a mailbox is created it asks the mail server, and after a firewall rule
is added it reads the rules back.

This has a consequence worth naming. **The panel is sometimes slower than a panel that lies**, and it
occasionally tells you something failed that another panel would have shown as a tick.

## Reading a red row

A red row is not always a defect. Three of them are the product working:

- **A refusal that protects you.** A firewall rule that would cut off your own access is refused.
  So is an account trying to raise its own limits, and a reseller trying to hand a customer more than
  the reseller holds.
- **Nothing to do.** Applying security updates on a machine that has none waiting reports that there
  are none waiting. That is an answer.
- **A missing stack.** Mail operations need a mail server on the machine. Where there is none, the
  panel says so rather than pretending.

Read the message on the row before treating it as a bug. Every row carries its reason.

## Risk levels

Each operation declares how dangerous it is, and the panel behaves differently for each.

- **read-only**, nothing changes.
- **standard**, a normal change.
- **elevated**, something running gets interrupted. Services restart, people notice.
- **destructive**, data or access goes away, and the owner types the word.

## What the record is for

Three things, and the third is the one people do not expect.

It tells you what happened, which is support. It tells you who decided, which is accountability. And
it tells you what the machine said when it was asked afterwards, which is the difference between
"we ran the restore" and "the restore put back these 412 files and here they are".

The record lives in the panel's own database, in `/opt/jotpanel/data`. Back that up along with everything
else, because it is the only copy.
