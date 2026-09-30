'use strict';

// Registration is a condition of using OUR service, not of using the panel.
//
// The chat route used to ask the licence before the fork that decides who
// answers, so a customer whose own Anthropic key sat in their own vault, on
// their own box, was refused until they had registered with JotNotes. The
// installer's first page says "The panel installs and works without
// registration", and the one feature people came for did not honour it.
// Settled by Steve on 2026-09-25: own-key Echo works unregistered.
//
// The rule: the gate follows the thinking URL, which is the same fork the chat
// route already uses to decide who answers. No URL and the panel answers from
// its own prompt with the person's own key, so there is nothing of ours in the
// path and nobody is asked to register. A URL and the request leaves for our
// service, where the licence still decides.
//
// It lives in its own file so the rule is tested against the code that runs,
// rather than against a copy of it in a test.

function usesHostedThinking(env = process.env) {
  return !!(env.JOTPANEL_THINKING_URL ?? env.ARCA_THINKING_URL);
}

function createThinkingGate({ licenseClient, env = process.env } = {}) {
  if (!licenseClient) throw new Error('the thinking gate needs a licence client');
  return async function thinkingAccessForRequest() {
    if (!usesHostedThinking(env)) {
      return { allowed: true, status: 'own-key', registered: false, local: true };
    }
    return licenseClient.thinkingAccess();
  };
}

module.exports = { createThinkingGate, usesHostedThinking };
