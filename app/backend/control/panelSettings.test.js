'use strict';

const assert = require('assert');
const { panelSetting, panelDatabasePath } = require('./panelSettings');

assert.equal(panelSetting('LICENSE_URL', null, {
  JOTPANEL_LICENSE_URL: 'https://new.example',
  ARCA_LICENSE_URL: 'https://old.example',
}), 'https://new.example', 'new settings win');
assert.equal(panelSetting('LICENSE_URL', null, { ARCA_LICENSE_URL: 'https://old.example' }),
  'https://old.example', 'old settings remain readable');

const fake = existing => ({ existsSync: value => existing.includes(value) });
assert.equal(panelDatabasePath('/data', fake(['/data/arca.db'])), '/data/arca.db', 'old database path remains readable');
assert.equal(panelDatabasePath('/data', fake(['/data/arca.db', '/data/jotpanel.db'])), '/data/jotpanel.db', 'new database wins');

console.log('panel naming compatibility: 4 passed');
