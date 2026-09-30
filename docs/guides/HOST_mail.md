# Mail

Mail is the part of hosting that goes wrong in the most confusing way, because a message that is
accepted, delivered and then filed as spam looks exactly like a message that worked.

---

## What the panel manages

Mailboxes, with passwords and quotas. Forwarders. Auto-replies. A catch-all. Spam filtering. The
queue. And the three authentication records that decide whether anybody trusts your mail.

None of it exists until you install the mail stack, which is Postfix and Dovecot, plus spam filtering
if you want it. Spam filtering is the largest single thing on a small machine at 150 to 300 MB, so
decide on it deliberately rather than because it was in a list.

## Set up authentication before you send anything

DKIM, SPF and DMARC are one job in the panel rather than three separate errands, and doing them first
saves the week that otherwise goes into working out why a large provider files your mail as spam.

Mail from a domain with no SPF record and no DKIM signature is filed as spam as a matter of policy by
the large providers. Nothing on your machine is wrong when that happens, and no amount of looking at
your own logs will show it.

## When mail is not arriving

Check in this order, because each step is cheaper than the next.

**The queue.** A queue that is growing is a delivery problem. An empty queue with nothing arriving is
an acceptance problem. They are different faults and they have nothing to do with each other. The
panel can retry a queued message or delete it.

**The authentication records.** The panel can tell you what it published. Check the published record
from outside, not the intended one from inside.

**The receiving side.** Whether a message was accepted by your machine is knowable and is in your
logs. What the recipient's provider did with it afterwards is not, and no panel can tell you.

## Quotas

A mailbox quota is a ceiling on that mailbox. A full mailbox rejects mail, which is correct and is
also the single most common support ticket in hosting. Set quotas deliberately and tell your
customers what theirs is.

## What is not here

Webmail is a separate thing to install, not part of the mail stack. The panel's own mail sending, for
sign-in links and alerts, is configured separately in the panel's own settings and has nothing to do
with your customers' mail. A panel with no mail configuration still works and simply cannot send.
