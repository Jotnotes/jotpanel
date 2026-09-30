'use strict';

const fs = require('fs');
const path = require('path');

// JotPanel owns the panel configuration namespace. ARCA_* remains a permanent
// read-only compatibility surface for boxes installed before the rename.
function panelSetting(name, fallback, env = process.env) {
  const current = env[`JOTPANEL_${name}`];
  if (current !== undefined && current !== '') return current;
  const legacy = env[`ARCA_${name}`];
  if (legacy !== undefined && legacy !== '') return legacy;
  return fallback;
}

function panelDatabasePath(dataDir, fsImpl = fs) {
  const current = path.join(dataDir, 'jotpanel.db');
  const legacy = path.join(dataDir, 'arca.db');
  if (!fsImpl.existsSync(current) && fsImpl.existsSync(legacy)) return legacy;
  return current;
}

module.exports = { panelSetting, panelDatabasePath };
