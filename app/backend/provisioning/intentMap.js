'use strict';

const { ACTIONS } = require('./actions');

const INTENT_PATTERNS = [
  {
    actionKey: ACTIONS.CREATE_EMAIL_ACCOUNT,
    patterns: [
      /create .*email/i, /add .*mailbox/i, /new .*mail account/i,
      // The demo bridge hears natural phrasing: "make an email address for
      // mark", "set up a mailbox on my domain", "I need an email address".
      /\b(make|set ?up|need|want|give)\b.*\b(email|mailbox|mail account)\b/i,
      /\b(email|mailbox) (address|account)? ?for\b/i,
    ],
  },
  {
    actionKey: ACTIONS.CREATE_FTP_ACCOUNT,
    patterns: [
      /create .*ftp/i, /add .*ftp account/i, /grant .*ftp/i,
      /\b(make|set ?up|need|want|give)\b.*\bftp\b/i,
    ],
  },
  {
    actionKey: ACTIONS.FETCH_ACCOUNT_STATS,
    patterns: [/stats/i, /bandwidth/i, /disk/i, /visitors/i, /traffic/i],
  },
  {
    actionKey: ACTIONS.ADD_DNS_RECORD,
    patterns: [/add .*dns/i, /create .*dns/i, /add .*record/i, /\b(a|aaaa|cname|txt|mx) record\b/i],
  },
];

function mapIntent(intent) {
  if (!intent) throw new Error('intent is required');
  if (Object.values(ACTIONS).includes(intent)) return intent;

  const text = String(intent);
  const match = INTENT_PATTERNS.find((entry) => entry.patterns.some((pattern) => pattern.test(text)));
  if (!match) throw new Error(`Unsupported provisioning intent: ${intent}`);
  return match.actionKey;
}

module.exports = {
  INTENT_PATTERNS,
  mapIntent,
};
