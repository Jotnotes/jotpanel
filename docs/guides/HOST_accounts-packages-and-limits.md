# Accounts, packages and limits

How the panel decides what an account may do, and how you sell hosting with it.

---

## The three roles

```
Server admin        owns the machine, installed the panel
  → Reseller        takes on customers of their own, inside limits you set
    → End user      the hosting customer
```

All three are in the free panel. There is no fourth role that logs in. The company that wrote the
software has no account on your machine, no support login and no backdoor, by design.

## A package is what an account may use

A package is a set of ceilings: how many websites, how many mailboxes, how many databases, how much
disk, and so on. You define packages, and an account gets one.

Two rules hold everywhere and they are the whole safety model:

**An account cannot change its own limits.** Not the owner, not a reseller, not a customer. Raising a
limit is something a parent does to a child, so the request goes upward or it is refused.

**A parent cannot grant more than it holds.** A reseller with ten websites in their package cannot
hand a customer five hundred. The panel refuses with the numbers in the message, so the answer says
what is wrong rather than that something is wrong.

## Taking on an account

Define the package first, then create the account and assign it. The account gets an organization of
its own immediately, without a restart, and it sits under exactly one provider. Taking somebody on
twice does not put them under two providers, it is refused.

That last part matters more than it sounds. Ownership of every resource on this machine is recorded,
and it is what every read and every write is checked against. A customer sees their own websites
because the record says they own them, not because a screen filtered a list.

## Suspending and restoring

Suspending an account closes its domains and refuses its sign-in, and the panel records both. Putting
the account back reopens them. Nothing is deleted by a suspension, which is what makes it the right
answer to an unpaid invoice and the wrong answer to a customer who has left.

## Changing what somebody holds

Assign them a different package. Archive a package you no longer sell rather than deleting it, so the
accounts that still reference it still make sense.

## What has been proved about all of this

Run on a live machine on 2026-08-29 and 2026-08-30, against the panel's own database rather than
against the answers the API gave:

- An admin over two resellers over three customers, each customer owning a real website.
- A reseller sees its own customers' websites and not the other reseller's.
- A reseller can act on a customer's website, and the machine changed underneath.
- A reseller can suspend its own customer, the customer cannot sign in while it lasts, and the
  reseller can put them back.
- Twenty-three forbidden paths tried on purpose, twenty-three refusals, and nothing belonging to the
  other reseller moved while it was being attacked.
- A reseller is offered only the packages it owns, and cannot allocate more than it holds.
