# The knowledge base

Written for people rather than for developers. Every article here is about doing something on a
machine, and none of them assume you have read the code.

Three audiences, and the prefix on the file says which one an article is for.

- **`HOST_`** is for the company or the person who owns the machine and installed the panel.
- **`RESELLER_`** is for somebody selling hosting on top of a machine that is not theirs.
- **`USER_`** is for the hosting customer, and these are the ones to hand to yours.

---

## If you have just installed the panel

1. [The first hour](HOST_the-first-hour.md)
2. [How a change happens](HOST_how-a-change-happens.md)
3. [Accounts, packages and limits](HOST_accounts-packages-and-limits.md)

## Running the machine

- [Websites and certificates](HOST_websites-and-certificates.md)
- [Mail](HOST_mail.md)
- [DNS](HOST_dns.md)
- [Databases](HOST_databases.md)
- [Backups](HOST_backups.md)
- [Security](HOST_security.md)
- [Keeping the machine healthy](HOST_keeping-the-machine-healthy.md)
- [Moving accounts in and out](HOST_moving-accounts-in-and-out.md)

## Selling hosting

- [Accounts, packages and limits](HOST_accounts-packages-and-limits.md)
- [Taking on resellers](HOST_resellers.md)
- [Being a reseller](RESELLER_being-a-reseller.md)

## The assistant

- [Connecting a control panel](HOST_ADMIN_connect-a-panel.md)

## For your customers

- [Your first website](USER_your-first-website.md)
- [Email on your own domain](USER_email-on-your-domain.md)
- [Files and folders](USER_files-and-folders.md)
- [Why it asks you to approve things](USER_why-it-asks-you-to-approve.md)
- [Signing in, and getting back in](USER_signing-in.md)
- [Backups, and getting your data out](USER_backups-and-your-data.md)

---

## Two things worth knowing before any of it

**The panel checks its own work.** After every change it asks the machine whether the change is
really there, and what it shows you is that answer. So when it says something worked, something
worked. When it says something failed, read the message, because a refusal is often the panel doing
its job rather than a fault.

**Nothing changes until somebody approves it.** Every change is proposed first, approved by a person,
and only then executed, and all three are written down with the name of whoever approved it. That is
[how a change happens](HOST_how-a-change-happens.md), and it is the same for you, for your resellers
and for your customers.
