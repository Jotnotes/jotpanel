import assert from 'node:assert/strict';
import { readPanelStorage, writePanelStorage, removePanelStorage } from './panel-storage.js';

function memory(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

const legacy = memory({ arca_jwt: 'existing-session' });
assert.equal(readPanelStorage('jwt', null, legacy), 'existing-session', 'old auth storage stays signed in');
writePanelStorage('jwt', 'new-session', legacy);
assert.equal(legacy.getItem('jotpanel_jwt'), 'new-session', 'writes use only the new auth key');
assert.equal(legacy.getItem('arca_jwt'), 'existing-session', 'a write does not overwrite legacy state');
assert.equal(readPanelStorage('jwt', null, legacy), 'new-session', 'new auth state wins');
removePanelStorage('jwt', legacy);
assert.equal(readPanelStorage('jwt', null, legacy), null, 'sign-out clears both names');

console.log('panel browser compatibility: 5 passed');
