# Your first website

For the person whose website this is. No technical background assumed.

---

## What you get

A website on this server gets its own space, separate from every other website on the machine. Your
files are yours, and nothing else on the server can read them.

## Making it

Ask for the website with the domain name you want to use. The panel proposes it, you approve it, and
then it makes the site and checks it is really there before it tells you it worked.

If the message says something was refused, read it. It says what is wrong, and it is usually one of
two things: the name is already on this server, or the name is not pointed at this server yet.

## Getting your files on

Three ways, and any of them is fine.

**Upload them in the panel.** Drag a folder or a ZIP, and extract it if you uploaded a ZIP.

**Turn on SFTP** and use a program like FileZilla or Cyberduck. Turn it off again when you are done,
which takes one click and is a genuinely good habit.

**Install an application.** WordPress installs in one step, along with the database it needs.

## The green padlock

Ask for a certificate, and then turn on the setting that sends everybody to the secure version of
your site. Both are one action each.

If the certificate does not issue, it is almost always because the domain name is not yet pointing at
this server, or is still pointing at your old one. Wait for that to finish and try again.

## Choosing a PHP version

If your site is WordPress or anything similar, it runs on PHP, and you can choose which version. The
newest is usually right, and the one thing worth knowing is that a very old site can break on a very
new PHP. If a site goes blank after a version change, change it back, and the site comes back.

## Before you change anything you care about

Take a backup. It takes a minute and it is the difference between an afternoon and a fortnight.
