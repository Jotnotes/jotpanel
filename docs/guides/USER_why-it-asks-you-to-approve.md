# Why it asks you to approve things

Every change on this server happens in three steps, and you are the second one.

---

## The three steps

**It proposes.** Something asks for a change and you are shown what it would do, in plain words.
Nothing has happened yet.

**You approve.** You say yes, and your name goes on it. Changes that delete something ask you to type
a word, because a click is not a decision.

**It runs, and then it checks.** The change is made, and then the server is asked whether the change
is really there. What you are told is that answer.

## Why the checking matters

Most software tells you what it asked for and calls that success. If the command came back without an
error, you see a tick.

That is not good enough for a server, because a command can come back cleanly and the file can still
not be written, or the service can fail to reload, or the record can not exist. So here the server is
asked afterwards, every time.

The consequence you will notice: sometimes this is slower, and sometimes it tells you something
failed that another panel would have shown as a tick. That is the point of it.

## When something is refused

A refusal is often the system working rather than something being broken. Common ones:

- **You asked for more than your plan allows.** The message says both numbers.
- **The thing is already gone**, or already exists.
- **What you asked for needs something that is not installed** on this server. The message says which.

Read the message. It says what is wrong rather than that something is wrong.

## What is written down

What was asked for, who approved it, what ran, and what the server said afterwards, whether it worked
or not. You can see your own. Your hosting provider can see everything on their machine, which is
worth knowing and is true of every hosting company anywhere.

The useful side of that: when something disappears and nobody knows why, the record knows.
