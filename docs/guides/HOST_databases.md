# Databases

MariaDB and PostgreSQL, through one set of operations, and both can run on the same machine at the
same time.

---

## What you can do

Create and drop a database. Create and drop a database user. Grant a user access to a database.
Change a password. Import a dump.

Neither database server is installed until you ask for one. MariaDB is typically 150 to 400 MB of
memory, most of it the buffer pool and most of that tunable. PostgreSQL is typically 100 to 200 MB.
On a 2 GB machine that is a real fraction of what you have, so install one rather than both unless
you actually need both.

## Naming

Letters, digits and underscore, starting with a letter. The panel used to refuse an underscore, which
meant it was refusing names like `wp_blog` that the database server underneath would have accepted
happily. It does not any more, and it holds the same floor the machine holds rather than a stricter
one of its own invention.

That principle is worth knowing generally: where the panel refuses something, it is refusing it
because the thing underneath would have refused it too. A password the mail server would reject is
refused at the panel rather than accepted, approved, and then quietly rejected by the mail server
afterwards. An approval recorded for something that was never going to work is the one failure this
design exists to prevent.

## Dropping things

Dropping a database is destructive, so it asks you to type the word. Dropping a database user is the
same.

Both of these have an interesting property in the record. Dropping something that is already gone
fails, and that failure is recorded next to the successful drop that removed it. So a row that reads
"verified, and a later run failed: there is no database called X" is a complete and honest account of
what happened, not two contradictory results.

## Importing

Importing a dump is destructive, because it writes over what is there. Take a backup first. The panel
will not stop you and it is not supposed to.

## Access from outside

Both database servers are behind the firewall, which is the right default. If an application on
another machine needs access, that is a firewall rule you add deliberately, restricted to the address
that needs it, and not a port you open to everybody.
