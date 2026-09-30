# Email on your own domain

---

## Making a mailbox

Ask for the address you want and set a password. That is the whole of it. You can then read that mail
in the panel, or set it up in Outlook, Apple Mail, Thunderbird or your phone using the server details
the panel shows you.

Passwords have a floor of ten characters, and it is the mail server's floor rather than the panel
being fussy. A shorter one would be accepted by the panel and then refused by the mail server, which
is the confusing kind of failure this avoids.

## Forwarders, auto-replies and catch-alls

A **forwarder** sends mail arriving at one address on to another. It does not need a mailbox, so it is
the right answer for `sales@` when there is one person reading everything.

An **auto-reply** answers automatically. Set it for a holiday and clear it when you are back. Setting
one and forgetting it is the most common small embarrassment in email.

A **catch-all** takes everything sent to any address at your domain that does not exist. It is
convenient and it collects an enormous amount of spam, because spammers guess addresses. Most people
who turn it on turn it off again.

## Your mailbox has a size limit

When it is full, mail sent to you is refused rather than held. Delete things, or ask your provider
for more space. If people report that mail to you bounced and nothing seems wrong, this is the first
thing to check.

## Why your mail might go to somebody's spam folder

Three things decide whether the big providers trust mail from your domain, and your hosting provider
sets all three up together. If they are missing, mail from your domain is filed as spam as a matter
of policy, no matter what is in it.

If your mail is going to spam, ask your provider to check those three records before you rewrite the
message. It is almost never the message.

## What can be known and what cannot

Whether a message left this server, and whether one arrived at it, is knowable and your provider can
tell you. What the person's own email provider did with it after it arrived, meaning which folder
they put it in, is not something anybody outside that provider can see.
