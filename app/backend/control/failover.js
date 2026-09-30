'use strict';

// Failure policy (Stage 6). A busy or failing provider (429, a 5xx, a network
// error or a timeout) gets one more try after a short pause. Any failure then
// moves to the next suitable provider, but only while nothing has reached the
// screen: once tokens are showing, finishing in another model would stitch two
// answers together, so the error is shown instead.

function isTransient(error) {
  const status = Number(error && error.status);
  return !status || status === 408 || status === 429 || status >= 500;
}

function isKeyRefusal(error) {
  return [401, 403, 429].includes(Number(error && error.status));
}

async function runWithFailover({ first, run, next, nextKey = () => null, emitted = () => 0, aborted = () => false, sleep = ms => new Promise(r => setTimeout(r, ms)), backoffMs = 400, onFailure = () => {}, onKeyFailover = () => {} }) {
  const failures = [];
  const retried = new Set();
  const triedKeys = new Set();
  const keyFailovers = new Set();
  let route = first;
  for (;;) {
    try {
      return { out: await run(route), route, failures };
    } catch (error) {
      const key = `${route.providerId}/${route.model}`;
      onFailure(route, error);
      failures.push({ route: key, status: error.status || null, message: String(error.message || ''), ...(route.keyFingerprint ? { fingerprint: route.keyFingerprint } : {}) });
      if (route.keyFingerprint) triedKeys.add(`${key}/${route.keyFingerprint}`);
      if (emitted() > 0 || aborted()) { error.failures = failures; throw error; }

      // A provider refusing one of the person's keys gets one different key
      // for the same provider and model. The fingerprint identifies the slot;
      // the secret itself never enters the failure record or callbacks.
      if (route.keyFingerprint && isKeyRefusal(error) && !keyFailovers.has(key)) {
        const alternate = nextKey(route, error, failures);
        const alternateId = alternate && alternate.keyFingerprint
          ? `${alternate.providerId}/${alternate.model}/${alternate.keyFingerprint}` : null;
        if (alternate && alternate.providerId === route.providerId && alternate.model === route.model
            && alternateId && !triedKeys.has(alternateId)) {
          keyFailovers.add(key);
          triedKeys.add(alternateId);
          onKeyFailover(route, alternate, error);
          route = alternate;
          continue;
        }
      }

      const refusedStoredKey = Number(error.status) === 429 && route.keyFingerprint;
      if (isTransient(error) && route.providerId !== 'byog' && !retried.has(key)) {
        if (!refusedStoredKey) {
          retried.add(key);
          await sleep(backoffMs);
          continue;
        }
      }
      const following = next(route, error, failures);
      // Never back to a provider that already failed this turn, and never
      // more than a handful of tries in all.
      const again = following && failures.some(f => f.route === `${following.providerId}/${following.model}`);
      if (!following || again || failures.length >= 8) { error.failures = failures; throw error; }
      route = following;
    }
  }
}

module.exports = { isTransient, isKeyRefusal, runWithFailover };
