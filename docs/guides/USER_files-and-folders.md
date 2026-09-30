# Files and folders

---

## Where your files are

Everything for a website lives under that website's own folder. Nothing outside it belongs to you,
and nothing else on the server can see inside it.

## Getting files in and out

**In the panel**, you can upload, download, rename, move, delete, make folders, and pack or unpack a
ZIP. Uploading a ZIP and extracting it is the fastest way to move a whole site.

**Over SFTP**, you turn access on, use a program like FileZilla or Cyberduck, and turn it off again
afterwards. Leaving it on is not dangerous, but turning it off when you are not using it is a
one-click habit worth having.

## Two things the panel will refuse

**A path that leaves your site through a shortcut.** If a file is a link pointing somewhere outside
your website, the panel refuses to act on it and says so. Links pointing inside your own site are
fine. This exists because following those links out is how people have got into other customers'
files on other hosting.

**Deleting something without saying so.** Deletion asks you to confirm by typing, not by clicking,
because a click is not a decision.

## Uploads have a size limit

Large files are supported, up to whatever your provider set. If an upload fails on a large file, that
is usually what happened.

## Before a big change

Take a backup first. Moving, extracting and deleting are the three operations people undo most often,
and the undo is a restore.
