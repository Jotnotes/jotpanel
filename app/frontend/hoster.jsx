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

// Reuse the root across hot reloads rather than creating a second one, which
// React warns about and which only ever happens in development.
const container = document.getElementById('root');
if (!container._jotpanelHosterRoot) container._jotpanelHosterRoot = ReactDOM.createRoot(container);
container._jotpanelHosterRoot.render(<HosterAdminApp />)
