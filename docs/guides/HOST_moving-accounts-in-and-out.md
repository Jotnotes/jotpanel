# Moving accounts in and out

Getting a customer onto this machine, and getting them off it again. The second half is deliberate:
a panel that makes leaving hard is a panel that is compensating for something.

---

## Taking an account out

A whole account leaves as one ZIP. You propose the export, then approve it and choose a passphrase,
and the credentials inside the package are encrypted with that passphrase and are never shown in the
record afterwards. The package lists its own contents, and a restore lists exactly what came back.

There is no ceremony to leaving, and there is no version of this that requires asking anybody.

## Bringing an JotPanel account in

Upload the package and inspect it. Inspection reads the file and changes nothing on this machine, so
looking at an archive is always safe. The report says what format it is and how many entries it
lists, with any warnings. Then you approve the restore.

## Bringing in a cPanel account

The panel reads a cpmove or backup archive. It parses the upload, tells you what is in it, and
removes the upload before it answers, so nothing is kept and nothing on the machine changes.

**Be honest with yourself about the status of this.** The reader works, and every step after it has
run on this machine, but the only archives it has been given were built to the same layout it
expects, which proves it agrees with itself. A real cpmove file is an experiment until that notice
comes off the screen. Do one, keep the source account running, and check the result before you switch
anything over.

The screen carries the label as well as this page: the archive card is badged **cPanel · coming
soon**, and the card that copies a mailbox is badged **preview**. Neither has run against the real
thing on any machine, and the panel says so where somebody would rely on it rather than in a
footnote.

## Plesk and DirectAdmin

Their archives are not read at all. Not partially, not with warnings. If somebody is coming from
either, the mail is a copy over IMAP and the sites are files.

## Copying mail over IMAP

Where there is no archive, or where the archive is old and the mailbox has moved on, mail is copied
over IMAP from the old server into the new mailbox. There are two modes: pull, which adds, and
replace, which does not.

**Reading a mailbox has been proved. Writing into one has not**, on any machine, which is why that
card is marked preview. Try it on one mailbox that does not matter, with the old server still
receiving, and read the result before you rely on it.

## The order that goes wrong least

1. Create the account and its package here, and take a backup of the old one over there.
2. Move the files and the databases, and check the site works using a hosts file entry, before any
   DNS changes.
3. Copy the mail, with the old server still receiving.
4. Lower the time-to-live on the DNS records, and wait for the old value to age out.
5. Change the records.
6. Copy the mail again for anything that arrived during the change.
7. Leave the old account running for a fortnight. It costs almost nothing and it is the only thing
   that saves you when something nobody remembered turns out to have mattered.
