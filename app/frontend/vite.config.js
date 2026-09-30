import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { existsSync } from 'fs'

// Two shells over one application.
//
//   index.html   the Arca desktop, with the assistant and windowed apps
//   panel.html   the standalone control panel, no desktop and no assistant
//   hoster.html  host administration, for the account that runs the machine
//
// Both mount the same screens, out of `control-panel.jsx`. Which one a box
// serves is decided at install time by JOTPANEL_SHELL, not by building a different
// product, and a customer bundle carries only the panel's half.
export default defineConfig({
  plugins: [react()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    // 9999 is the fixed backend port. JOTPANEL_API only exists so a second session
    // can run its own backend beside one that is already holding 9999.
    proxy: (() => {
      const api = process.env.JOTPANEL_API || process.env.ARCA_API || 'http://localhost:9999';
      // `/p` is where a public workspace file is served from. Without it a
      // customer clicking the address on their own file in dev gets a 404 from
      // vite, which reads as the feature being broken rather than as the proxy
      // not knowing about it.
      // A vite proxy key is a PREFIX, so '/p' also matches '/panel-helpers.js'
      // and '/panel.html' and sends them to the backend, which answers a JSON
      // 404 and the whole panel fails to load. A key beginning with ^ is treated
      // as a regular expression instead, which is the only way to say "the /p/
      // route and nothing else that merely starts with a p".
      return { '/api': api, '/admin': api, '/sites': api, '^/p/': api };
    })()
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      // The desktop is not in a customer bundle, so `index.html`, `main.jsx`
      // and `arca-webos.jsx` are simply absent there and the panel still has
      // to build. Naming an input that does not exist fails the whole build,
      // which on a customer's box reads as a broken installer rather than as
      // the desktop being deliberately left out.
      input: Object.assign(
        {
          panel: resolve(__dirname, 'panel.html'),
          // Always built. Host administration is part of the free panel, not
          // part of the desktop, so a customer bundle carries it too.
          hoster: resolve(__dirname, 'hoster.html'),
        },
        // The desktop is absent from customer bundles, and naming an input that
        // is not there fails the whole build. Include it only when present.
        existsSync(resolve(__dirname, 'index.html')) && existsSync(resolve(__dirname, 'arca-webos.jsx'))
          ? { main: resolve(__dirname, 'index.html') }
          : {}
      ),
      output: {
        manualChunks: undefined
      }
    }
  }
})
