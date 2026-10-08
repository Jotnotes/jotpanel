// The standalone control panel.
//
// This is the free product: a normal control panel that somebody signs in to
// and runs their server from. There is no desktop, no windows, no virtual
// workspaces and no assistant. It is one page.
//
// It is the same ControlPanelApp the Navigator desktop opens in a window, mounted
// full-screen instead, which is what makes the upgrade path real rather than
// promised: the person who moves to a machine that can run an assistant keeps
// the same screens and gains the desktop around them, and nobody learns
// anything twice.

import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { ControlPanelApp } from './control-panel.jsx'
import { JotPanelSignIn } from './sign-in.jsx'
import { readPanelStorage, removePanelStorage } from './panel-storage.js'

function JotPanel() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  // A valid session goes straight to the panel. There is no boot sequence and
  // no tour, because this is a tool somebody opens to do one job.
  useEffect(() => {
    const token = readPanelStorage("jwt");
    if (!token) { setChecking(false); return; }
    const server = (readPanelStorage("server") || window.location.origin).replace(/\/$/, '');
    fetch(`${server}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => (res.ok ? res.json() : null))
      .then(me => { if (me && me.id) setUser(me); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  const signOut = () => {
    removePanelStorage("jwt");
    removePanelStorage("user");
    setUser(null);
  };

  if (checking) return <div className="panel-boot">Checking your session…</div>;
  // The sign-in screen is drawn light-on-dark. The panel itself is a light
  // working surface, so the signed-out state carries its own ground rather
  // than the login page being restyled twice.
  if (!user) return <div className="panel-signin"><JotPanelSignIn onAuth={setUser} /></div>;
  return <ControlPanelApp user={user} standalone onSignOut={signOut} />;
}

// Reuse the root across hot reloads rather than creating a second one, which
// React warns about and which only ever happens in development.
const container = document.getElementById('root');
if (!container._jotPanelRoot) container._jotPanelRoot = ReactDOM.createRoot(container);
container._jotPanelRoot.render(<JotPanel />)
