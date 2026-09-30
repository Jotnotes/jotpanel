// Browser identity for the free panel. Existing sessions are deliberately
// readable under their former Arca keys, but every write uses JotPanel.
const PREFIX = 'jotpanel_';
const LEGACY_PREFIX = 'arca_';

export function readPanelStorage(name, fallback = null, storage = localStorage) {
  const current = storage.getItem(PREFIX + name);
  if (current !== null) return current;
  const legacy = storage.getItem(LEGACY_PREFIX + name);
  return legacy === null ? fallback : legacy;
}

export function writePanelStorage(name, value, storage = localStorage) {
  storage.setItem(PREFIX + name, value);
}

export function removePanelStorage(name, storage = localStorage) {
  storage.removeItem(PREFIX + name);
  // Sign-out must also invalidate a session left by a pre-JotPanel release.
  storage.removeItem(LEGACY_PREFIX + name);
}

export const PANEL_STORAGE_PREFIX = PREFIX;
export const LEGACY_PANEL_STORAGE_PREFIX = LEGACY_PREFIX;
