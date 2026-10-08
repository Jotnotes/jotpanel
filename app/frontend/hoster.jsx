// The entry point for host administration.
//
// Its own page and its own address rather than a window inside the customer
// panel, which is the whole point of the change: whether somebody may
// administer this machine is a question about who they are, asked of the
// server, and not a question about which part of another application they have
// managed to open.

import React from 'react'
import ReactDOM from 'react-dom/client'
import { HosterAdminApp } from './hoster-admin.jsx'

// The one place that knows `fleet-admin.jsx` exists, and it probes for it
// rather than importing it.
//
// The Fleet and Machines screens are JotNotes Navigator only, and the file
// holding them is simply not in a JotPanel bundle. A static import of an absent
// module does not degrade — it fails to resolve and the whole surface is blank
// — which is the same reason `engine-server.js` reaches its private brain with
// `try { require('./thinking/brain') } catch { brain = null }` and the same
// reason `vite.config.js` tests for `arca-webos.jsx` before naming it as a
// build input instead of listing it unconditionally.
//
// `import.meta.glob` is the build's form of that test. Where the file is
// present it compiles to a lazy loader for a chunk of its own; where it is
// absent it compiles to an empty object, with no build error and no request at
// runtime. A bare `import('./fleet-admin.jsx')` cannot be used: rollup resolves
// a literal dynamic specifier at build time and fails the JotPanel build with
// "Could not resolve ./fleet-admin.jsx", and a `@vite-ignore`d specifier would
// go the other way and ask the browser for a file that production never serves,
// breaking Navigator instead.
const found = import.meta.glob('./fleet-admin.jsx');

async function poolSections() {
  const load = found['./fleet-admin.jsx'];
  if (!load) return [];                       // JotPanel: the screens are not part of the product
  try {
    const module_ = await load();
    return module_.POOL_HOST_SECTION ? [module_.POOL_HOST_SECTION] : [];
  } catch {
    // Present but unloadable is a broken deployment, not a product boundary.
    // The host surface is still the operator's way back in, so it is drawn
    // without the pool group rather than not drawn at all.
    return [];
  }
}

// Reuse the root across hot reloads rather than creating a second one, which
// React warns about and which only ever happens in development.
const container = document.getElementById('root');
if (!container._jotpanelHosterRoot) container._jotpanelHosterRoot = ReactDOM.createRoot(container);
const root = container._jotpanelHosterRoot;

// Drawn immediately, with whatever is known now. The surface opens on "Checking
// who you are…" either way, so nothing is held back waiting for this; the pool
// group appears with the answer, as the nav already did when the server's
// `pool_host` answer arrived.
root.render(<HosterAdminApp />)
poolSections().then(extraSections => {
  if (extraSections.length) root.render(<HosterAdminApp extraSections={extraSections} />)
})
