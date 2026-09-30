'use strict';

// The webmail client, against a customer's own IMAP and SMTP servers.
//
// It lives here rather than in the route handlers because the route handlers
// cannot be tested without a mail server, and every defect this module was
// written to fix was the kind that only shows up on somebody's real mailbox.
// The three libraries are injectable for that reason and for no other.
//
// The rule that shapes the whole file: a message is addressed by its UID and
// never by its position. A sequence number is only true for as long as a
// connection lasts and renumbers the moment anything is expunged, so a delete
// or a move built on one eventually destroys a different message than the one
// on the screen. The UID is stable for the life of the mailbox.

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
// Refused here rather than by the mail server, which would refuse it after the
// person had waited for the upload. Ten megabytes because the request carries
// the file base64-encoded, which is a third larger again, and the panel is
// expected to run on a one-core box: a cap that fits in the request body is
// the difference between a clear refusal and an opaque 413.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function createWebmailClient({ imapLib, mailparser, nodemailer, mailComposer } = {}) {
  const Imap = imapLib || require('imap');
  const parseMime = (mailparser || require('mailparser')).simpleParser;
  const mailer = nodemailer || require('nodemailer');
  const MailComposer = mailComposer || require('nodemailer/lib/mail-composer');

  function connection(account) {
    return new Imap({
      user: account.username,
      password: account.password,
      host: account.imapHost,
      port: Number(account.imapPort) || 993,
      tls: account.imapSecure !== false,
      tlsOptions: { rejectUnauthorized: true, servername: account.imapHost },
      connTimeout: 12000,
      authTimeout: 8000,
    });
  }

  // One connection per request, opened once and closed once. The previous
  // version opened a second connection purely to list the folders, which
  // doubled the authentications a mail host sees and gave the two halves of
  // one screen two different chances to fail.
  function withMailbox(account, fn) {
    return new Promise((resolve, reject) => {
      const imap = connection(account);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        try { imap.end(); } catch { /* the socket is already gone */ }
        error ? reject(error) : resolve(value);
      };
      imap.once('error', error => finish(error));
      imap.once('ready', () => {
        Promise.resolve()
          .then(() => fn(imap))
          .then(value => finish(null, value), error => finish(error));
      });
      imap.connect();
    });
  }

  function openBox(imap, folder, readOnly) {
    return new Promise((resolve, reject) => {
      imap.openBox(folder || 'INBOX', readOnly, (error, box) => error ? reject(error) : resolve(box));
    });
  }

  // Folder names come back with their IMAP attributes attached, because that
  // is how Sent is found reliably. Guessing the name is wrong in every locale
  // but English, and a Sent copy filed into a folder the customer's phone does
  // not read is the same as no Sent copy at all.
  function listFolders(imap) {
    return new Promise(resolve => {
      imap.getBoxes((error, boxes) => {
        if (error || !boxes) return resolve([]);
        const out = [];
        const walk = (node, prefix) => {
          for (const [name, box] of Object.entries(node || {})) {
            const path = prefix ? `${prefix}${box.delimiter || '.'}${name}` : name;
            out.push({ path, attribs: Array.isArray(box.attribs) ? box.attribs : [] });
            if (box.children) walk(box.children, path);
          }
        };
        walk(boxes, '');
        resolve(out);
      });
    });
  }

  function specialFolder(folders, flag, fallback) {
    const match = folders.find(f => f.attribs.some(a => String(a).toLowerCase() === flag.toLowerCase()));
    if (match) return match.path;
    const named = folders.find(f => f.path.toLowerCase() === fallback.toLowerCase()
      || f.path.toLowerCase().endsWith(`/${fallback.toLowerCase()}`)
      || f.path.toLowerCase().endsWith(`.${fallback.toLowerCase()}`));
    return named ? named.path : fallback;
  }

  // Headers are handed to the MIME parser rather than split on colons. A
  // subject in any language but English arrives as =?UTF-8?B?...?= and the
  // line-splitting version printed that at the customer, and a header folded
  // across two lines lost its second half.
  async function headerOf(raw) {
    const parsed = await parseMime(Buffer.from(`${raw}\r\n`));
    return {
      subject: parsed.subject || '(no subject)',
      from: parsed.from?.text || '',
      fromEmail: parsed.from?.value?.[0]?.address || '',
      to: parsed.to?.text || '',
      date: parsed.date ? parsed.date.toISOString() : null,
      messageId: parsed.messageId || '',
      inReplyTo: parsed.inReplyTo || '',
      references: [].concat(parsed.references || []).filter(Boolean),
    };
  }

  // Every body stream is awaited before the fetch is called finished. A
  // message's own end event can arrive while its body is still streaming, and
  // reading the row at that moment yields a message with no headers on a slow
  // connection and a complete one on a fast connection, which is the shape of
  // bug that only ever reproduces at the customer.
  function fetchAll(source, options) {
    return new Promise((resolve, reject) => {
      const rows = [];
      const pending = [];
      const fetch = source.fetch ? source.fetch(options.range, options.fetchOptions) : null;
      if (!fetch) return reject(new Error('fetch is not available on this connection'));
      fetch.on('message', msg => {
        const row = { bodies: {} };
        rows.push(row);
        msg.on('body', (stream, info) => {
          pending.push(new Promise((done, failed) => {
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.once('error', failed);
            stream.once('end', () => {
              row.bodies[info && info.which !== undefined ? info.which : 'BODY'] = Buffer.concat(chunks).toString('utf8');
              done();
            });
          }));
        });
        msg.once('attributes', attrs => { row.attrs = attrs; });
      });
      fetch.once('error', reject);
      fetch.once('end', () => Promise.all(pending).then(() => resolve(rows), reject));
    });
  }

  // The list. It reads the newest page of a folder and returns UIDs.
  //
  // There is deliberately no preview line. The version this replaces put the
  // first two hundred bytes of the raw body on the screen, which for anything
  // sent this decade is base64 or quoted-printable and read as noise. A
  // preview that is right requires decoding the message's first text part, and
  // until that is built the honest thing is to show nothing rather than to
  // show rubbish.
  // `offset` counts back from the newest message, not forward from the oldest,
  // because that is the direction a person reads a mailbox in. Asking for the
  // second page of a folder that has had two messages delivered since the first
  // page was drawn would otherwise show two it has already shown, which is how
  // paging quietly duplicates and skips.
  async function listMessages(account, { folder = 'INBOX', limit = DEFAULT_PAGE, offset = 0 } = {}) {
    const page = Math.max(1, Math.min(Number(limit) || DEFAULT_PAGE, MAX_PAGE));
    const skip = Math.max(0, Number(offset) || 0);
    return withMailbox(account, async imap => {
      const box = await openBox(imap, folder, true);
      const folders = await listFolders(imap);
      const total = box.messages?.total || 0;
      if (!total || skip >= total) {
        return { messages: [], folders: folders.map(f => f.path), total, folder: box.name || folder, offset: skip, hasMore: false };
      }
      const last = total - skip;
      const first = Math.max(1, last - page + 1);
      const rows = await fetchAll(imap.seq, {
        range: `${first}:${last}`,
        // `size` is asked for explicitly. node-imap withholds a message's
        // attributes until every item it requested has come back, and it only
        // requests what it was told to, so a size that is never asked for
        // arrives as undefined and reaches the screen as a confident zero.
        fetchOptions: { bodies: 'HEADER', struct: false, size: true },
      });
      const messages = [];
      for (const row of rows) {
        if (!row.attrs || !row.attrs.uid) continue;
        const header = await headerOf(row.bodies.HEADER || '');
        messages.push({
          id: String(row.attrs.uid),
          uid: row.attrs.uid,
          flags: row.attrs.flags || [],
          unread: !(row.attrs.flags || []).includes('\\Seen'),
          size: row.attrs.size || 0,
          ...header,
        });
      }
      // Sorted here rather than trusted from the fetch. Messages arrive in
      // whatever order the server streams them, and the version this replaces
      // reversed the arrival order and called it newest-first.
      messages.sort((a, b) => b.uid - a.uid);
      return {
        messages: withThreads(messages),
        folders: folders.map(f => f.path),
        total, folder: box.name || folder,
        offset: skip,
        hasMore: first > 1,
      };
    });
  }

  // One message, whole and parsed. There was no way to read a message at all
  // before this: the list was the entire read path.
  async function readMessage(account, { folder = 'INBOX', uid, markSeen = true, withAttachmentContent = false } = {}) {
    const wanted = Number(uid);
    if (!Number.isInteger(wanted) || wanted < 1) throw new Error('a message uid is required');
    return withMailbox(account, async imap => {
      await openBox(imap, folder, !markSeen);
      const rows = await fetchAll(imap, {
        range: String(wanted),
        fetchOptions: { bodies: '', struct: false, markSeen: !!markSeen },
      });
      if (!rows.length) throw new Error('That message is no longer in this folder');
      const raw = rows[0].bodies[''] || rows[0].bodies.BODY || '';
      const parsed = await parseMime(Buffer.from(raw));
      return {
        id: String(wanted),
        uid: wanted,
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || '',
        fromEmail: parsed.from?.value?.[0]?.address || '',
        to: parsed.to?.text || '',
        cc: parsed.cc?.text || '',
        date: parsed.date ? parsed.date.toISOString() : null,
        messageId: parsed.messageId || '',
        references: [].concat(parsed.references || []).filter(Boolean),
        text: parsed.text || '',
        // The HTML is returned but never rendered into the panel's own
        // document. The screen puts it in a sandboxed frame, the same way a
        // customer's published site is served, because this is a stranger's
        // markup arriving over the network.
        html: typeof parsed.html === 'string' ? parsed.html : '',
        attachments: (parsed.attachments || []).map((a, index) => ({
          index,
          filename: a.filename || `attachment-${index + 1}`,
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || 0,
        })),
        // The bytes are carried only when somebody asked to download one. A
        // message list that dragged every attachment's content through memory
        // to draw a filename would fall over on the first mailbox with photos
        // in it.
        rawAttachments: withAttachmentContent ? (parsed.attachments || []) : undefined,
      };
    });
  }

  function appendToSent(imap, folders, raw) {
    const sent = specialFolder(folders, '\\Sent', 'Sent');
    return new Promise(resolve => {
      // A Sent copy that cannot be filed must not fail the send. The message
      // has already left; reporting the whole operation as a failure would
      // invite the customer to send it a second time.
      imap.append(raw, { mailbox: sent, flags: ['\\Seen'] }, error => {
        resolve(error ? { filed: false, folder: sent, reason: error.message } : { filed: true, folder: sent });
      });
    });
  }

  // Which conversation a message belongs to.
  //
  // The first id in References is the message that started the thread, which is
  // what every client that threads properly keys on. In-Reply-To is the fallback
  // for a message whose sender wrote only that, and a message with neither
  // starts its own conversation.
  //
  // Subject is deliberately not used. Grouping by subject puts every "Re: hello"
  // and every "Invoice" from unrelated senders into one conversation, which is
  // worse than not threading at all, and it is why some clients feel like they
  // are guessing.
  function threadKeyOf(message) {
    if (message.references && message.references.length) return message.references[0];
    if (message.inReplyTo) return message.inReplyTo;
    return message.messageId || `uid:${message.uid}`;
  }

  // Threading is within the page that was fetched, and the count says so. A
  // conversation whose earlier half is on the next page is a conversation this
  // does not know about, and pretending otherwise would mean reading the whole
  // mailbox to draw one screen.
  function withThreads(messages) {
    const counts = new Map();
    for (const message of messages) {
      const key = threadKeyOf(message);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return messages.map(message => {
      const key = threadKeyOf(message);
      return { ...message, threadId: key, threadSize: counts.get(key) };
    });
  }

  // ── Folders ───────────────────────────────────────────────────
  //
  // The guard matters more than the three verbs do. Deleting the folder the
  // server files sent mail in destroys the only record a person has of what
  // they sent, and renaming it means the next message is filed somewhere their
  // phone does not look. Neither is recoverable and neither is obviously wrong
  // at the moment somebody clicks it, so both are refused rather than confirmed.
  const PROTECTED = ['\\Inbox', '\\Sent', '\\Trash', '\\Drafts', '\\Junk', '\\Archive', '\\All'];

  async function protectedReason(imap, name) {
    if (String(name).toUpperCase() === 'INBOX') return 'the inbox';
    const folders = await listFolders(imap);
    const match = folders.find(f => f.path === name);
    if (!match) return '';
    const special = match.attribs.find(a => PROTECTED.some(p => p.toLowerCase() === String(a).toLowerCase()));
    return special ? `the folder this mailbox uses for ${special.replace(/\\/g, '').toLowerCase()}` : '';
  }

  function folderName(name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('a folder needs a name');
    if (clean.length > 100) throw new Error('that folder name is too long');
    // A name carrying a line ending would end the IMAP command early and let
    // whatever follows it be read as the next command.
    if (/[\r\n\0"]/.test(clean)) throw new Error('a folder name cannot contain quotes or line breaks');
    return clean;
  }

  async function createFolder(account, { name } = {}) {
    const wanted = folderName(name);
    return withMailbox(account, async imap => {
      await promised(imap, 'addBox', wanted);
      const folders = await listFolders(imap);
      return { ok: true, folder: wanted, folders: folders.map(f => f.path) };
    });
  }

  async function renameFolder(account, { name, to } = {}) {
    const from = folderName(name);
    const wanted = folderName(to);
    return withMailbox(account, async imap => {
      const why = await protectedReason(imap, from);
      if (why) throw new Error(`${from} is ${why} and cannot be renamed`);
      await promised(imap, 'renameBox', from, wanted);
      const folders = await listFolders(imap);
      return { ok: true, from, folder: wanted, folders: folders.map(f => f.path) };
    });
  }

  async function deleteFolder(account, { name } = {}) {
    const wanted = folderName(name);
    return withMailbox(account, async imap => {
      const why = await protectedReason(imap, wanted);
      if (why) throw new Error(`${wanted} is ${why} and cannot be deleted`);
      const box = await openBox(imap, wanted, true);
      const held = box.messages?.total || 0;
      if (held) throw new Error(`${wanted} still holds ${held} message${held === 1 ? '' : 's'}; move or delete them first`);
      await promised(imap, 'closeBox', false);
      await promised(imap, 'delBox', wanted);
      const folders = await listFolders(imap);
      return { ok: true, folder: wanted, folders: folders.map(f => f.path) };
    });
  }

  // ── The write verbs ───────────────────────────────────────────
  //
  // All of them take UIDs and a folder, never a position. They open the box
  // writable, which the read path deliberately does not, so a read can never
  // change a flag by accident.

  function uidList(uids) {
    const list = [].concat(uids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!list.length) throw new Error('no message was selected');
    return list;
  }

  function promised(imap, method, ...argv) {
    return new Promise((resolve, reject) => {
      imap[method](...argv, error => error ? reject(error) : resolve());
    });
  }

  async function setFlags(account, { folder = 'INBOX', uids, add = [], remove = [] } = {}) {
    const list = uidList(uids);
    return withMailbox(account, async imap => {
      await openBox(imap, folder, false);
      if (add.length) await promised(imap, 'addFlags', list, add);
      if (remove.length) await promised(imap, 'delFlags', list, remove);
      return { ok: true, uids: list, added: add, removed: remove };
    });
  }

  // Moving is one operation to the server where it can be, and copy-then-delete
  // where it cannot. node-imap makes that choice on the server's advertised
  // capabilities, which is the right place for it: doing it by hand is how a
  // message ends up copied and not removed, or removed and not copied.
  async function moveMessages(account, { folder = 'INBOX', uids, to } = {}) {
    const list = uidList(uids);
    if (!to) throw new Error('a destination folder is required');
    return withMailbox(account, async imap => {
      await openBox(imap, folder, false);
      const folders = await listFolders(imap);
      const destination = folders.some(f => f.path === to) ? to : specialFolder(folders, to, to);
      if (destination === folder) throw new Error('that is the folder it is already in');
      await promised(imap, 'move', list, destination);
      return { ok: true, uids: list, to: destination };
    });
  }

  // Delete means Trash. A message a person deletes is one they can still be
  // wrong about, and a client whose delete cannot be undone is a client that
  // eventually loses somebody something. Permanent deletion exists, is a
  // separate verb, and is what emptying the Trash uses — and deleting from
  // inside Trash is permanent, because there is nowhere left to put it.
  async function deleteMessages(account, { folder = 'INBOX', uids, permanent = false } = {}) {
    const list = uidList(uids);
    const trashed = await withMailbox(account, async imap => {
      await openBox(imap, folder, false);
      const folders = await listFolders(imap);
      const trash = specialFolder(folders, '\\Trash', 'Trash');
      if (permanent || folder === trash) {
        await promised(imap, 'addFlags', list, ['\\Deleted']);
        await promised(imap, 'expunge', list);
        return { ok: true, uids: list, permanent: true, folder };
      }
      await promised(imap, 'move', list, trash);
      return { ok: true, uids: list, permanent: false, to: trash };
    });
    return trashed;
  }

  // Search asks the server, which is the only thing that can answer it. Doing
  // it here would mean downloading the mailbox to look through it, and the
  // answer would still only cover the page that had been downloaded.
  async function searchMessages(account, { folder = 'INBOX', query = '', limit = DEFAULT_PAGE } = {}) {
    const text = String(query || '').trim();
    if (!text) throw new Error('a search needs something to look for');
    const page = Math.max(1, Math.min(Number(limit) || DEFAULT_PAGE, MAX_PAGE));
    return withMailbox(account, async imap => {
      const box = await openBox(imap, folder, true);
      const folders = await listFolders(imap);
      const uids = await new Promise((resolve, reject) => {
        imap.search([['TEXT', text]], (error, found) => error ? reject(error) : resolve(found || []));
      });
      if (!uids.length) return { messages: [], folders: folders.map(f => f.path), total: 0, folder: box.name || folder, query: text };
      const newest = uids.sort((a, b) => a - b).slice(-page);
      const rows = await fetchAll(imap, { range: newest.join(','), fetchOptions: { bodies: 'HEADER', struct: false, size: true } });
      const messages = [];
      for (const row of rows) {
        if (!row.attrs || !row.attrs.uid) continue;
        messages.push({
          id: String(row.attrs.uid), uid: row.attrs.uid, flags: row.attrs.flags || [],
          unread: !(row.attrs.flags || []).includes('\\Seen'), size: row.attrs.size || 0,
          ...(await headerOf(row.bodies.HEADER || '')),
        });
      }
      messages.sort((a, b) => b.uid - a.uid);
      return { messages, folders: folders.map(f => f.path), total: uids.length, folder: box.name || folder, query: text };
    });
  }

  // An attachment is read out of the parsed message rather than fetched as a
  // MIME part by number, because a part number is only meaningful against the
  // structure it came from and the structure is what we would have to trust.
  // The cost is that the message is fetched whole; the benefit is that what
  // arrives is what the parser says it is.
  async function readAttachment(account, { folder = 'INBOX', uid, index } = {}) {
    const wanted = Number(index);
    const message = await readMessage(account, { folder, uid, markSeen: false, withAttachmentContent: true });
    const attachment = (message.rawAttachments || [])[wanted];
    if (!attachment) throw new Error('that attachment is not on this message');
    return {
      filename: attachment.filename || `attachment-${wanted + 1}`,
      contentType: attachment.contentType || 'application/octet-stream',
      content: attachment.content,
    };
  }

  // A draft is a message in the Drafts folder, which is all a draft has ever
  // been. Saving one replaces the last, so a person editing for ten minutes
  // does not leave ten copies behind.
  async function saveDraft(account, { draft = {}, replacesUid = null } = {}) {
    const envelope = composeEnvelope(account, draft, { allowEmpty: true });
    const raw = await new MailComposer(envelope).compile().build();
    return withMailbox(account, async imap => {
      const folders = await listFolders(imap);
      const drafts = specialFolder(folders, '\\Drafts', 'Drafts');
      if (replacesUid) {
        try {
          await openBox(imap, drafts, false);
          await promised(imap, 'addFlags', [Number(replacesUid)], ['\\Deleted']);
          await promised(imap, 'expunge', [Number(replacesUid)]);
        } catch { /* the previous draft is already gone, which is the state we wanted */ }
      }
      await new Promise((resolve, reject) => {
        imap.append(raw, { mailbox: drafts, flags: ['\\Draft', '\\Seen'] }, error => error ? reject(error) : resolve());
      });
      const box = await openBox(imap, drafts, true);
      return { ok: true, folder: drafts, uid: box.uidnext ? box.uidnext - 1 : null };
    });
  }

  // Compose and reply are one path. A reply is a compose that carries the
  // threading headers, and keeping them separate is how the reply ended up
  // being the only thing that could be sent.
  // One definition of what a message is, used by sending and by saving a
  // draft. They diverged once already: the draft is allowed to be empty and
  // unaddressed, because that is what an unfinished message is, and nothing
  // else about it may differ or the draft you resume is not the one you saved.
  function composeEnvelope(account, { to, cc = '', bcc = '', subject = '', text = '', inReplyTo = '', references = [], attachments = [] } = {}, { allowEmpty = false } = {}) {
    const recipients = String(to || '').trim();
    if (!allowEmpty && !recipients) throw new Error('a recipient is required');
    if (!allowEmpty && !String(text || '').trim()) throw new Error('an empty message is not sent');

    const envelope = {
      from: account.email,
      to: recipients,
      subject: String(subject || '').trim() || '(no subject)',
      text: String(text || ''),
    };
    if (cc) envelope.cc = String(cc).trim();
    if (bcc) envelope.bcc = String(bcc).trim();
    if (inReplyTo) {
      envelope.inReplyTo = inReplyTo;
      // De-duplicated, because the caller usually passes the message it is
      // answering in both fields and a References header that repeats the same
      // id is how a thread starts looking wrong in a strict client.
      envelope.references = [...new Set([].concat(references || []).concat([inReplyTo]).filter(Boolean))];
    }
    const files = [].concat(attachments || []).filter(Boolean);
    if (files.length) {
      let total = 0;
      envelope.attachments = files.map(file => {
        const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content || ''), 'base64');
        total += content.length;
        if (total > MAX_ATTACHMENT_BYTES) throw new Error('those attachments are larger than this mailbox will send');
        return {
          filename: String(file.filename || 'attachment').replace(/[\r\n]/g, '').slice(0, 200),
          contentType: file.contentType || 'application/octet-stream',
          content,
        };
      });
    }
    return envelope;
  }

  async function sendMessage(account, fields = {}) {
    const envelope = composeEnvelope(account, fields);
    const recipients = envelope.to;

    // Built once and used twice, so the copy in Sent is the message that was
    // sent rather than a second rendering of the same fields.
    const raw = await new MailComposer(envelope).compile().build();

    const transport = mailer.createTransport({
      host: account.smtpHost || account.imapHost,
      port: Number(account.smtpPort) || 587,
      secure: !!account.smtpSecure,
      auth: { user: account.username, pass: account.password },
      tls: { rejectUnauthorized: true, servername: account.smtpHost || account.imapHost },
    });
    const info = await transport.sendMail({
      envelope: { from: account.email, to: [recipients, envelope.cc, envelope.bcc].filter(Boolean).join(',') },
      raw,
    });

    let sentCopy = { filed: false, folder: 'Sent', reason: 'not attempted' };
    try {
      sentCopy = await withMailbox(account, async imap => {
        const folders = await listFolders(imap);
        return appendToSent(imap, folders, raw);
      });
    } catch (error) {
      sentCopy = { filed: false, folder: 'Sent', reason: error.message };
    }

    // The draft this message was written in is removed once it has actually
    // left, and never before. A draft deleted at the moment Send is pressed is
    // a message a person loses when the mail server refuses it.
    let draft = { removed: false };
    if (fields.draftUid) {
      try {
        draft = await withMailbox(account, async imap => {
          const folders = await listFolders(imap);
          const drafts = specialFolder(folders, '\\Drafts', 'Drafts');
          await openBox(imap, drafts, false);
          await promised(imap, 'addFlags', [Number(fields.draftUid)], ['\\Deleted']);
          await promised(imap, 'expunge', [Number(fields.draftUid)]);
          return { removed: true, folder: drafts };
        });
      } catch (error) { draft = { removed: false, reason: error.message }; }
    }

    return { ok: true, messageId: info?.messageId || '', accepted: info?.accepted || [], sentCopy, draft };
  }

  return {
    listMessages, readMessage, sendMessage, searchMessages,
    setFlags, moveMessages, deleteMessages, readAttachment, saveDraft,
    createFolder, renameFolder, deleteFolder, threadKeyOf, withThreads,
    specialFolder, headerOf, listFolders, withMailbox, composeEnvelope,
  };
}

module.exports = { createWebmailClient, DEFAULT_PAGE, MAX_PAGE };
