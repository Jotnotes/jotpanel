// The control panel, which is the whole of the free product.
//
// Everything the standalone panel needs lives here and nothing the Arca
// desktop adds does. That is the point of the file rather than a tidy-up:
// `panel.jsx` used to import ControlPanelApp out of `arca-webos.jsx`, so
// compiling the free panel from source required the twelve-and-a-half-thousand
// line upgrade desktop to be present, and publishing the one published the
// other. Both shells import from here now and the desktop's own file is not in
// the customer bundle.
//
// It carries the screens the panel mounts as well as the panel itself: the
// files, mail and settings surfaces, and the host administration console, are
// the same components the desktop opens in a window.
//
// The desktop imports back from here rather than the other way round. Nothing
// in this file may import from `arca-webos.jsx`, and the shell test checks it.
import { APPLICATION_UI, auditRowsToCsv, filterAuditRows, filterControlActions, scheduledJobFormProblem, scheduledJobRunTone } from "./panel-helpers.js";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, setLanguage, currentLanguage, LANGUAGES, languageHeaders } from "./i18n.js";
import { readPanelStorage } from "./panel-storage.js";
import { startRecording, voiceInputSupported, serverCanListen } from "./voice-input.js";

// ── Persistence ───────────────────────────────────────────────────────────────
export const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem("aos_" + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem("aos_" + k, JSON.stringify(v)),
};
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const fmt = b => b < 1024 ? b + "B" : b < 1048576 ? (b / 1024).toFixed(1) + "KB" : (b / 1048576).toFixed(1) + "MB";
const fmtDate = d => new Date(d).toLocaleDateString([], { day: "2-digit", month: "short" });

// Familiar, self-explanatory line icons keep the hosting surfaces legible at a
// glance. They are deliberately drawn in the product rather than loaded from a
// third-party icon font, so the panel remains portable and works offline.
export function PanelIcon({ name, size = 18, color = "currentColor", strokeWidth = 1.8 }) {
  const paths = {
    panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11M6 6.5h.01M9 6.5h.01"/></>,
    overview: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3c-2.4 2.5-3.6 5.5-3.6 9s1.2 6.5 3.6 9"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
    inbox: <><path d="M4 4h16v16H4zM4 14h4l2 3h4l2-3h4"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
    document: <><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6"/></>,
    archive: <><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/></>,
    alert: <><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v4M12 17h.01"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
    folder: <><path d="M3 6h7l2 2h9v11H3z"/></>,
    jobs: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M12 13v4l3 2"/></>,
    portability: <><path d="M5 8 12 4l7 4v8l-7 4-7-4zM5 8l7 4 7-4M12 12v8"/><path d="m8 3 4-2 4 2"/></>,
    statistics: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
    usage: <><path d="M4 19h16M6 16l4-5 4 2 4-7"/><circle cx="6" cy="16" r="1"/><circle cx="10" cy="11" r="1"/><circle cx="14" cy="13" r="1"/><circle cx="18" cy="6" r="1"/></>,
    license: <><circle cx="8" cy="12" r="4"/><path d="m12 12 9-9M17 3h4v4M12 12l3 3"/></>,
    activity: <><path d="M5 5h14M5 12h14M5 19h14"/><circle cx="3" cy="5" r=".5"/><circle cx="3" cy="12" r=".5"/><circle cx="3" cy="19" r=".5"/></>,
    shield: <><path d="M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>,
    server: <><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/></>,
    storage: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.5-2.1L20 8M4 16l2.4 2.1A7 7 0 0 0 18 16"/></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5M4 20h16"/></>,
    upload: <><path d="M12 17V5M7 10l5-5 5 5M4 20h16"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    play: <path d="m8 5 11 7-11 7z"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-5 3.5-7 8-7s7.2 2 8 7"/></>,
    book: <><path d="M4 4h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v14a3 3 0 0 1 3-3h6z"/></>,
    phone: <><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 5h4M11 19h2"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name] || paths.panel}
    </svg>
  );
}

// ── OS Color tokens ───────────────────────────────────────────────────────────
// The tokens read through CSS variables so the whole chrome can be reskinned by
// repainting :root, with no React re-render (see SKINS / applySkin below).
export const OS = {
  bar:    "var(--os-bar)",     // taskbar / menu bar
  win:    "var(--os-win)",     // window body
  title:  "var(--os-title)",   // titlebar
  panel:  "var(--os-panel)",   // sidebar panels
  hover:  "var(--os-hover)",
  active: "var(--os-active)",
  border: "var(--os-border)",
  txt:    "var(--os-txt)",
  txt2:   "var(--os-txt2)",
  txt3:   "var(--os-txt3)",
  inpBg:  "var(--os-inpbg)",
};

// Interface skins — recolour the OS chrome. Kept in the dark family so the
// white-alpha surfaces layered on top stay legible; Graphite is the lightest,
// for anyone who finds Midnight too dark.
export const SKINS = {
  midnight: { get label() { return t("Midnight"); }, bar:"#10101a", win:"#14141f", title:"#0e0e18", panel:"#1a1a28", hover:"rgba(var(--os-ink),.06)", active:"rgba(var(--os-ink),.1)",  border:"rgba(var(--os-ink),.09)", txt:"rgba(var(--os-ink),.85)", txt2:"rgba(var(--os-ink),.45)", txt3:"rgba(var(--os-ink),.22)", inpbg:"rgba(var(--os-ink),.07)" },
  slate:    { get label() { return t("Slate"); },    bar:"#181d2a", win:"#1e2432", title:"#151a26", panel:"#262d3e", hover:"rgba(var(--os-ink),.06)", active:"rgba(var(--os-ink),.1)",  border:"rgba(var(--os-ink),.11)", txt:"rgba(var(--os-ink),.88)", txt2:"rgba(var(--os-ink),.5)",  txt3:"rgba(var(--os-ink),.27)", inpbg:"rgba(var(--os-ink),.07)" },
  graphite: { get label() { return t("Graphite"); }, bar:"#26262e", win:"#2f2f38", title:"#222229", panel:"#37373f", hover:"rgba(var(--os-ink),.07)", active:"rgba(var(--os-ink),.12)", border:"rgba(var(--os-ink),.13)", txt:"rgba(var(--os-ink),.92)", txt2:"rgba(var(--os-ink),.55)", txt3:"rgba(var(--os-ink),.32)", inpbg:"rgba(var(--os-ink),.08)" },
  indigo:   { get label() { return t("Indigo"); },   bar:"#161327", win:"#1c1830", title:"#131024", panel:"#251f43", hover:"rgba(var(--os-ink),.06)", active:"rgba(var(--os-ink),.1)",  border:"rgba(150,130,255,.16)", txt:"rgba(var(--os-ink),.87)", txt2:"rgba(205,195,255,.5)",  txt3:"rgba(205,195,255,.28)", inpbg:"rgba(var(--os-ink),.07)" },
};
export function applySkin(name) {
  if (typeof document === "undefined") return;
  const s = SKINS[name] || SKINS.midnight;
  const r = document.documentElement.style;
  r.setProperty("--os-bar", s.bar);     r.setProperty("--os-win", s.win);
  r.setProperty("--os-title", s.title); r.setProperty("--os-panel", s.panel);
  r.setProperty("--os-hover", s.hover); r.setProperty("--os-active", s.active);
  r.setProperty("--os-border", s.border); r.setProperty("--os-txt", s.txt);
  r.setProperty("--os-txt2", s.txt2);   r.setProperty("--os-txt3", s.txt3);
  r.setProperty("--os-inpbg", s.inpbg);
  // The ink every translucent layer is mixed from. On the desktop that is
  // white over a dark ground; in the light standalone panel the same layers
  // have to be mixed from dark ink over a light ground, and every
  // rgba(var(--os-ink),…) in this file follows whichever shell it lands in.
  r.setProperty("--os-ink", "255,255,255");
  // Accent and danger are skin-independent, and they are variables rather
  // than literals for one reason: the same components are mounted inside the
  // light standalone panel, where a pale-blue-on-dark button is unreadable.
  // The values here are exactly what was hardcoded before, so the desktop is
  // unchanged; only the shell that overrides them sees anything different.
  r.setProperty("--os-accent-bg", "rgba(74,124,247,.25)");
  r.setProperty("--os-accent-border", "rgba(74,124,247,.4)");
  r.setProperty("--os-accent-txt", "#93c5fd");
  r.setProperty("--os-accent-soft", "rgba(74,124,247,.1)");
  r.setProperty("--os-danger-bg", "rgba(220,38,38,.15)");
  r.setProperty("--os-danger-border", "rgba(220,38,38,.3)");
  r.setProperty("--os-danger-txt", "#f87171");
}
if (typeof document !== "undefined") { try { applySkin(localStorage.getItem("aos_skin") || "midnight"); } catch {} }

// Button helper. Takes its colours from whichever shell it is mounted in, so
// the same call renders light inside the standalone panel and dark on the
// desktop without a second component existing.
export const dBtn = (primary, danger) => ({
  padding: "5px 12px", borderRadius: 5, fontSize: 12, fontWeight: 500,
  cursor: "pointer", fontFamily: "inherit",
  display: "inline-flex", alignItems: "center", gap: 5,
  background: danger ? "var(--os-danger-bg)" : primary ? "var(--os-accent-bg)" : OS.hover,
  border: `1px solid ${danger ? "var(--os-danger-border)" : primary ? "var(--os-accent-border)" : OS.border}`,
  color: danger ? "var(--os-danger-txt)" : primary ? "var(--os-accent-txt)" : OS.txt,
  transition: "all .1s",
});

// ── App Content: Files ────────────────────────────────────────────────────────
// ── IndexedDB helpers for FilesApp ────────────────────────────────────────────
const FILES_DB = (() => {
  let db = null;
  const migrateLegacy = target => new Promise(resolve => {
    try {
      if (localStorage.getItem("jotpanel_files_migrated") === "1") return resolve();
      const legacy = indexedDB.open("arca_files", 1);
      legacy.onupgradeneeded = event => {
        if (event.oldVersion === 0) event.target.transaction.abort();
      };
      legacy.onerror = () => { localStorage.setItem("jotpanel_files_migrated", "1"); resolve(); };
      legacy.onsuccess = event => {
        const oldDb = event.target.result;
        if (!oldDb.objectStoreNames.contains("files")) { oldDb.close(); localStorage.setItem("jotpanel_files_migrated", "1"); return resolve(); }
        const read = oldDb.transaction("files", "readonly").objectStore("files").getAll();
        read.onerror = () => { oldDb.close(); resolve(); };
        read.onsuccess = () => {
          const items = read.result || [];
          if (!items.length) { oldDb.close(); localStorage.setItem("jotpanel_files_migrated", "1"); return resolve(); }
          const write = target.transaction("files", "readwrite");
          for (const item of items) write.objectStore("files").put(item);
          write.oncomplete = () => { oldDb.close(); localStorage.setItem("jotpanel_files_migrated", "1"); resolve(); };
          write.onerror = () => { oldDb.close(); resolve(); };
        };
      };
    } catch { resolve(); }
  });
  const open = () => new Promise((res, rej) => {
    if (db) return res(db);
    const r = indexedDB.open("jotpanel_files", 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore("files", { keyPath: "id" });
    r.onsuccess = async e => { db = e.target.result; await migrateLegacy(db); res(db); };
    r.onerror = rej;
  });
  return {
    getAll: async () => {
      const d = await open();
      return new Promise((res, rej) => {
        const r = d.transaction("files","readonly").objectStore("files").getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = rej;
      });
    },
    put: async (item) => {
      const d = await open();
      return new Promise((res, rej) => {
        const r = d.transaction("files","readwrite").objectStore("files").put(item);
        r.onsuccess = res; r.onerror = rej;
      });
    },
    del: async (id) => {
      const d = await open();
      return new Promise((res, rej) => {
        const r = d.transaction("files","readwrite").objectStore("files").delete(id);
        r.onsuccess = res; r.onerror = rej;
      });
    },
  };
})();

function LocalFilesApp({ filter }) {
  const [files, setFiles]   = useState([]);
  const [selId, setSelId]   = useState(null);
  const [over, setOver]     = useState(false);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef();

  // Load from IndexedDB on mount
  useEffect(() => {
    FILES_DB.getAll().then(f => { setFiles(f); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleFiles = async (rawFiles) => {
    for (const f of rawFiles) {
      const reader = new FileReader();
      const dataUrl = await new Promise(res => { reader.onload = e => res(e.target.result); reader.readAsDataURL(f); });
      const item = { id: uid(), name: f.name, size: f.size, type: f.type, added: new Date().toISOString(), dataUrl };
      await FILES_DB.put(item);
      setFiles(prev => [...prev, item]);
    }
  };

  const drop = e => { e.preventDefault(); setOver(false); handleFiles(Array.from(e.dataTransfer.files)); };

  const del = async id => {
    if (!confirm(t("Delete?"))) return;
    await FILES_DB.del(id);
    setFiles(prev => prev.filter(f => f.id !== id));
    if (selId === id) setSelId(null);
  };

  const dl = f => { const a = document.createElement("a"); a.href = f.dataUrl; a.download = f.name; a.click(); };

  const FICONS = { "image/": "🖼️", "video/": "🎬", "audio/": "🎵", "application/pdf": "📕", "text/": "📝" };
  const icon = f => Object.entries(FICONS).find(([k]) => f.type?.startsWith(k))?.[1] ?? "📎";

  const shown = filter === "photos" ? files.filter(f => f.type?.startsWith("image/"))
              : filter === "docs"   ? files.filter(f => !f.type?.startsWith("image/") && !f.type?.startsWith("video/") && !f.type?.startsWith("audio/"))
              : files;
  const sel = files.find(f => f.id === selId);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Toolbar */}
        <div style={{ display: "flex", gap: 7, padding: "8px 12px", borderBottom: `1px solid ${OS.border}`, background: OS.hover, flexShrink: 0 }}>
          <input ref={inputRef} type="file" multiple style={{ display: "none" }} onChange={e => handleFiles(Array.from(e.target.files))} />
          <button onClick={() => inputRef.current.click()} style={btnS(true)}>{t("↑ Upload")}</button>
          {selId && <button onClick={() => del(selId)} style={{ ...btnS(), color: "#dc2626", borderColor: "rgba(220,38,38,.2)", background: "rgba(220,38,38,.07)" }}>{t("🗑 Delete")}</button>}
          {sel && <button onClick={() => dl(sel)} style={btnS()}>{t("⬇ Download")}</button>}
          <span style={{ marginLeft: "auto", fontSize: 11, color: OS.txt3, alignSelf: "center" }}>
            {loading ? t("Loading…") : (shown.length !== 1 ? t("{count} files", { count: shown.length }) : t("{count} file", { count: shown.length }))}
          </span>
        </div>
        {/* Drop zone */}
        <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
          style={{ flex: 1, overflowY: "auto", padding: 8, background: over ? "rgba(74,124,247,.06)" : "transparent", transition: "background .15s" }}>
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: OS.txt3, fontSize: 13 }}>{t("Loading…")}</div>
          ) : shown.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: OS.txt3 }}>
              <div style={{ fontSize: 40, opacity: .25 }}>📭</div>
              <div style={{ fontSize: 13 }}>{over ? t("Drop files here") : t("No files — drag & drop or click Upload")}</div>
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 90px 28px", padding: "6px 10px", fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: OS.txt3, borderBottom: `1px solid ${OS.border}` }}>
                <span>{t("Name")}</span><span style={{ textAlign: "right" }}>{t("Size")}</span><span style={{ textAlign: "right" }}>{t("Date")}</span><span />
              </div>
              {shown.map(f => (
                <div key={f.id} onClick={() => setSelId(f.id === selId ? null : f.id)}
                  style={{ display: "grid", gridTemplateColumns: "1fr 80px 90px 28px", alignItems: "center", padding: "7px 10px", borderRadius: 5, cursor: "pointer", background: selId === f.id ? "rgba(74,124,247,.1)" : "transparent", transition: "background .1s" }}
                  onMouseEnter={e => { if (selId !== f.id) e.currentTarget.style.background = OS.hover; }}
                  onMouseLeave={e => { if (selId !== f.id) e.currentTarget.style.background = "transparent"; }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500, overflow: "hidden", color: OS.txt }}>
                    {f.type?.startsWith("image/") && f.dataUrl
                      ? <img src={f.dataUrl} style={{ width: 20, height: 20, borderRadius: 3, objectFit: "cover", border: `1px solid ${OS.border}` }} />
                      : <span style={{ fontSize: 16 }}>{icon(f)}</span>}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: OS.txt3, textAlign: "right" }}>{fmt(f.size)}</div>
                  <div style={{ fontSize: 11, color: OS.txt3, textAlign: "right" }}>{fmtDate(f.added)}</div>
                  <button onClick={e => { e.stopPropagation(); del(f.id); }} style={{ background: "none", border: "none", cursor: "pointer", color: OS.txt3, fontSize: 12, padding: 2, borderRadius: 3 }}
                    onMouseEnter={e => e.currentTarget.style.color = "#dc2626"} onMouseLeave={e => e.currentTarget.style.color = OS.txt3}>✕</button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      {/* Preview panel */}
      {sel && (
        <div style={{ width: 210, borderLeft: `1px solid ${OS.border}`, background: OS.panel, padding: 12, flexShrink: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {sel.type?.startsWith("image/")
            ? <img src={sel.dataUrl} style={{ width: "100%", borderRadius: 6, border: `1px solid ${OS.border}` }} />
            : <div style={{ width: "100%", height: 80, background: OS.hover, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32 }}>{icon(sel)}</div>}
          <div style={{ fontSize: 12, fontWeight: 600, wordBreak: "break-word", color: OS.txt }}>{sel.name}</div>
          <div style={{ fontSize: 11, color: OS.txt3 }}>{fmt(sel.size)}</div>
          <div style={{ fontSize: 11, color: OS.txt3 }}>{fmtDate(sel.added)}</div>
          {sel.type?.startsWith("audio/") && <audio controls src={sel.dataUrl} style={{ width: "100%", marginTop: 4 }} />}
          {sel.type?.startsWith("video/") && <video controls src={sel.dataUrl} style={{ width: "100%", marginTop: 4, borderRadius: 4 }} />}
          <button onClick={() => dl(sel)} style={{ ...btnS(true), justifyContent: "center" }}>{t("⬇ Download")}</button>
        </div>
      )}
    </div>
  );
}

// Share links deliberately stop at one boundary until the signed-link routes
// land. Changing this flag is the one-line wiring point. No screen fabricates a
// link or claims a send succeeded while the server cannot do either one.
const FILE_SHARE_ROUTES_READY = false;

async function serverFileRequest(server, jwt, route, options = {}) {
  const response = await fetch(server + route, {
    ...options,
    headers: { Authorization: "Bearer " + jwt, ...languageHeaders(), ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = null; }
  if (!response.ok) throw new Error(body?.error || text || t("Request failed ({status}).", { status: response.status }));
  return body;
}

async function serverShareRequest(server, jwt, fileId, action, payload) {
  if (!FILE_SHARE_ROUTES_READY) throw new Error(t("Share links are not available yet."));
  const route = "/api/files/" + fileId + (action === "unshare" ? "/unshare" : "/share");
  return serverFileRequest(server, jwt, route, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...languageHeaders() },
    body: JSON.stringify(payload || {}),
  });
}

function ServerFilesApp({ filter, server, jwt }) {
  const [files, setFiles] = useState([]);
  const [view, setView] = useState("private");
  const [folder, setFolder] = useState("root");
  const [selId, setSelId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState(null);
  const [shareFile, setShareFile] = useState(null);
  const [shareRole, setShareRole] = useState("view");
  const [shareExpiry, setShareExpiry] = useState("7d");
  const [sharePassword, setSharePassword] = useState("");
  const [shareEmail, setShareEmail] = useState("");
  const [shareLink, setShareLink] = useState("");
  const [shareError, setShareError] = useState("");
  const inputRef = useRef();

  const normalize = useCallback(row => ({
    ...row,
    type: row.mime || row.type || "",
    added: row.added_at || row.added,
    // The server calls it `place`, which is the word the design and the API
    // contract use. It is carried as `state` inside this component because that
    // is what the rest of it reads, and the mapping is done once, here, rather
    // than by teaching both halves to accept either name. Two names for one
    // thing is how a screen ends up showing private against a public file.
    state: row.place || row.state || "private",
    public_url: row.public_url || null,
    deleted_at: row.deleted_at || null,
  }), []);

  const loadFiles = useCallback(async () => {
    const rows = await serverFileRequest(server, jwt, "/api/files");
    if (!Array.isArray(rows)) throw new Error(t("The server did not return a file list."));
    setFiles(rows.map(normalize));
  }, [server, jwt, normalize]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadFiles()
      .catch(error => { if (alive) setNotice(error.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [loadFiles]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const placeOf = useCallback(file => file?.deleted_at ? "trash"
    : file?.state === "public" ? "public"
    : file?.state === "shared" ? "shared"
    : "private", []);

  const selected = files.find(file => file.id === selId) || null;
  const selectedPlace = placeOf(selected);

  const mutate = useCallback(async (file, work) => {
    if (!file || busy[file.id]) return;
    setBusy(current => ({ ...current, [file.id]: true }));
    setErrors(current => ({ ...current, [file.id]: "" }));
    setNotice("");
    try {
      await work();
    } catch (error) {
      setErrors(current => ({ ...current, [file.id]: error.message }));
    } finally {
      try { await loadFiles(); }
      catch (error) { setNotice(error.message); }
      setBusy(current => {
        const next = { ...current };
        delete next[file.id];
        return next;
      });
    }
  }, [busy, loadFiles]);

  const openShare = file => {
    if (!file || placeOf(file) === "trash") return;
    setShareFile(file);
    setShareRole("view");
    setShareExpiry("7d");
    setSharePassword("");
    setShareEmail("");
    setShareLink(file.share_url || "");
    setShareError("");
    setMenu(null);
  };

  const createShare = async send => {
    if (!shareFile) return;
    setShareError("");
    try {
      const result = await serverShareRequest(server, jwt, shareFile.id, "share", {
        role: shareRole,
        expires_in: shareExpiry,
        password: sharePassword || undefined,
        email: send ? shareEmail : undefined,
      });
      setShareLink(result?.share_url || result?.url || "");
      await loadFiles();
    } catch (error) {
      setShareError(error.message);
    }
  };

  const stopShare = file => mutate(file, async () => {
    await serverShareRequest(server, jwt, file.id, "unshare");
  });

  const moveTo = (file, target) => {
    if (!file || busy[file.id]) return;
    const from = placeOf(file);
    if (target === from) return;
    if (target === "shared") return openShare(file);
    if (target === "private" && from === "shared") return stopShare(file);
    const route = target === "public" ? "/api/files/" + file.id + "/public"
      : target === "private" && from === "trash" ? "/api/files/" + file.id + "/restore"
      : target === "private" ? "/api/files/" + file.id + "/private"
      : target === "trash" ? "/api/files/" + file.id
      : null;
    if (!route) return;
    return mutate(file, () => serverFileRequest(server, jwt, route, {
      method: target === "trash" ? "DELETE" : "POST",
    }));
  };

  const emptyTrash = async () => {
    if (!confirm(t("Empty Trash? This cannot be undone."))) return;
    setNotice("");
    try {
      const result = await serverFileRequest(server, jwt, "/api/files/trash/empty", { method: "POST" });
      setNotice(result.kept
        ? t("{removed} permanently deleted; {kept} kept.", { removed: result.removed || 0, kept: result.kept })
        : result.removed === 1 ? t("1 file permanently deleted.") : t("{count} files permanently deleted.", { count: result.removed || 0 }));
      setSelId(null);
      await loadFiles();
    } catch (error) {
      setNotice(error.message);
    }
  };

  const uploadFiles = async rawFiles => {
    if (!rawFiles.length) return;
    const form = new FormData();
    rawFiles.forEach(file => form.append("files", file));
    form.append("folder", "root");
    setUploading(true);
    setNotice("");
    try {
      await serverFileRequest(server, jwt, "/api/files", { method: "POST", body: form });
      setView("private");
      setFolder("root");
      await loadFiles();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const download = file => {
    fetch(server + "/api/files/" + file.id + "/download", {
      headers: { Authorization: "Bearer " + jwt, ...languageHeaders() },
    }).then(async response => {
      if (!response.ok) {
        let sentence = t("That file could not be downloaded.");
        try { sentence = (await response.json()).error || sentence; } catch {}
        throw new Error(sentence);
      }
      return response.blob();
    }).then(blob => {
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = file.name;
      anchor.click();
      URL.revokeObjectURL(href);
    }).catch(error => setErrors(current => ({ ...current, [file.id]: error.message })));
  };

  const copyText = async text => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t("Copied."));
    } catch {
      setNotice(t("Copy failed."));
    }
  };

  useEffect(() => {
    const onKey = event => {
      if (event.key !== "Delete" || !selected || shareFile || busy[selected.id]) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
      event.preventDefault();
      moveTo(selected, selectedPlace === "trash" ? "private" : "trash");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, selectedPlace, shareFile, busy]);

  const folders = [...new Set(files
    .filter(file => placeOf(file) === "private")
    .map(file => file.folder || "root"))].sort();
  const visible = files.filter(file => {
    if (placeOf(file) !== view) return false;
    if (view === "private" && (file.folder || "root") !== folder) return false;
    if (filter === "photos") return file.type?.startsWith("image/");
    if (filter === "docs") return !file.type?.startsWith("image/") &&
      !file.type?.startsWith("video/") && !file.type?.startsWith("audio/");
    return true;
  });

  const FICONS = {
    "image/": "🖼️", "video/": "🎬", "audio/": "🎵",
    "application/pdf": "📕", "text/": "📝",
  };
  const icon = file => Object.entries(FICONS)
    .find(([kind]) => file.type?.startsWith(kind))?.[1] ?? "📎";
  const PLACE_META = [
    ["private", "🗂", t("My Files")],
    ["public", "🌐", t("Public")],
    ["shared", "🔗", t("Shared")],
    ["trash", "🗑", t("Trash")],
  ];

  const dropOnPlace = (event, target) => {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/jotpanel-file") || event.dataTransfer.getData("text/arca-file");
    const file = files.find(item => item.id === id);
    if (file) moveTo(file, target);
  };

  const contextItems = file => {
    const place = placeOf(file);
    if (place === "trash") return [[t("Restore"), () => moveTo(file, "private")]];
    return [
      [place === "public" ? t("Make private") : t("Make public"),
        () => moveTo(file, place === "public" ? "private" : "public")],
      [place === "shared" ? t("Stop sharing") : t("Share"),
        () => place === "shared" ? stopShare(file) : openShare(file)],
      [t("Download"), () => download(file)],
      [t("Move to Trash"), () => moveTo(file, "trash")],
    ];
  };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden", background: OS.win, color: OS.txt }}>
      <div style={{ width: 154, padding: 8, borderRight: "1px solid " + OS.border, background: OS.panel, flexShrink: 0 }}>
        {PLACE_META.map(([key, symbol, label]) => (
          <Fragment key={key}>
            <button
              onClick={() => { setView(key); setSelId(null); if (key === "private") setFolder("root"); }}
              onDragOver={event => event.preventDefault()}
              onDrop={event => dropOnPlace(event, key)}
              onContextMenu={event => {
                if (key === "trash") {
                  event.preventDefault();
                  setMenu({ trash: true, x: event.clientX, y: event.clientY });
                }
              }}
              style={{ ...dBtn(), width: "100%", justifyContent: "flex-start", marginBottom: 4,
                background: view === key ? OS.active : OS.hover, color: OS.txt }}
            >
              <span>{symbol}</span><span>{label}</span>
              <span style={{ marginLeft: "auto", color: OS.txt3 }}>
                {files.filter(file => placeOf(file) === key).length}
              </span>
            </button>
            {key === "private" && view === "private" &&
              folders.filter(name => name !== "root").map(name => (
                <button key={name} onClick={() => { setFolder(name); setSelId(null); }}
                  style={{ ...dBtn(), width: "100%", justifyContent: "flex-start", marginBottom: 3,
                    paddingLeft: 24, background: folder === name ? OS.active : OS.panel, color: OS.txt2 }}>
                  📁 <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                </button>
              ))}
          </Fragment>
        ))}
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 7, padding: "8px 12px",
          borderBottom: "1px solid " + OS.border, background: OS.panel, flexShrink: 0, flexWrap: "wrap" }}>
          <input ref={inputRef} type="file" multiple style={{ display: "none" }}
            onChange={event => uploadFiles(Array.from(event.target.files || []))} />
          <button onClick={() => inputRef.current?.click()} disabled={uploading} style={btnS(true)}>
            {uploading ? t("Uploading…") : t("↑ Upload")}
          </button>
          {selected && selectedPlace !== "trash" &&
            <button onClick={() => moveTo(selected, selectedPlace === "public" ? "private" : "public")}
              disabled={!!busy[selected.id]} style={btnS()}>
              {selectedPlace === "public" ? t("🗂 Make private") : t("🌐 Make public")}
            </button>}
          {selected && selectedPlace !== "trash" &&
            <button onClick={() => selectedPlace === "shared" ? stopShare(selected) : openShare(selected)}
              disabled={!!busy[selected.id]} style={btnS()}>
              {selectedPlace === "shared" ? t("Stop sharing") : t("🔗 Share")}
            </button>}
          {selected && selectedPlace !== "trash" &&
            <button onClick={() => moveTo(selected, "trash")} disabled={!!busy[selected.id]}
              style={dBtn(false, true)}>{t("🗑 Trash")}</button>}
          {selected && selectedPlace === "trash" &&
            <button onClick={() => moveTo(selected, "private")} disabled={!!busy[selected.id]}
              style={btnS()}>{t("↩ Restore")}</button>}
          {selected &&
            <button onClick={() => download(selected)} disabled={!!busy[selected.id]}
              style={btnS()}>{t("⬇ Download")}</button>}
          {view === "trash" &&
            <button onClick={emptyTrash} style={dBtn(false, true)}>{t("Empty Trash")}</button>}
          <span style={{ marginLeft: "auto", fontSize: 11, color: OS.txt3, alignSelf: "center" }}>
            {loading ? t("Loading…") : visible.length === 1 ? t("1 file") : t("{count} files", { count: visible.length })}
          </span>
        </div>

        {notice && <div style={{ padding: "6px 12px", borderBottom: "1px solid " + OS.border,
          color: OS.txt2, fontSize: 11 }}>{notice}</div>}

        <div
          onDragOver={event => {
            event.preventDefault();
            if (!["text/jotpanel-file", "text/arca-file"].some(type => Array.from(event.dataTransfer.types || []).includes(type))) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={event => {
            event.preventDefault();
            setOver(false);
            if (event.dataTransfer.getData("text/jotpanel-file") || event.dataTransfer.getData("text/arca-file")) return;
            uploadFiles(Array.from(event.dataTransfer.files || []));
          }}
          style={{ flex: 1, overflowY: "auto", padding: 8, background: over ? OS.active : OS.win }}
        >
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
              height: "100%", color: OS.txt3 }}>{t("Loading…")}</div>
          ) : visible.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", height: "100%", gap: 10, color: OS.txt3 }}>
              <div style={{ fontSize: 40, opacity: .25 }}>📭</div>
              <div style={{ fontSize: 13 }}>{over ? t("Drop files here") :
                t("Nothing in {folder}.", { folder: PLACE_META.find(place => place[0] === view)?.[2] || t("this folder") })}</div>
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 90px",
                padding: "6px 10px", fontSize: 10, fontWeight: 700, letterSpacing: ".06em",
                textTransform: "uppercase", color: OS.txt3, borderBottom: "1px solid " + OS.border }}>
                <span>{t("Name")}</span><span style={{ textAlign: "right" }}>{t("Size")}</span>
                <span style={{ textAlign: "right" }}>{t("Date")}</span>
              </div>
              {visible.map(file => (
                <div key={file.id} draggable={!busy[file.id]}
                  onDragStart={event => event.dataTransfer.setData("text/jotpanel-file", file.id)}
                  onClick={() => !busy[file.id] && setSelId(file.id === selId ? null : file.id)}
                  onContextMenu={event => {
                    event.preventDefault();
                    if (!busy[file.id]) {
                      setSelId(file.id);
                      setMenu({ file, x: event.clientX, y: event.clientY });
                    }
                  }}
                  style={{ display: "grid", gridTemplateColumns: "1fr 80px 90px",
                    alignItems: "center", padding: "7px 10px", borderRadius: 5,
                    cursor: busy[file.id] ? "wait" : "pointer",
                    background: selId === file.id ? OS.active : OS.win,
                    opacity: view === "trash" ? .55 : 1 }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8,
                      fontSize: 13, fontWeight: 500, color: OS.txt, minWidth: 0 }}>
                      <span style={{ fontSize: 16 }}>{busy[file.id] ? "◌" : icon(file)}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
                      {view === "public" && <span title={t("Public")}>🌐</span>}
                      {view === "shared" && <span title={t("Shared")}>🔗</span>}
                    </div>
                    {view === "public" && file.public_url &&
                      <div style={{ display: "flex", gap: 6, alignItems: "center",
                        marginLeft: 24, marginTop: 3, minWidth: 0 }}>
                        <a href={file.public_url} target="_blank" rel="noreferrer"
                          style={{ color: OS.txt2, fontSize: 10, overflow: "hidden",
                            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.public_url}</a>
                        <button onClick={event => { event.stopPropagation(); copyText(file.public_url); }}
                          style={{ ...dBtn(), padding: "2px 6px", fontSize: 10 }}>{t("Copy")}</button>
                      </div>}
                    {view === "shared" &&
                      <div style={{ marginLeft: 24, marginTop: 3, color: OS.txt3, fontSize: 10 }}>
                        {file.share_role || t("View")}
                        {file.share_expires_at ? " · expires " + fmtDate(file.share_expires_at) : t(" · no expiry")}
                      </div>}
                    {view === "trash" &&
                      <div style={{ marginLeft: 24, marginTop: 3, color: OS.txt3, fontSize: 10 }}>{t("Deleted ")}{fmtDate(file.deleted_at)}
                      </div>}
                    {errors[file.id] &&
                      <div style={{ marginLeft: 24, marginTop: 3,
                        color: "var(--os-danger-txt)", fontSize: 10 }}>{errors[file.id]}</div>}
                  </div>
                  <div style={{ fontSize: 11, color: OS.txt3, textAlign: "right" }}>{fmt(file.size || 0)}</div>
                  <div style={{ fontSize: 11, color: OS.txt3, textAlign: "right" }}>{fmtDate(file.added)}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {menu &&
        <div onClick={event => event.stopPropagation()}
          style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 10000,
            minWidth: 150, padding: 5, border: "1px solid " + OS.border, borderRadius: 6,
            background: OS.panel, boxShadow: "0 8px 24px rgba(0,0,0,.28)" }}>
          {(menu.trash ? [[t("Empty Trash"), emptyTrash]] : contextItems(menu.file)).map(([label, action]) =>
            <button key={label} onClick={() => { setMenu(null); action(); }}
              style={{ ...dBtn(), width: "100%", justifyContent: "flex-start", marginBottom: 3 }}>
              {label}
            </button>)}
        </div>}

      {shareFile &&
        <div onMouseDown={() => setShareFile(null)}
          style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.55)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onMouseDown={event => event.stopPropagation()}
            style={{ width: 520, maxWidth: "100%", padding: 18, borderRadius: 9,
              border: "1px solid " + OS.border, background: OS.win, color: OS.txt,
              boxShadow: "0 18px 55px rgba(0,0,0,.4)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{t("Share “{name}”", { name: shareFile.name })}</div>
              <button onClick={() => setShareFile(null)} style={dBtn()}>×</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 210px",
              gap: 10, alignItems: "center", fontSize: 12 }}>
              <label>{t("Anyone with the link can")}</label>
              <select value={shareRole} onChange={event => setShareRole(event.target.value)}
                style={{ padding: 7, borderRadius: 5, border: "1px solid " + OS.border,
                  background: OS.inpBg, color: OS.txt }}>
                <option value="view">{t("View")}</option>
                <option value="download">{t("View and download")}</option>
                <option value="edit">{t("Edit")}</option>
              </select>
              <label>{t("Link expires")}</label>
              <select value={shareExpiry} onChange={event => setShareExpiry(event.target.value)}
                style={{ padding: 7, borderRadius: 5, border: "1px solid " + OS.border,
                  background: OS.inpBg, color: OS.txt }}>
                <option value="1d">{t("In 1 day")}</option>
                <option value="7d">{t("In 7 days")}</option>
                <option value="30d">{t("In 30 days")}</option>
                <option value="never">{t("Never")}</option>
              </select>
              <label>{t("Password")}</label>
              <input value={sharePassword} onChange={event => setSharePassword(event.target.value)}
                placeholder={t("optional")} type="password"
                style={{ padding: 7, borderRadius: 5, border: "1px solid " + OS.border,
                  background: OS.inpBg, color: OS.txt }} />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <input readOnly value={shareLink} placeholder={t("A signed link will appear here")}
                style={{ flex: 1, padding: 7, borderRadius: 5, border: "1px solid " + OS.border,
                  background: OS.inpBg, color: OS.txt }} />
              <button disabled={!shareLink} onClick={() => copyText(shareLink)} style={dBtn()}>{t("Copy")}</button>
              <button onClick={() => createShare(false)} style={dBtn(true)}>{t("Create link")}</button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <span style={{ alignSelf: "center", fontSize: 12, color: OS.txt2 }}>{t("Or send it")}</span>
              <input value={shareEmail} onChange={event => setShareEmail(event.target.value)}
                placeholder={t("email address")} type="email"
                style={{ flex: 1, padding: 7, borderRadius: 5, border: "1px solid " + OS.border,
                  background: OS.inpBg, color: OS.txt }} />
              <button onClick={() => createShare(true)} style={dBtn()}>{t("Send")}</button>
            </div>
            {shareError &&
              <div style={{ marginTop: 10, fontSize: 11,
                color: "var(--os-danger-txt)" }}>{shareError}</div>}
          </div>
        </div>}
    </div>
  );
}

export function FilesApp({ filter }) {
  const server = typeof localStorage !== "undefined" ? readPanelStorage("server") : null;
  const jwt = typeof localStorage !== "undefined" ? readPanelStorage("jwt") : null;
  return server && jwt
    ? <ServerFilesApp filter={filter} server={server.replace(/\/+$/, "")} jwt={jwt} />
    : <LocalFilesApp filter={filter} />;
}

// ── App Content: Settings ─────────────────────────────────────────────────────
export function SettingsApp({ onInstall, onUninstall, installed, standalone = false, desktopSections = null }) {
  const [section, setSection] = useState("apis");
  const [vals, setVals] = useState(() => LS.get("settings", { name: "", email: "", domain: "" }));
  const [saved, setSaved] = useState(false);
  const upd = k => e => setVals(v => ({ ...v, [k]: e.target.value }));
  const save = () => { LS.set("settings", vals); setSaved(true); setTimeout(() => setSaved(false), 2200); };

  // Two of these only mean anything when there is a desktop. Installing an app
  // needs a launcher to install it into, and the skins recolour window chrome
  // that the standalone panel does not have. They are absent there rather than
  // present and inert, which is the same rule the tool grid follows.
  //
  // They are handed in rather than written here, and that is what keeps them
  // out of the free panel's source: a branch naming the appearance screen makes
  // that screen, the theme table and the Resident's voice part of everything
  // the panel has to ship, for two sections the panel never draws. The desktop
  // passes them; nothing else does, and a section nobody passed is not listed
  // rather than listed and blank.
  const NAV = [
    { id: "apis",       icon: "🔑", label: t("AI Connections") },
    { id: "account",    icon: "👤", label: t("Account") },
    { id: "hosting",    icon: "🌐", label: t("Hosting") },
    { id: "appearance", icon: "🎨", label: t("Appearance"), desktopOnly: true },
    { id: "byog",       icon: "🖥", label: t("My Computer"), desktopOnly: true },
    { id: "routing",    icon: "🔀", label: t("AI Routing") },
    { id: "projects",   icon: "◫",  label: t("Projects") },
    { id: "apps",       icon: "⊞",  label: t("Installed Apps"), desktopOnly: true },
    { id: "privacy",    icon: "🔒", label: t("Privacy") },
  ].filter(n => !(n.desktopOnly && (standalone || !desktopSections?.[n.id])));

  const inpD = { width: "100%", padding: "7px 10px", background: OS.inpBg, border: `1px solid ${OS.border}`, borderRadius: 5, fontSize: 12, color: OS.txt, fontFamily: "inherit", outline: "none" };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden", background: OS.win, color: OS.txt, fontFamily: "inherit" }}>

      {/* Sidebar */}
      <div style={{ width: 196, borderRight: `1px solid ${OS.border}`, display: "flex", flexDirection: "column", flexShrink: 0, background: OS.panel }}>
        <div style={{ padding: "18px 16px 12px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: OS.txt3 }}>{t("Settings")}</div>
        </div>
        {NAV.map(n => (
          <div key={n.id} onClick={() => setSection(n.id)}
            style={{
              display: "flex", alignItems: "center", gap: 11, padding: "9px 14px", cursor: "pointer",
              borderRadius: 9, margin: "1px 8px",
              background: section === n.id ? "rgba(var(--os-ink),.1)" : "transparent",
              color: section === n.id ? OS.txt : OS.txt2,
              transition: "all .13s",
              fontSize: 13, fontWeight: section === n.id ? 600 : 400,
            }}
            onMouseEnter={e => { if (section !== n.id) e.currentTarget.style.background = "rgba(var(--os-ink),.05)"; e.currentTarget.style.color = "rgba(var(--os-ink),.75)"; }}
            onMouseLeave={e => { if (section !== n.id) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(var(--os-ink),.42)"; } }}
          >
            <span style={{ fontSize: 16, width: 22, textAlign: "center" }}>{n.icon}</span>
            {n.label}
          </div>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>

        {/* ── AI Connections ── */}
        {section === "apis" && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{t("AI Connections")}</div>
              <div style={{ fontSize: 13, color: "rgba(var(--os-ink),.4)", lineHeight: 1.45 }}>{t("Add the AI key Echo should use and press Set as Primary. If that provider fails, the next connected one answers. Keys stay on this server.")}</div>
            </div>
            <APIKeyManager />
          </>
        )}

        {/* ── Account ── */}
        {section === "account" && (
          <>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>{t("Account")}</div>
            <div style={{ display: "flex", gap: 20, marginBottom: 24 }}>
              <div style={{ width: 72, height: 72, borderRadius: "50%", background: "linear-gradient(135deg,#4a7cf7,#7c5cbf)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, flexShrink: 0 }}>
                {vals.name ? vals.name[0].toUpperCase() : "?"}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{vals.name || t("Your name")}</div>
                <div style={{ fontSize: 13, color: "rgba(var(--os-ink),.35)" }}>{vals.email || "your@email.com"}</div>
              </div>
            </div>
            {[
              { label: t("Display name"), key: "name", placeholder: t("Your name") },
              { label: t("Email"), key: "email", placeholder: "you@example.com", type: "email" },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 14 }}>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "rgba(var(--os-ink),.35)", letterSpacing: ".07em", textTransform: "uppercase", marginBottom: 7 }}>{f.label}</label>
                <input value={vals[f.key] || ""} onChange={upd(f.key)} type={f.type || "text"} placeholder={f.placeholder}
                  style={inpD}
                  onFocus={e => e.target.style.borderColor = "#4a7cf7"}
                  onBlur={e => e.target.style.borderColor = "rgba(var(--os-ink),.1)"} />
              </div>
            ))}
            <button onClick={save} style={{ padding: "6px 18px", borderRadius: 5, background: saved ? "#22c55e" : "rgba(74,124,247,.25)", border: `1px solid ${saved ? "#22c55e" : "rgba(74,124,247,.5)"}`, color: OS.txt, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", marginTop: 8, transition: "background .3s" }}>
              {saved ? t("✓ Saved") : t("Save changes")}
            </button>
          </>
        )}

        {/* ── Hosting ── */}
        {section === "hosting" && (
          <>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>{t("Hosting")}</div>
            <div style={{ padding: "16px 18px", background: "rgba(74,124,247,.1)", border: "1px solid rgba(74,124,247,.25)", borderRadius: 12, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#93c5fd", marginBottom: 4 }}>{t("Your live domain")}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: OS.txt }}>{vals.domain || "panel.example.com"}</div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "rgba(var(--os-ink),.35)", letterSpacing: ".07em", textTransform: "uppercase", marginBottom: 7 }}>{t("Subdomain")}</label>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input value={vals.domain || ""} onChange={upd("domain")} placeholder={"yourname"}
                  style={{ ...inpD, flex: 1 }}
                  onFocus={e => e.target.style.borderColor = "#4a7cf7"}
                  onBlur={e => e.target.style.borderColor = "rgba(var(--os-ink),.1)"} />
                <span style={{ fontSize: 14, color: "rgba(var(--os-ink),.3)", whiteSpace: "nowrap" }}>.example.com</span>
              </div>
            </div>
            <button onClick={save} style={{ padding: "6px 18px", borderRadius: 5, background: saved ? "#22c55e" : "rgba(74,124,247,.25)", border: `1px solid ${saved ? "#22c55e" : "rgba(74,124,247,.5)"}`, color: OS.txt, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "background .3s" }}>
              {saved ? t("✓ Saved") : t("Save")}
            </button>
          </>
        )}

        {/* ── Installed Apps, drawn by the desktop ── */}
        {section === "apps" && desktopSections?.apps}

        {/* ── AI Routing ── */}
        {section === "routing" && <RoutingSettings />}

        {/* ── Resident projects, rules and build plans ── */}
        {section === "projects" && <ProjectsSettings />}

        {/* ── Privacy ── */}
        {section === "appearance" && desktopSections?.appearance}

        {/* ── My Computer (BYOG) ── handed in by the desktop, like the two above ── */}
        {section === "byog" && desktopSections?.byog}
        {section === "privacy" && (
          <>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 20 }}>{t("Privacy")}</div>

            {/* Echo visibility toggle */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 14px", background:"rgba(var(--os-ink),.04)", border:`1px solid ${OS.border}`, borderRadius:9, marginBottom:16 }}>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:OS.txt }}>{t("Show Echo bar")}</div>
                <div style={{ fontSize:11, color:OS.txt3, marginTop:2 }}>{t("The floating AI assistant. Hide it if you prefer using Direct Chat instead.")}</div>
              </div>
              <button onClick={() => {
                const next = localStorage.getItem("aos_echo_visible") !== "0" ? "0" : "1";
                localStorage.setItem("aos_echo_visible", next);
                window.dispatchEvent(new CustomEvent("arca_echo_toggle", { detail: next === "1" }));
              }} style={{ padding:"6px 16px", borderRadius:7, border:`1px solid ${OS.border}`, background: localStorage.getItem("aos_echo_visible") !== "0" ? "rgba(74,124,247,.25)" : "rgba(var(--os-ink),.06)", color: localStorage.getItem("aos_echo_visible") !== "0" ? "#93c5fd" : OS.txt2, fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>
                {localStorage.getItem("aos_echo_visible") !== "0" ? t("Visible") : t("Hidden")}
              </button>
            </div>
            {[
              { icon: "🔑", title: t("API Keys"), body: t("Kept in this server's encrypted vault, never in your browser, and never shown back in full. The server uses them only to reach the provider you chose.") },
              ...(desktopSections ? [{ icon: "🏛️", title: t("LegacyDesk data"), body: t("Encrypted with AES-256. Stored in your browser's IndexedDB or on your own server. JotNotes never sees it.") }] : []),
              ...(desktopSections ? [{ icon: "👤", title: t("EchoSelf memories"), body: t("Your conversation exports stay on your device. Only the messages you send in a chat session go to the AI provider.") }] : []),
              { icon: "🌐", title: t("Website / Blog"), body: t("Published to your subdomain. Your content, your domain, your server. Portable export available any time.") },
            ].map(item => (
              <div key={item.title} style={{ display: "flex", gap: 14, padding: "14px 16px", borderRadius: 12, background: "rgba(var(--os-ink),.04)", border: "1px solid rgba(var(--os-ink),.07)", marginBottom: 10 }}>
                <span style={{ fontSize: 22, flexShrink: 0 }}>{item.icon}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 5 }}>{item.title}</div>
                  <div style={{ fontSize: 12, color: "rgba(var(--os-ink),.4)", lineHeight: 1.65 }}>{item.body}</div>
                </div>
              </div>
            ))}
          </>
        )}

      </div>
    </div>
  );
}

// ── App Content: Mail ────────────────────────────────────────────────────────
function mailFolderIcon(name) {
  const n = String(name || "").toLowerCase();
  if (n === "inbox")   return "inbox";
  if (n === "sent")    return "send";
  if (n === "drafts")  return "document";
  if (n === "archive") return "archive";
  if (n === "spam")    return "alert";
  if (n === "trash")   return "trash";
  return "folder";
}
function mailReplySubject(subject) {
  if (!subject) return "Re:";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}
const MAIL_CSS = `
  .jotpanel-mail-shell{display:flex;height:100%;background:#f3f5f7;color:#17212b;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .jotpanel-mail-sidebar{width:228px;border-right:1px solid #d7dde5;display:flex;flex-direction:column;flex-shrink:0;background:#eef1f4}
  .jotpanel-mail-brand{height:60px;padding:0 13px;border-bottom:1px solid #d7dde5;display:flex;align-items:center;gap:9px;background:#fff}
  .jotpanel-mail-mark{width:31px;height:31px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;background:#1d5e92}
  .jotpanel-mail-form{padding:12px;border-bottom:1px solid #d7dde5;display:flex;flex-direction:column;gap:7px;background:#f8fafb;max-height:430px;overflow:auto}
  .jotpanel-mail-accounts{padding:11px 9px 8px;border-bottom:1px solid #d7dde5}
  .jotpanel-mail-folders{padding:11px 9px;flex:1}
  .jotpanel-mail-kicker{font-size:9.5px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#7a8594;margin:0 7px 6px}
  .jotpanel-mail-side-button{width:100%;border:1px solid transparent;background:transparent;color:#465466;border-radius:5px;padding:8px 9px;margin-bottom:2px;display:flex;align-items:center;gap:9px;text-align:left;font:600 12px inherit;cursor:pointer}
  .jotpanel-mail-side-button:hover{background:#e3e8ed;color:#17212b}.jotpanel-mail-side-button.active{background:#fff;border-color:#cbd3dc;color:#174f7c;box-shadow:0 1px 1px rgba(20,34,50,.04)}
  .jotpanel-mail-secure{margin:9px 12px 12px;padding-top:10px;border-top:1px solid #d7dde5;display:flex;align-items:center;gap:6px;color:#5b6878;font-size:10.5px;line-height:1.4}
  .jotpanel-mail-list{width:318px;border-right:1px solid #d7dde5;display:flex;flex-direction:column;flex-shrink:0;background:#fff}
  .jotpanel-mail-list-head{height:60px;padding:0 13px;border-bottom:1px solid #d7dde5;display:flex;align-items:center;justify-content:space-between;background:#fff}
  .jotpanel-mail-list-head strong{display:block;font-size:13px}.jotpanel-mail-list-head span{display:block;font-size:10.5px;color:#7a8594;margin-top:2px}
  .jotpanel-mail-message{padding:12px 13px;border-bottom:1px solid #e5e9ee;cursor:pointer;background:#fff;border-left:3px solid transparent}
  .jotpanel-mail-message:hover{background:#f7f9fa}.jotpanel-mail-message.selected{background:#eef5fa;border-left-color:#1d5e92}.jotpanel-mail-message.unread:not(.selected){border-left-color:#6f9cc0}
  .jotpanel-mail-empty{height:100%;min-height:220px;padding:32px 22px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;text-align:center;color:#687486;font-size:11.5px;line-height:1.5}
  .jotpanel-mail-empty strong{color:#344152;font-size:13px}.jotpanel-mail-reader{flex:1;display:flex;flex-direction:column;min-width:0;background:#fff}
  .jotpanel-mail-reader-head{min-height:72px;padding:16px 21px;border-bottom:1px solid #d7dde5;background:#fff}
  .jotpanel-mail-body{flex:1;overflow-y:auto;padding:24px 25px}.jotpanel-mail-reader-empty{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:#7a8594}
  .jotpanel-mail-reader-empty strong{font-size:15px;color:#344152}.jotpanel-mail-reader-empty span:last-child{font-size:11.5px}.jotpanel-mail-reader-mark{width:64px;height:64px;border:1px solid #d7dde5;background:#f3f5f7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:5px}
  .jotpanel-mail-reply{padding:13px 16px;border-top:1px solid #d7dde5;background:#f8fafb}.jotpanel-mail-bulk{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;background:#eef4fb;border-bottom:1px solid #d7dde5;font-size:11.5px;color:#17212b}.jotpanel-mail-search{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid #d7dde5;background:#fff}.jotpanel-mail-tools{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}.jotpanel-mail-compose{position:absolute;inset:auto 0 0 0;padding:14px 16px;border-top:1px solid #d7dde5;background:#fff;box-shadow:0 -8px 24px rgba(23,33,43,.12);display:flex;flex-direction:column;gap:8px;max-height:78%;overflow-y:auto}.jotpanel-mail-compose-head{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;color:#17212b}.jotpanel-mail-reader{position:relative}.jotpanel-mail-status{padding:8px 15px;border-top:1px solid #d7dde5;font-size:11px}.jotpanel-mail-status.ok{color:#176649;background:#eef8f3}.jotpanel-mail-status.error{color:#a13932;background:#fff2f0}
`;

// ── Why your mail did or did not arrive ────────────────────────────
//
// The one thing a standalone webmail cannot do. Roundcube is a client bolted
// onto a mail server it knows nothing about: it can show somebody a bounce, and
// it cannot tell them their signing key is not published, that the message is
// still sitting in the queue, or offer to fix either. This client is the same
// program that runs the mail server, and these two screens are the whole
// argument for moving to it.
//
// Everything here is read from operations that already existed, were already
// tested and were already shipping in the server section of the panel, where
// nobody reading their mail could see them. Nothing new was plumbed.

// The judgement, separated from the markup because the judgement is the part
// worth testing. Three answers go in — what the public DNS publishes
// (mailauth.check), what this machine is actually signing with (mail.dkim.show)
// and what is still in the queue (mail.queue.list) — and what to say comes out.
//
// Two rules shape it. An answer that was not fetched is absent rather than
// green: a domain nothing was asked about is never reported as fine. And it
// says nothing at all when there is nothing to say, because a line that is
// always in the compose window is a line nobody reads.
export function mailDeliveryAdvice({ address = "", auth = null, dkim = null, queue = null } = {}) {
  const clean = String(address || "").trim().toLowerCase();
  const at = clean.lastIndexOf("@");
  const domain = at === -1 ? "" : clean.slice(at + 1);
  const notes = [];
  const fixes = [];

  // What this machine does, which is the half a client on somebody else's
  // server cannot see. `signing` is read off the mail server's own key
  // directory rather than guessed from DNS.
  const localKeys = Array.isArray(dkim?.keys) ? dkim.keys : [];
  if (dkim && dkim.signing === false) {
    notes.push({ part: "dkim", level: "problem", sentence: localKeys.length
      ? `This server has a signing key for ${domain} but is not signing with it, so nothing you send carries a signature.`
      : `This server is not signing mail for ${domain}. A receiver has no way to tell your message from a forgery of it.` });
  }

  // The key this machine signs with, against what the world can actually read.
  // This is the failure that is otherwise invisible: the mail leaves signed,
  // every receiver checks the signature, and the record it needs was never
  // published, so every message fails a check nobody is told about.
  const publishedSelectors = new Set((auth?.dkim?.keys || []).map(key => String(key.selector)));
  if (auth && dkim && localKeys.length) {
    for (const key of localKeys) {
      if (publishedSelectors.has(String(key.selector))) continue;
      notes.push({ part: "dkim", level: "problem",
        sentence: `The key this server signs with, on selector ${key.selector}, is not published for ${domain}. Every message it signs fails the check.` });
      // The exact record, taken off this machine's own key rather than
      // composed here. There is no value to get wrong.
      if (key.dns_value) {
        fixes.push({
          id: `dkim-${key.selector}`,
          operation: "dns.record.create",
          label: `Publish the signing key for ${domain}`,
          note: `Adds the TXT record ${key.dns_name} to the zone held on this server.`,
          input: { zone: domain, label: `${key.selector}._domainkey`, type: "TXT", value: key.dns_value },
        });
      }
    }
  }

  // SPF and DMARC, in the words mailauth.check already wrote. They are better
  // sentences than anything worth writing twice, and rewriting them here is how
  // the two screens start disagreeing about the same domain.
  for (const finding of auth?.findings || []) {
    if (finding.level === "note") continue;
    if (finding.part === "dkim" && notes.some(n => n.part === "dkim")) continue;
    notes.push({ part: finding.part, level: finding.level, sentence: finding.sentence });
  }

  // One operation publishes all three and points this server's mail at the key
  // it makes. It is offered once, whatever is wrong, rather than as a fix
  // beside each separate fault: three buttons that do the same thing is three
  // chances to run it twice.
  const broken = notes.some(note => note.level === "problem");
  if (broken && domain) {
    fixes.push({
      id: "mailauth-setup",
      operation: "mailauth.setup",
      label: `Set up mail authentication for ${domain}`,
      note: "Generates a signing key, points this server's mail at it and publishes SPF, DKIM and DMARC. The policy starts at none, which asks receivers to do nothing yet.",
      input: { domain, policy: "none" },
    });
  }

  // The queue. `queue` is null when nothing answered, which is not the same as
  // an empty queue and is never drawn as one.
  const rows = Array.isArray(queue?.messages) ? queue.messages : [];
  const senderIs = row => String(row.sender || "").trim().toLowerCase().replace(/^<|>$/g, "");
  const stuck = {
    mine: rows.filter(row => senderIs(row) === clean),
    others: rows.filter(row => senderIs(row) !== clean),
  };

  const level = notes.some(n => n.level === "problem") || stuck.mine.length ? "problem"
    : notes.length ? "warning" : "ok";

  return {
    address: clean, domain,
    authKnown: !!auth, signingKnown: !!dkim, queueKnown: !!queue,
    notes, fixes, stuck, level,
    // Silence is only honest when something actually answered. A compose window
    // over three failed reads says nothing and means nothing, so it is not
    // quiet — it has simply not been told, and the delivery screen says which.
    quiet: level === "ok" && !!auth && !!dkim,
  };
}

// The quiet line in the compose window. It is a sentence and a button, or it is
// nothing: the point is to be told before the message leaves, not to be handed
// a report while trying to write. Everything it can offer is gated on the
// server having proved it can do it, so a control that would only fail is
// absent rather than disabled.
function MailComposeDeliverability({ advice, tools, onFix, onOpen }) {
  if (!advice || advice.quiet) return null;
  if (!advice.authKnown && !advice.signingKnown) return null;
  const worst = advice.notes.find(note => note.level === "problem") || advice.notes[0];
  if (!worst) return null;
  const offer = advice.fixes.filter(fix => tools.can(fix.operation));
  const bad = worst.level === "problem";
  return (
    <div style={{ display:"flex", gap:8, alignItems:"flex-start", padding:"7px 9px", borderRadius:5, fontSize:11,
      lineHeight:1.45, color: bad ? "#a13932" : "#7a5a12", background: bad ? "#fff2f0" : "#fdf6e6",
      border:`1px solid ${bad ? "#f0cdc8" : "#ecdcb4"}` }}>
      <PanelIcon name="shield" size={13} color={bad ? "#a13932" : "#7a5a12"} />
      <span style={{ flex:1 }}>
        {worst.sentence}
        {advice.notes.length === 2 && ` ${t("One more thing is wrong with this domain.")}`}
        {advice.notes.length > 2 && ` ${t("{n} more things are wrong with this domain.", { n: advice.notes.length - 1 })}`}
      </span>
      {offer[0] && <button onClick={() => onFix(offer[0])} style={{ ...mailToolButton, whiteSpace:"nowrap" }}>{t("Fix this")}</button>}
      <button onClick={onOpen} style={{ ...mailToolButton, whiteSpace:"nowrap" }}>{t("Details")}</button>
    </div>
  );
}

const mailToolButton = { padding:"4px 8px", borderRadius:4, border:"1px solid #cbd3dc", background:"#fff",
  color:"#344152", cursor:"pointer", fontSize:10.5, fontWeight:650, fontFamily:"inherit" };

// The screen somebody opens when a message did not arrive. The queue entry, the
// reason the mail server itself gave, and the fix as a proposal that goes
// through the same approval as every other write in this panel. Nothing here
// runs on its own.
function MailDeliveryScreen({ advice, tools, state, onFix, onQueue, onRefresh, busy }) {
  // Two different questions, and reading the capability report as though it
  // answered both is how a button gets drawn that the server then refuses. The
  // report says what this MACHINE can do. Whether this ACCOUNT may is the
  // ownership question, and the queue is the whole machine's spool: somebody
  // may be told why their own message is not moving without being handed the
  // spool every other account on the box is also waiting in.
  const mayTouchQueue = tools.isOperator && tools.can("mail.queue.action");
  const head = { fontSize:12, fontWeight:750, color:"#17212b", margin:"0 0 6px" };
  const muted = { fontSize:11, lineHeight:1.5, color:"#687486" };
  const card = { border:"1px solid #d7dde5", borderRadius:6, background:"#fff", padding:"12px 14px", marginBottom:10 };

  return (
    <div style={{ padding:"16px 20px", overflowY:"auto", flex:1 }}>
      <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:12 }}>
        <strong style={{ fontSize:14 }}>{t("Delivery")}</strong>
        <span style={muted}>{advice.address || t("no mailbox chosen")}</span>
        <span style={{ flex:1 }} />
        <button onClick={onRefresh} disabled={!!busy} style={mailToolButton}>{state.loading ? t("Checking…") : t("Check again")}</button>
      </div>

      {/* What could not be asked, said rather than left blank. A screen that
          draws an empty queue because the read was refused is telling somebody
          their mail is fine when nobody looked. */}
      {state.refusals.length > 0 && (
        <div style={{ ...card, background:"#f8fafb" }}>
          <p style={head}>{t("Not everything could be checked")}</p>
          {state.refusals.map(row => <p key={row.what} style={muted}>{row.what}: {row.why}</p>)}
        </div>
      )}

      {/* ── Why your message did not arrive ── */}
      <div style={card}>
        <p style={head}>{t("Messages waiting to be delivered")}</p>
        {!advice.queueKnown
          ? <p style={muted}>{t("The mail queue on this server was not read, so nothing here says whether anything is waiting.")}</p>
          : advice.stuck.mine.length === 0
            ? <p style={muted}>{advice.stuck.others.length
                ? t("Nothing of yours is waiting. {n} other messages are in the queue.", { n: advice.stuck.others.length })
                : t("Nothing sent from this mailbox is waiting in the queue.")}</p>
            : advice.stuck.mine.map(row => (
              <div key={row.id} style={{ borderTop:"1px solid #e5e9ee", padding:"9px 0", display:"flex", gap:10, alignItems:"flex-start" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:11.5, fontWeight:650, color:"#17212b" }}>{(row.recipients || []).join(", ") || t("no recipient recorded")}</div>
                  <div style={muted}>
                    {t("Queued since {when}.", { when: row.arrived })} {row.reason
                      ? t("The mail server says: {why}", { why: row.reason })
                      : t("The mail server gave no reason, which usually means it has not tried yet.")}
                  </div>
                  <div style={{ ...muted, fontFamily:"ui-monospace, monospace" }}>{row.id}</div>
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  {mayTouchQueue && <>
                    <button disabled={!!busy} onClick={() => onQueue("mail.queue.retry", row.id)} style={mailToolButton}>{t("Try again now")}</button>
                    <button disabled={!!busy} onClick={() => onQueue("mail.queue.delete", row.id)} style={{ ...mailToolButton, color:"#a13932" }}>{t("Give up on it")}</button>
                  </>}
                </div>
              </div>
            ))}
        {advice.queueKnown && advice.stuck.mine.length > 0 && !mayTouchQueue && <p style={{ ...muted, marginTop:8 }}>
          {tools.can("mail.queue.action")
            ? t("Retrying or abandoning a message moves the whole machine's mail spool, so it stays with whoever runs this server. Reading why yours is not moving does not.")
            : tools.why("mail.queue.action")}
        </p>}
      </div>

      {/* ── Whether it will be believed when it does arrive ── */}
      <div style={card}>
        <p style={head}>{t("Whether receiving servers will believe it")}</p>
        {!advice.authKnown && !advice.signingKnown
          ? <p style={muted}>{t("Neither the public records for {domain} nor this server's own signing key was read, so this says nothing about either.", { domain: advice.domain || t("this domain") })}</p>
          : advice.notes.length === 0
            ? <p style={muted}>{t("Nothing is wrong with SPF, DKIM or DMARC for {domain}, and this server is signing what it sends.", { domain: advice.domain })}</p>
            : advice.notes.map((note, index) => (
              <p key={index} style={{ ...muted, color: note.level === "problem" ? "#a13932" : "#7a5a12", marginBottom:6 }}>{note.sentence}</p>
            ))}
        {!advice.signingKnown && advice.authKnown
          && <p style={muted}>{t("This server's own signing key was not read, so what is said above is only what the public records show.")}</p>}
        <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:advice.fixes.length ? 10 : 0 }}>
          {advice.fixes.map(fix => tools.can(fix.operation)
            ? <button key={fix.id} disabled={!!busy} onClick={() => onFix(fix)} title={fix.note} style={{ ...mailToolButton, borderColor:"#1d5e92", color:"#1d5e92" }}>{fix.label}</button>
            : <span key={fix.id} style={muted}>{tools.why(fix.operation)}</span>)}
        </div>
        {advice.fixes.length > 0 && <p style={{ ...muted, marginTop:8 }}>{t("Nothing runs when you press one of these. It is written down as a proposal and waits for you to approve it in Activity, like every other change this panel makes.")}</p>}
      </div>
    </div>
  );
}

export function MailApp() {
  const [accounts, setAccounts]             = useState([]);
  const [srv]                               = useState(() => readPanelStorage("server") || window.location.origin);
  const [accountForm, setAccountForm]       = useState({ label:"", email:"", imapHost:"", imapPort:"993", secure:true, smtpHost:"", smtpPort:"587", smtpSecure:false, username:"", password:"" });
  const [activeAccountId, setActiveAccountId] = useState(null);
  const [folders, setFolders]               = useState(["INBOX","Sent","Drafts","Archive"]);
  const [activeFolder, setActiveFolder]     = useState("INBOX");
  const [messages, setMessages]             = useState([]);
  // A selection is the folder it was made in as well as the message, because
  // the id alone is not enough to identify anything. Changing folder used to
  // leave the previously selected id in place, and the message pane then asked
  // the new folder for a UID that only ever existed in the old one, so every
  // folder change printed "that message is no longer in this folder" at
  // somebody who had done nothing wrong. Only a browser shows that.
  const [selection, setSelection]           = useState(null);
  const [loading, setLoading]               = useState(false);
  const [replyText, setReplyText]           = useState("");
  const [sending, setSending]               = useState(false);
  const [openMessage, setOpenMessage]       = useState(null);
  const [loadingBody, setLoadingBody]       = useState(false);
  const [showRemote, setShowRemote]         = useState(false);
  const [compose, setCompose]               = useState(null);
  const [query, setQuery]                   = useState("");
  const [searching, setSearching]           = useState(null);
  const [busy, setBusy]                     = useState("");
  const [hasMore, setHasMore]               = useState(false);
  const [checked, setChecked]               = useState([]);
  const [savingAccount, setSavingAccount]   = useState(false);
  const [showForm, setShowForm]             = useState(false);
  const [status, setStatus]                 = useState("");
  const [statusErr, setStatusErr]           = useState(false);
  // The server this mailbox actually lives on, asked what it can do rather than
  // assumed. The mail client runs on the desktop as well as inside the panel,
  // where there is no `ops` object to hand down, so it asks the same two
  // endpoints the panel asks and keeps the answer to itself.
  const [serverCaps, setServerCaps]         = useState({ ready:false, index:new Map(), isOperator:false });
  const [delivery, setDelivery]             = useState({ loading:false, auth:null, dkim:null, queue:null, refusals:[], checkedFor:"" });
  const [showDelivery, setShowDelivery]     = useState(false);

  const jwt = readPanelStorage("jwt") || "";
  const activeAccount = useMemo(() => accounts.find(a => a.id === activeAccountId) || null, [accounts, activeAccountId]);
  const selected      = useMemo(() => messages.find(m => m.id === selection?.id) || null, [messages, selection]);

  useEffect(() => { if (!activeAccountId && accounts.length) setActiveAccountId(accounts[0].id); }, [accounts, activeAccountId]);
  useEffect(() => { if (activeAccount) fetchMessages(activeAccount, activeFolder); }, [activeAccountId, activeFolder]);
  // The list carries headers only. Opening a message is a second request,
  // because the body of fifty messages is not something to fetch to draw a list.
  useEffect(() => {
    if (!activeAccount || !selection) { setOpenMessage(null); return; }
    let live = true;
    setLoadingBody(true); setShowRemote(false);
    mailApi(`/api/mail/message?accountId=${encodeURIComponent(activeAccount.id)}&folder=${encodeURIComponent(selection.folder)}&uid=${encodeURIComponent(selection.id)}`)
      .then(m => { if (live) setOpenMessage(m); })
      .catch(e => { if (live) { setOpenMessage(null); setStatus(t("That message could not be opened: {why}", { why: e.message })); setStatusErr(true); } })
      .finally(() => { if (live) setLoadingBody(false); });
    return () => { live = false; };
  }, [selection, activeAccountId]);

  const base = () => (srv || window.location.origin).replace(/\/$/, "");
  const mailApi = async (path, opts = {}) => {
    const res = await fetch(`${base()}${path}`, { ...opts, headers: { "Content-Type":"application/json", ...languageHeaders(), ...(jwt ? { Authorization:`Bearer ${jwt}` } : {}), ...(opts.headers||{}) } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `${res.status}`);
    return d;
  };

  useEffect(() => {
    let live = true;
    mailApi("/api/mail/accounts")
      .then(rows => { if (live) setAccounts(Array.isArray(rows) ? rows : []); })
      .catch(e => { if (live) { setStatus(t("Mail accounts could not be loaded: {why}", { why: e.message })); setStatusErr(true); } });
    return () => { live = false; };
  }, [srv]);

  // ── The server underneath this mailbox ────────────────────────────
  // Asked once. A failure here is not an error the person needs to see: it
  // means this mailbox is on somebody else's server, or this account may not
  // ask, and the answer to both is that the delivery screens are not offered.
  useEffect(() => {
    let live = true;
    Promise.all([
      mailApi("/api/panel/server/capabilities").catch(() => null),
      mailApi("/api/me").catch(() => null),
    ]).then(([caps, me]) => {
      if (!live) return;
      const index = new Map();
      for (const section of caps?.sections || []) for (const capability of section.capabilities || []) index.set(capability.id, capability);
      setServerCaps({ ready:true, index, isOperator: me?.is_operator === true });
    });
    return () => { live = false; };
  }, [srv]);

  const tools = useMemo(() => ({
    ready: serverCaps.ready,
    isOperator: serverCaps.isOperator,
    can: id => !!serverCaps.index.get(id)?.available,
    // A capability the report does not mention at all is one this panel was
    // never told about, which is a different sentence from "the server cannot".
    why: id => serverCaps.index.get(id)?.reason
      || t("This panel has not been told whether the server can do that."),
  }), [serverCaps]);

  // The three readings behind both delivery screens, every one of them an
  // operation that already existed. Each is asked only where the capability
  // report says it is there, and a refusal is written down rather than swallowed
  // — a queue that could not be read must never draw as an empty queue.
  const loadDelivery = useCallback(async account => {
    if (!account) return;
    const address = String(account.email || "").trim().toLowerCase();
    const at = address.lastIndexOf("@");
    const mailDomain = at === -1 ? "" : address.slice(at + 1);
    setDelivery(state => ({ ...state, loading:true }));
    const refusals = [];
    const ask = async (what, capability, path) => {
      if (!tools.can(capability)) { refusals.push({ what, why: tools.why(capability) }); return null; }
      try { return await mailApi(path); }
      catch (error) { refusals.push({ what, why: error.message }); return null; }
    };
    // The signing key first, because its selectors are what turn the DKIM
    // check from a guess into an answer: the published record is looked up for
    // the selector this machine actually signs with rather than for a list of
    // the ones other people commonly use.
    const dkim = mailDomain
      ? await ask(t("This server's signing key"), "mail.dkim.show", `/api/panel/server/read/dkim?domain=${encodeURIComponent(mailDomain)}`)
      : null;
    const selectors = (dkim?.keys || []).map(key => key.selector).filter(Boolean);
    const auth = mailDomain
      ? await ask(t("The public records for {domain}", { domain: mailDomain }), "mailauth.check",
          `/api/panel/server/read/mail-auth?domain=${encodeURIComponent(mailDomain)}${selectors.map(s => `&selectors=${encodeURIComponent(s)}`).join("")}`)
      : null;
    const queue = await ask(t("The mail queue"), "mail.queue.list", "/api/panel/server/read/mail-queue");
    setDelivery({ loading:false, auth, dkim, queue, refusals, checkedFor:address });
  }, [tools, jwt, srv]);

  // Checked when the mailbox changes and the panel knows what the server can
  // do, so the compose window has an answer before anybody writes rather than
  // after they have sent.
  useEffect(() => {
    if (!tools.ready || !activeAccount) return;
    loadDelivery(activeAccount);
  }, [tools.ready, activeAccountId]);

  const advice = useMemo(
    () => mailDeliveryAdvice({ address: activeAccount?.email || "", auth: delivery.auth, dkim: delivery.dkim, queue: delivery.queue }),
    [activeAccount, delivery]
  );

  // A fix is a proposal and nothing else. It is written into the same action
  // record every other write in this panel goes through, and it waits there for
  // somebody to approve it. This screen never executes anything.
  const proposeFix = async (operation, input, label) => {
    setBusy(t("Proposing"));
    try {
      await mailApi("/api/panel/server/propose", { method:"POST", body: JSON.stringify({ operation, input }) });
      setStatus(t("{label} is written down and waiting. Nothing has run: approve it in Activity.", { label })); setStatusErr(false);
    } catch (error) {
      setStatus(t("{label} was refused: {why}", { label, why: error.message })); setStatusErr(true);
    } finally { setBusy(""); }
  };

  // Loading a folder always ends a search, because what is on the screen after
  // it is the folder and not the result. Leaving the search header up over a
  // full folder listing is a small lie that makes every count on the screen
  // disagree with the list under it.
  const fetchMessages = async (account, folder) => {
    setLoading(true); setStatus(""); setStatusErr(false); setSearching(null);
    try {
      const d = await mailApi(`/api/mail/messages?accountId=${encodeURIComponent(account.id)}&folder=${encodeURIComponent(folder)}`);
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      setMessages(msgs); setSelection(msgs[0] ? { folder, id: msgs[0].id } : null);
      setHasMore(!!d.hasMore); setChecked([]);
      if (Array.isArray(d.folders) && d.folders.length) setFolders(d.folders);
    } catch (e) {
      setMessages([]); setSelection(null);
      setStatus(t("This folder could not be checked: {why}", { why: e.message })); setStatusErr(true);
    } finally { setLoading(false); }
  };

  // The next page is asked for by how many are already on screen, not by a page
  // number. The server counts back from the newest message, so a mailbox that
  // takes delivery while somebody is reading does not push the page they are
  // looking at down onto the one they are about to ask for.
  const loadMore = async () => {
    if (!activeAccount || loading) return;
    setBusy(t("Loading"));
    try {
      const d = await mailApi(`/api/mail/messages?accountId=${encodeURIComponent(activeAccount.id)}&folder=${encodeURIComponent(activeFolder)}&offset=${messages.length}`);
      const more = Array.isArray(d.messages) ? d.messages : [];
      const known = new Set(messages.map(m => m.id));
      setMessages(list => [...list, ...more.filter(m => !known.has(m.id))]);
      setHasMore(!!d.hasMore);
    } catch (e) { setStatus(t("More messages could not be loaded: {why}", { why: e.message })); setStatusErr(true); }
    finally { setBusy(""); }
  };

  // Acting on several at once. The verbs already took a list of messages; this
  // is the only thing that was missing, and it is the difference between
  // clearing a morning's mail and clicking forty times.
  const toggleChecked = (id) => setChecked(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const checkedUids = () => checked.map(Number).filter(Boolean);
  const bulk = (path, body, message) => {
    if (!checkedUids().length) return;
    return runVerb(t("Working"), path, { uids: checkedUids(), ...body }, message);
  };

  const folderVerb = async (action, name, to) => {
    if (!activeAccount) return;
    setBusy(t("Working")); setStatus(""); setStatusErr(false);
    try {
      const d = await mailApi("/api/mail/folder", { method:"POST", body:JSON.stringify({ accountId:activeAccount.id, action, name, to }) });
      if (Array.isArray(d.folders)) setFolders(d.folders);
      if (action === "delete" && name === activeFolder) setActiveFolder("INBOX");
      if (action === "rename" && name === activeFolder) setActiveFolder(to);
      setStatus(action === "create" ? t("Folder {folder} created.", { folder: name })
        : action === "rename" ? t("Folder renamed to {folder}.", { folder: to })
        : t("Folder {folder} removed.", { folder: name }));
      setStatusErr(false);
    } catch (e) { setStatus(t("That folder was not changed: {why}", { why: e.message })); setStatusErr(true); }
    finally { setBusy(""); }
  };

  const saveAccount = async () => {
    setSavingAccount(true); setStatus(""); setStatusErr(false);
    try {
      const payload = { id: activeAccountId || crypto.randomUUID(), ...accountForm };
      await mailApi("/api/mail/accounts/test", { method:"POST", body:JSON.stringify(payload) });
      const saved = await mailApi("/api/mail/accounts/save", { method:"POST", body:JSON.stringify(payload) });
      const rows = await mailApi("/api/mail/accounts");
      setAccounts(Array.isArray(rows) ? rows : []);
      setActiveAccountId(saved.id); setShowForm(false);
      setAccountForm({ label:"", email:"", imapHost:"", imapPort:"993", secure:true, smtpHost:"", smtpPort:"587", smtpSecure:false, username:"", password:"" });
      setStatus(t("Connection verified. The account is ready."));
    } catch (e) { setStatus(e.message || t("Could not save.")); setStatusErr(true); } finally { setSavingAccount(false); }
  };

  // A reply carries the threading headers of the message it answers, so it
  // lands in the same conversation in the recipient's client rather than
  // starting a new one that merely repeats the subject.
  const sendReply = async () => {
    if (!selected || !replyText.trim() || !activeAccount) return;
    setSending(true); setStatus(""); setStatusErr(false);
    try {
      const r = await mailApi("/api/mail/reply", { method:"POST", body:JSON.stringify({
        accountId: activeAccount.id,
        to: openMessage?.fromEmail || selected.fromEmail,
        subject: mailReplySubject(openMessage?.subject || selected.subject),
        text: replyText.trim(),
        inReplyTo: openMessage?.messageId || "",
        references: openMessage?.references || [],
      }) });
      setReplyText("");
      setStatus(r?.sentCopy?.filed ? t("Reply sent, and filed in {folder}.", { folder: r.sentCopy.folder }) : t("Reply sent. It could not be filed in Sent: {why}", { why: r?.sentCopy?.reason || t("unknown reason") }));
      setStatusErr(false);
    } catch (e) { setStatus(t("The reply was not sent: {why}", { why: e.message })); setStatusErr(true); } finally { setSending(false); }
  };

  // Every verb is the same shape: act on the server, then re-read the folder
  // rather than editing the list in place. A client that guesses what the
  // mailbox now looks like is a client that disagrees with the phone in your
  // pocket, and the disagreement is always the client's fault.
  const runVerb = async (label, path, body, message) => {
    if (!activeAccount) return;
    setBusy(label); setStatus(""); setStatusErr(false);
    try {
      await mailApi(path, { method:"POST", body:JSON.stringify({ accountId:activeAccount.id, folder:activeFolder, ...body }) });
      await fetchMessages(activeAccount, activeFolder);
      setStatus(message); setStatusErr(false);
    } catch (e) { setStatus(t("{action} did not happen: {why}", { action: label, why: e.message })); setStatusErr(true); }
    finally { setBusy(""); }
  };

  // Opening a message in the drafts folder resumes writing it, which is the
  // only thing a draft is for. Reading one as though it were received mail is
  // the behaviour that makes a client feel like it does not know what a draft
  // is.
  useEffect(() => {
    if (!openMessage || !selection) return;
    const isDrafts = /draft|concept|entwurf|brouillon/i.test(selection.folder);
    if (!isDrafts || compose) return;
    setCompose({ to: openMessage.to || "", cc: openMessage.cc || "", bcc: "",
      subject: openMessage.subject === "(no subject)" ? "" : openMessage.subject,
      text: openMessage.text || "", draftUid: openMessage.uid });
  }, [openMessage, selection]);

  const markUnread = () => selected && runVerb(t("Marking unread"), "/api/mail/flags", { uids:[selected.uid], remove:["\\Seen"] }, t("Marked unread."));
  const toggleFlag = () => {
    if (!selected) return;
    const flagged = (selected.flags || []).includes("\\Flagged");
    return runVerb(flagged ? t("Unflagging") : t("Flagging"), "/api/mail/flags",
      { uids:[selected.uid], [flagged ? "remove" : "add"]:["\\Flagged"] }, flagged ? t("Flag removed.") : t("Flagged."));
  };
  const deleteSelected = () => selected && runVerb(t("Deleting"), "/api/mail/delete", { uids:[selected.uid] }, t("Moved to the deleted folder."));
  const moveSelected = (to) => selected && to && runVerb(t("Moving"), "/api/mail/move", { uids:[selected.uid], to }, t("Moved to {folder}.", { folder: to }));

  const runSearch = async () => {
    const text = query.trim();
    if (!text || !activeAccount) return;
    setLoading(true); setStatus(""); setStatusErr(false);
    try {
      const d = await mailApi(`/api/mail/search?accountId=${encodeURIComponent(activeAccount.id)}&folder=${encodeURIComponent(activeFolder)}&q=${encodeURIComponent(text)}`);
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      setMessages(msgs); setSelection(msgs[0] ? { folder: activeFolder, id: msgs[0].id } : null);
      setSearching({ query:text, total:d.total || 0 });
    } catch (e) { setStatus(t("That search did not run: {why}", { why: e.message })); setStatusErr(true); }
    finally { setLoading(false); }
  };
  const clearSearch = () => { setQuery(""); setSearching(null); if (activeAccount) fetchMessages(activeAccount, activeFolder); };

  // Reply-all and forward are compose windows that start with something in
  // them. Reply-all drops this mailbox's own address, because a reply that
  // copies you on your own message is the oldest annoyance in email.
  const quoted = (m) => `\n\n---- ${m?.from || "the sender"} wrote ----\n${(m?.text || "").split("\n").map(l => `> ${l}`).join("\n")}`;
  const openReplyAll = () => {
    if (!openMessage || !activeAccount) return;
    const mine = (activeAccount.email || "").toLowerCase();
    const others = [openMessage.to, openMessage.cc].filter(Boolean).join(",").split(",")
      .map(a => a.trim()).filter(a => a && !a.toLowerCase().includes(mine));
    setCompose({ to: openMessage.fromEmail, cc: others.join(", "), subject: mailReplySubject(openMessage.subject),
      text: quoted(openMessage), inReplyTo: openMessage.messageId, references: openMessage.references || [] });
  };
  const openForward = () => {
    if (!openMessage) return;
    setCompose({ to:"", cc:"", subject:`Fwd: ${String(openMessage.subject || "").replace(/^fwd:\s*/i, "")}`, text: quoted(openMessage) });
  };

  const downloadAttachment = async (attachment) => {
    if (!activeAccount || !openMessage) return;
    try {
      const res = await fetch(`${base()}/api/mail/attachment?accountId=${encodeURIComponent(activeAccount.id)}&folder=${encodeURIComponent(selection?.folder || activeFolder)}&uid=${encodeURIComponent(openMessage.uid)}&index=${attachment.index}`,
        { headers: jwt ? { Authorization:`Bearer ${jwt}` } : {} });
      if (!res.ok) throw new Error(`${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url; link.download = attachment.filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { setStatus(t("That attachment did not download: {why}", { why: e.message })); setStatusErr(true); }
  };

  const attachFiles = async (files) => {
    const chosen = Array.from(files || []);
    if (!chosen.length) return;
    const read = await Promise.all(chosen.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`${file.name} could not be read`));
      reader.onload = () => resolve({ filename:file.name, contentType:file.type || "application/octet-stream",
        size:file.size, content:String(reader.result).split(",")[1] || "" });
      reader.readAsDataURL(file);
    })));
    setCompose(v => ({ ...v, attachments:[...(v.attachments || []), ...read] }));
  };

  const saveDraft = async () => {
    if (!compose || !activeAccount) return;
    setBusy(t("Saving")); setStatus(""); setStatusErr(false);
    try {
      const d = await mailApi("/api/mail/draft", { method:"POST", body:JSON.stringify({
        accountId:activeAccount.id, draft:compose, replacesUid:compose.draftUid || null }) });
      setCompose(v => ({ ...v, draftUid:d.uid }));
      setStatus(t("Draft saved in {folder}.", { folder: d.folder })); setStatusErr(false);
    } catch (e) { setStatus(t("The draft was not saved: {why}", { why: e.message })); setStatusErr(true); }
    finally { setBusy(""); }
  };

  const sendCompose = async () => {
    if (!compose || !activeAccount) return;
    setSending(true); setStatus(""); setStatusErr(false);
    try {
      const r = await mailApi("/api/mail/send", { method:"POST", body:JSON.stringify({
        accountId: activeAccount.id, to: compose.to, cc: compose.cc, bcc: compose.bcc,
        subject: compose.subject, text: compose.text,
        inReplyTo: compose.inReplyTo || "", references: compose.references || [],
        attachments: compose.attachments || [], draftUid: compose.draftUid || null,
      }) });
      setCompose(null);
      setStatus(r?.sentCopy?.filed ? t("Sent, and filed in {folder}.", { folder: r.sentCopy.folder }) : t("Sent. It could not be filed in Sent: {why}", { why: r?.sentCopy?.reason || t("unknown reason") }));
      setStatusErr(false);
    } catch (e) { setStatus(t("It was not sent: {why}", { why: e.message })); setStatusErr(true); } finally { setSending(false); }
  };

  const mInp = { width:"100%", padding:"9px 10px", background:"#fff", border:"1px solid #cbd3dc", borderRadius:5, color:"#17212b", fontSize:12, fontFamily:"inherit", outline:"none" };
  const mBtn = (primary=false) => ({ padding:"7px 11px", borderRadius:5, border:`1px solid ${primary ? "#1d5e92" : "#cbd3dc"}`, background:primary ? "#1d5e92" : "#fff", color:primary ? "#fff" : "#344152", cursor:"pointer", fontSize:11.5, fontWeight:650, fontFamily:"inherit", display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6 });

  return (
    <div className="jotpanel-mail-shell">
      <style>{MAIL_CSS}</style>

      {/* ── Sidebar ── */}
      <div className="jotpanel-mail-sidebar">
        <div className="jotpanel-mail-brand">
          <span className="jotpanel-mail-mark"><PanelIcon name="mail" size={18} color="#fff" /></span>
          <span style={{ fontSize:14, fontWeight:750, flex:1 }}>JotNotes Mail</span>
          <button onClick={() => setShowForm(v => !v)} style={mBtn(true)}>{showForm ? t("Close") : t("+ Account")}</button>
        </div>

        {showForm && (
          <div className="jotpanel-mail-form">
            <div style={{ fontSize:12, fontWeight:750 }}>{t("Connect a mailbox")}</div>
            <div style={{ fontSize:11, lineHeight:1.45, color:"#687486" }}>{t("JotPanel verifies the IMAP login before encrypting the credentials on this server.")}</div>
            {[[t("Label"),"label"],[t("Email"),"email"],[t("IMAP host"),"imapHost"],[t("IMAP port"),"imapPort"],[t("Username"),"username"]].map(([ph,k]) => (
              <input key={k} placeholder={ph} value={accountForm[k]} onChange={e => setAccountForm(v=>({...v,[k]:e.target.value}))} style={mInp} />
            ))}
            <input type="password" placeholder={t("Password / app password")} value={accountForm.password} onChange={e => setAccountForm(v=>({...v,password:e.target.value}))} style={mInp} />
            <input placeholder={t("SMTP host")} value={accountForm.smtpHost} onChange={e => setAccountForm(v=>({...v,smtpHost:e.target.value}))} style={mInp} />
            <input placeholder={t("SMTP port")} value={accountForm.smtpPort} onChange={e => setAccountForm(v=>({...v,smtpPort:e.target.value}))} style={mInp} />
            {/* Without these two a mailbox on implicit TLS could not be
                described at all: the backend stored the setting and the screen
                had no way to say it. The wording is what a mail provider's own
                help page says, rather than the protocol's word for it. */}
            <label style={{ fontSize:11.5, display:"flex", gap:7, alignItems:"center", color:"#344152" }}>
              <input type="checkbox" checked={accountForm.secure} onChange={e => setAccountForm(v=>({...v,secure:e.target.checked}))} />
              {t("Incoming mail is encrypted (SSL/TLS, usually port 993)")}
            </label>
            <label style={{ fontSize:11.5, display:"flex", gap:7, alignItems:"center", color:"#344152" }}>
              <input type="checkbox" checked={accountForm.smtpSecure} onChange={e => setAccountForm(v=>({...v,smtpSecure:e.target.checked}))} />
              {t("Outgoing mail is encrypted from the start (SSL/TLS, usually port 465)")}
            </label>
            <button onClick={saveAccount} disabled={savingAccount} style={mBtn(true)}>{savingAccount ? t("Verifying…") : t("Verify and save")}</button>
          </div>
        )}

        {accounts.length > 0 && (
          <div className="jotpanel-mail-accounts">
            <div className="jotpanel-mail-kicker">{t("Mailboxes")}</div>
            {accounts.map(a => (
              <button key={a.id} onClick={() => setActiveAccountId(a.id)}
                className={`jotpanel-mail-side-button ${a.id===activeAccountId ? "active" : ""}`}>
                <PanelIcon name="mail" size={15} /><span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.label||a.email}</span>
              </button>
            ))}
          </div>
        )}

        <div className="jotpanel-mail-folders">
          <div className="jotpanel-mail-kicker" style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            {t("Folders")}
            <button title={t("New folder")} disabled={!activeAccount || !!busy}
              onClick={() => { const name = window.prompt(t("Name for the new folder")); if (name) folderVerb("create", name); }}
              style={{ border:"none", background:"none", cursor:"pointer", color:"#1d5e92", fontSize:14, fontFamily:"inherit", padding:0 }}>+</button>
          </div>
          {folders.map(f => (
            <button key={f} onClick={() => setActiveFolder(f)}
              className={`jotpanel-mail-side-button ${f===activeFolder ? "active" : ""}`}>
              <PanelIcon name={mailFolderIcon(f)} size={15} /><span>{f}</span>
            </button>
          ))}
          {/* Renaming and removing are offered only for the folder in front of
              you, so neither can be aimed at the wrong one from a menu. The
              client refuses both for the folders a mailbox depends on, and says
              which folder and why rather than just refusing. */}
          {activeAccount && (
            <div style={{ display:"flex", gap:6, marginTop:8 }}>
              <button disabled={!!busy} style={{ ...mBtn(), flex:1, fontSize:10.5 }}
                onClick={() => { const to = window.prompt(t("New name for {folder}", { folder: activeFolder }), activeFolder); if (to && to !== activeFolder) folderVerb("rename", activeFolder, to); }}>
                {t("Rename")}
              </button>
              <button disabled={!!busy} style={{ ...mBtn(), flex:1, fontSize:10.5 }}
                onClick={() => { if (window.confirm(t("Remove the folder {folder}?", { folder: activeFolder }))) folderVerb("delete", activeFolder); }}>
                {t("Remove")}
              </button>
            </div>
          )}
        </div>
        <div className="jotpanel-mail-secure"><PanelIcon name="shield" size={14} /> {t("Credentials encrypted on this server")}</div>
      </div>

      {/* ── Message list ── */}
      <div className="jotpanel-mail-list">
        <div className="jotpanel-mail-list-head">
          <div><strong>{searching ? t("Search in {folder}", { folder: activeFolder }) : activeFolder}</strong><span>{searching ? (searching.total === 1 ? t("1 match for “{q}”", { q: searching.query }) : t("{n} matches for “{q}”", { n: searching.total, q: searching.query })) : (messages.length === 1 ? t("1 message") : t("{n} messages", { n: messages.length }))}</span></div>
          <div style={{ display:"flex", gap:6 }}>
            <button title={t("Write a message")} disabled={!activeAccount} onClick={() => setCompose({ to:"", cc:"", subject:"", text:"" })} style={mBtn(true)}><PanelIcon name="send" size={14} color="#fff" />{t("Write")}</button>
            {/* Offered only where the server proved it can answer at least one
                of the three questions behind the screen. On a mailbox hosted
                somewhere else there is nothing to ask, so there is no button
                rather than a button that opens an apology. */}
            {(tools.can("mail.queue.list") || tools.can("mailauth.check") || tools.can("mail.dkim.show")) && (
              <button title={t("Why a message did not arrive")} onClick={() => { setShowDelivery(true); if (!delivery.checkedFor && activeAccount) loadDelivery(activeAccount); }}
                style={{ ...mBtn(), ...(advice.level === "problem" ? { borderColor:"#a13932", color:"#a13932" } : {}) }}>
                <PanelIcon name="shield" size={14} color={advice.level === "problem" ? "#a13932" : "#344152"} />
                {advice.stuck.mine.length ? t("Delivery ({n})", { n: advice.stuck.mine.length }) : t("Delivery")}
              </button>
            )}
            <button title={t("Check for mail")} onClick={() => activeAccount && fetchMessages(activeAccount, activeFolder)} style={mBtn()}><PanelIcon name="refresh" size={14} /></button>
          </div>
        </div>
        <div className="jotpanel-mail-search">
          <input value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") runSearch(); if (e.key === "Escape") clearSearch(); }}
            placeholder={t("Search {folder}…", { folder: activeFolder })} style={{ ...mInp, padding:"6px 9px" }} />
          {searching
            ? <button onClick={clearSearch} style={mBtn()}>{t("Clear")}</button>
            : <button onClick={runSearch} disabled={!query.trim()} style={mBtn()}>{t("Find")}</button>}
        </div>
        <div style={{ flex:1, overflowY:"auto" }}>
          {loading && <div className="jotpanel-mail-empty">{t("Checking the mailbox…")}</div>}
          {!loading && messages.length === 0 && <div className="jotpanel-mail-empty"><PanelIcon name={accounts.length ? "inbox" : "mail"} size={28} color="#8591a1" /><strong>{accounts.length ? t("Nothing to show") : t("Connect your first mailbox")}</strong><span>{accounts.length ? t("This folder is empty, or the last check did not complete.") : t("Mail stays in one calm, three-pane workspace.")}</span></div>}
          {/* When several are ticked the toolbar acts on all of them, so the
              count is stated rather than left to be inferred from the ticks. */}
          {!loading && checked.length > 0 && (
            <div className="jotpanel-mail-bulk">
              <span>{checked.length === 1 ? t("1 selected") : t("{n} selected", { n: checked.length })}</span>
              <button disabled={!!busy} style={mBtn()} onClick={() => bulk("/api/mail/flags", { add:["\\Seen"] }, t("Marked read."))}>{t("Mark read")}</button>
              <button disabled={!!busy} style={mBtn()} onClick={() => bulk("/api/mail/flags", { remove:["\\Seen"] }, t("Marked unread."))}>{t("Mark unread")}</button>
              <button disabled={!!busy} style={mBtn()} onClick={() => bulk("/api/mail/delete", {}, t("Moved to the deleted folder."))}>{t("Delete")}</button>
              <button style={mBtn()} onClick={() => setChecked([])}>{t("Clear")}</button>
            </div>
          )}
          {!loading && messages.map(msg => (
            <div key={msg.id} onClick={() => setSelection({ folder: activeFolder, id: msg.id })}
              className={`jotpanel-mail-message ${msg.id===selection?.id ? "selected" : ""} ${msg.unread ? "unread" : ""}`}>
              <div style={{ display:"flex", justifyContent:"space-between", gap:8, marginBottom:3 }}>
                <input type="checkbox" checked={checked.includes(msg.id)} title={t("Select this message")}
                  onClick={e => e.stopPropagation()} onChange={() => toggleChecked(msg.id)}
                  style={{ marginRight:2, flexShrink:0 }} />
                <div style={{ fontSize:12, fontWeight:msg.unread?750:550, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"#17212b", flex:1 }}>{msg.from}</div>
                <div style={{ fontSize:10, color:"#7a8594", flexShrink:0 }}>{(msg.flags || []).includes("\\Flagged") ? "★ " : ""}{mailDateLabel(msg.date)}</div>
              </div>
              <div style={{ fontSize:11.5, fontWeight:650, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:"#344152" }}>
                {msg.subject||t("(no subject)")}
                {/* Said rather than drawn as a stack. Threading here only knows
                    about the page that was fetched, and a count is honest about
                    that in a way a collapsed conversation would not be. */}
                {msg.threadSize > 1 && <span style={{ marginLeft:6, fontSize:10, color:"#1d5e92", fontWeight:600 }}>{t("{n} in this conversation", { n: msg.threadSize })}</span>}
              </div>
            </div>
          ))}
          {!loading && hasMore && (
            <button onClick={loadMore} disabled={!!busy} style={{ ...mBtn(), width:"calc(100% - 20px)", margin:"10px" }}>
              {busy ? t("Loading…") : t("Load older messages")}
            </button>
          )}
        </div>
      </div>

      {/* ── Message pane ── */}
      <div className="jotpanel-mail-reader">
        <div className="jotpanel-mail-reader-head">
          <div style={{ fontSize:16, fontWeight:750, color:"#17212b" }}>{selected?.subject||t("Select a message")}</div>
          {selected && <div style={{ fontSize:11.5, color:"#687486", marginTop:5 }}>{t("From")} {selected.from}{selected.fromEmail?` · ${selected.fromEmail}`:""}</div>}
          {selected && (
            <div className="jotpanel-mail-tools">
              <button onClick={openReplyAll} disabled={!openMessage} style={mBtn()}>{t("Reply all")}</button>
              <button onClick={openForward} disabled={!openMessage} style={mBtn()}>{t("Forward")}</button>
              <button onClick={markUnread} disabled={!!busy} style={mBtn()}>{t("Mark unread")}</button>
              <button onClick={toggleFlag} disabled={!!busy} style={mBtn()}>{(selected.flags || []).includes("\\Flagged") ? t("Unflag") : t("Flag")}</button>
              <select value="" onChange={e => moveSelected(e.target.value)} disabled={!!busy}
                style={{ ...mInp, width:"auto", padding:"6px 8px" }}>
                <option value="">{t("Move to…")}</option>
                {folders.filter(f => f !== activeFolder).map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <button onClick={deleteSelected} disabled={!!busy} style={mBtn()}>{t("Delete")}</button>
              {busy && <span style={{ fontSize:11, color:"#687486", alignSelf:"center" }}>{busy}…</span>}
            </div>
          )}
        </div>
        <div className="jotpanel-mail-body">
          {selected ? (
            loadingBody ? <div className="jotpanel-mail-empty">{t("Opening the message…")}</div> : <MailBody message={openMessage} showRemote={showRemote} onShowRemote={() => setShowRemote(true)} onDownload={downloadAttachment} />
          ) : (
            <div className="jotpanel-mail-reader-empty"><span className="jotpanel-mail-reader-mark"><PanelIcon name="mail" size={32} color="#476477" /></span><strong>{t("Mail without the clutter")}</strong><span>{t("Choose a message on the left to read it here.")}</span></div>
          )}
        </div>
        {selected && (
          <div className="jotpanel-mail-reply">
            <textarea value={replyText} onChange={e => setReplyText(e.target.value)} placeholder={t("Write a reply…")}
              style={{ ...mInp, height:76, marginBottom:8, resize:"vertical" }} />
            <button onClick={sendReply} disabled={sending||!replyText.trim()} style={mBtn(true)}>
              <PanelIcon name="send" size={14} color="#fff" />{sending ? t("Sending…") : t("Send reply")}
            </button>
          </div>
        )}
        {showDelivery && (
          <div style={{ position:"absolute", inset:0, zIndex:6, background:"#f8fafb", display:"flex", flexDirection:"column" }}>
            <div style={{ display:"flex", justifyContent:"flex-end", padding:"10px 12px 0" }}>
              <button onClick={() => setShowDelivery(false)} style={mBtn()}>{t("Close")}</button>
            </div>
            <MailDeliveryScreen advice={advice} tools={tools} state={delivery} busy={busy}
              onRefresh={() => activeAccount && loadDelivery(activeAccount)}
              onFix={fix => proposeFix(fix.operation, fix.input, fix.label)}
              onQueue={(operation, id) => proposeFix(operation, { id }, operation === "mail.queue.retry" ? t("Trying {id} again", { id }) : t("Giving up on {id}", { id }))} />
            {/* The client's own status line sits under the reader, and this
                screen covers the reader. Without this, pressing a button here
                proposed the operation and said nothing at all, which is the
                same to the person as a button that does not work. */}
            {status && <div className={`jotpanel-mail-status ${statusErr ? "error" : "ok"}`}>{status}</div>}
          </div>
        )}
        {compose && (
          <div className="jotpanel-mail-compose">
            <div className="jotpanel-mail-compose-head">
              <strong>{compose.inReplyTo ? t("Reply to all") : compose.draftUid ? t("Draft") : t("New message")}</strong>
              <button onClick={() => setCompose(null)} style={mBtn()}>{t("Close")}</button>
            </div>
            <input placeholder={t("To")} value={compose.to} onChange={e => setCompose(v => ({ ...v, to:e.target.value }))} style={mInp} />
            <input placeholder={t("Cc (optional)")} value={compose.cc} onChange={e => setCompose(v => ({ ...v, cc:e.target.value }))} style={mInp} />
            <input placeholder={t("Bcc (optional)")} value={compose.bcc || ""} onChange={e => setCompose(v => ({ ...v, bcc:e.target.value }))} style={mInp} />
            <input placeholder={t("Subject")} value={compose.subject} onChange={e => setCompose(v => ({ ...v, subject:e.target.value }))} style={mInp} />
            <textarea placeholder={t("Write your message…")} value={compose.text} onChange={e => setCompose(v => ({ ...v, text:e.target.value }))} style={{ ...mInp, height:150, resize:"vertical" }} />
            {compose.attachments?.length > 0 && (
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {compose.attachments.map((a, i) => (
                  <span key={i} style={{ fontSize:11, background:"#eef2f7", border:"1px solid #cbd3dc", borderRadius:4, padding:"3px 7px", color:"#344152" }}>
                    {a.filename} · {Math.max(1, Math.round((a.size||0)/1024))} KB
                    <button onClick={() => setCompose(v => ({ ...v, attachments:v.attachments.filter((_, n) => n !== i) }))}
                      style={{ marginLeft:6, border:"none", background:"none", cursor:"pointer", color:"#a13932", fontFamily:"inherit" }}>×</button>
                  </span>
                ))}
              </div>
            )}
            {/* Told before it is sent rather than discovered when it bounces.
                Silent when there is nothing wrong with the address being sent
                from, which is most of the time and is the point. */}
            <MailComposeDeliverability advice={advice} tools={tools}
              onFix={fix => proposeFix(fix.operation, fix.input, fix.label)}
              onOpen={() => setShowDelivery(true)} />
            <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
              <label style={{ ...mBtn(), cursor:"pointer" }}>
                {t("Attach")}
                <input type="file" multiple onChange={e => { attachFiles(e.target.files); e.target.value = ""; }} style={{ display:"none" }} />
              </label>
              <button onClick={saveDraft} disabled={!!busy} style={mBtn()}>{busy === t("Saving") ? t("Saving…") : t("Save draft")}</button>
              <button onClick={sendCompose} disabled={sending || !compose.to.trim() || !compose.text.trim()} style={mBtn(true)}>
                <PanelIcon name="send" size={14} color="#fff" />{sending ? t("Sending…") : t("Send")}
              </button>
              <span style={{ fontSize:10.5, color:"#7a8594" }}>{t("Attachments up to 10 MB in total.")}</span>
            </div>
          </div>
        )}
        {status && (
          <div className={`jotpanel-mail-status ${statusErr ? "error" : "ok"}`}>{status}</div>
        )}
      </div>
    </div>
  );
}

// The name this panel answers on.
//
// The operation behind this has existed and worked for months with nothing
// drawing it, while `install.sh` told anybody who installed without a domain to
// add one "from Settings" — a screen that did not exist. So the supported answer
// was to reinstall, and the installer was telling people to do something they
// could not do.
//
// Everything that makes this risky is said before the button rather than
// discovered after it: the name has to point here already, a certificate is
// fetched from a public authority that rate-limits failures, and the panel
// restarts, so whoever is signed in is signed out for a moment. The operation
// itself refuses a name that does not resolve to this machine, and says what it
// resolved to instead; this screen exists so that refusal is rare rather than
// the way people find out.
export function PanelDomain({ ops }) {
  const [current, setCurrent] = useState("");
  const [form, setForm] = useState({ domain: "", email: "", staging: false });

  useEffect(() => {
    let live = true;
    ops?.api("/api/platform/config")
      .then(cfg => { if (live && cfg?.panelDomain) setCurrent(cfg.panelDomain); })
      .catch(() => { /* the heading simply says nothing rather than guessing */ });
    return () => { live = false; };
  }, [ops]);

  if (!ops?.can("panel.domain.set")) return null;
  const ready = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(form.domain.trim()) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  return (
    <div className="ap-card" style={{ marginBottom: 14 }}>
      <div className="ap-card-head">
        <strong>{t("The name this panel answers on")}</strong>
        <span>{current ? t("Currently {domain}", { domain: current }) : t("Not set")}</span>
      </div>
      <div className="ap-card-body" style={{ display: "flex", flexDirection: "column", gap: 9, maxWidth: 520 }}>
        <p style={{ fontSize: 12, color: "#344152", margin: 0 }}>
          {t("Point the name at this machine first. A certificate is then fetched for it and the panel restarts, so anyone signed in is signed out for a moment.")}
        </p>
        <input value={form.domain} onChange={e => setForm(v => ({ ...v, domain: e.target.value }))}
          placeholder={t("panel.example.com")} style={{ padding: "8px 10px", borderRadius: 5, border: "1px solid #cbd3dc", fontFamily: "inherit", fontSize: 12.5 }} />
        <input value={form.email} onChange={e => setForm(v => ({ ...v, email: e.target.value }))}
          placeholder={t("Contact address for the certificate")} style={{ padding: "8px 10px", borderRadius: 5, border: "1px solid #cbd3dc", fontFamily: "inherit", fontSize: 12.5 }} />
        {/* Offered because the certificate authority allows only a handful of
            failures a week for the same name. Somebody testing a new name
            should be able to find out it works without spending one. */}
        <label style={{ fontSize: 11.5, display: "flex", gap: 7, alignItems: "center", color: "#344152" }}>
          <input type="checkbox" checked={form.staging} onChange={e => setForm(v => ({ ...v, staging: e.target.checked }))} />
          {t("Use a test certificate — browsers will not trust it, but a failed attempt costs nothing")}
        </label>
        <div>
          <button className="ap-btn" disabled={!ready || !!ops.busy}
            onClick={() => ops.propose("panel.domain.set", { domain: form.domain.trim(), email: form.email.trim(), staging: form.staging })}>
            {t("Give the panel this name")}
          </button>
        </div>
      </div>
    </div>
  );
}

// The language a person reads the panel in.
//
// Their choice is remembered on their own machine and beats the default the
// host set for the whole box, which is the point of having both: a Brazilian
// hosting company ships a Portuguese panel, and its English-speaking customer
// is not stuck with it.
function LanguageChoice({ onChange }) {
  const [code, setCode] = useState(currentLanguage());
  return (
    <div className="ap-card" style={{ marginBottom: 14 }}>
      <div className="ap-card-head"><strong>{t("Language")}</strong><span>{t("Your choice, on this device")}</span></div>
      <div className="ap-card-body" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select value={code} onChange={e => { setCode(setLanguage(e.target.value)); onChange && onChange(); }}
          style={{ padding: "8px 10px", borderRadius: 5, border: "1px solid #cbd3dc", fontFamily: "inherit", fontSize: 12.5 }}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <span style={{ fontSize: 11.5, color: "#687486" }}>
          {t("Anything not yet translated stays in English rather than showing you a blank.")}
        </span>
      </div>
    </div>
  );
}

function mailDateLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit" })
                 : d.toLocaleDateString(undefined, { day:"numeric", month:"short" });
}

// A message body is a stranger's markup that arrived over the network, so the
// HTML is never put into the panel's own document. It goes into a frame with
// no script, no same-origin and no forms, and a policy that refuses every
// remote load, which is also what stops the tracking pixel in a marketing mail
// from reporting that it was opened. Loading those is the reader's decision
// and it is asked for per message, never remembered.
function MailBody({ message, showRemote, onShowRemote, onDownload }) {
  if (!message) return <div className="jotpanel-mail-empty">{t("That message could not be read.")}</div>;
  const text = (message.text || "").trim();
  const html = (message.html || "").trim();
  const policy = showRemote
    ? "default-src 'none'; img-src * data:; style-src 'unsafe-inline'"
    : "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  return (
    <div style={{ maxWidth:760 }}>
      {message.attachments?.length > 0 && (
        <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:12 }}>
          {message.attachments.map((a, i) => (
            <button key={i} onClick={() => onDownload && onDownload(a)}
              style={{ fontSize:11, background:"#eef2f7", border:"1px solid #cbd3dc", borderRadius:4, padding:"3px 7px", color:"#1d5e92", cursor:"pointer", fontFamily:"inherit" }}>
              ↓ {a.filename} · {Math.max(1, Math.round((a.size||0)/1024))} KB
            </button>
          ))}
        </div>
      )}
      {html ? (
        <>
          {!showRemote && <button onClick={onShowRemote} style={{ fontSize:11, marginBottom:8, padding:"4px 8px", borderRadius:4, border:"1px solid #cbd3dc", background:"#fff", cursor:"pointer", color:"#344152" }}>{t("Remote images are blocked. Load them for this message.")}</button>}
          <iframe title="Message" sandbox="" style={{ width:"100%", minHeight:320, border:"1px solid #e3e8ee", borderRadius:6, background:"#fff" }}
            srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>body{font:13.5px/1.7 system-ui,sans-serif;color:#2f3b49;margin:14px}img{max-width:100%}</style>${html}`} />
        </>
      ) : (
        <div style={{ fontSize:13.5, color:"#2f3b49", lineHeight:1.75, whiteSpace:"pre-wrap" }}>{text || t("This message has no readable text part.")}</div>
      )}
    </div>
  );
}


// JotPanel's control-panel tools are deliberately illustrations, not a generic
// outline-icon set. Every scene uses the same 80px canvas, ink weight and
// small ground shadow so a full page reads like one family at a glance.
function ControlToolArt({ name, size = 68 }) {
  const ink = "#18222f";
  const common = { fill:"none", stroke:ink, strokeWidth:3.4, strokeLinecap:"round", strokeLinejoin:"round" };
  const art = {
    websites: <>
      <circle cx="59" cy="20" r="10" fill="#ffbd3e"/>
      <path d="M14 58c9-13 17-19 26-19 11 0 17 8 26 19" fill="#8edbc4" stroke="none"/>
      <path {...common} d="M18 61h45M27 61V31m0 0-9 8m9-8 10 8M27 40h19"/>
      <path {...common} d="M46 40v20M46 46h15l-4.5 6 4.5 6H46" fill="#5e75f6"/>
      <circle {...common} cx="27" cy="29" r="3.5" fill="#fff"/>
    </>,
    certificate: <>
      <path {...common} d="M40 9 65 18v19c0 17-10.5 28-25 34C25.5 65 15 54 15 37V18z" fill="#8edbc4"/>
      <path {...common} d="M29 39 37 47l15-18"/>
      <circle cx="61" cy="17" r="8" fill="#ffbd3e" stroke="none"/>
      <path {...common} d="M56 17h10M61 12v10"/>
    </>,
    files: <>
      <path {...common} d="M11 28h24l7 7h27v28H11z" fill="#ffd76a"/>
      <path {...common} d="M18 22h24l5 9H18z" fill="#ff9e46"/>
      <path {...common} d="m29 47 7-5 7 5 7-5v15l-7 5-7-5-7 5z" fill="#fff"/>
      <path {...common} d="M36 42v15m7-10v15"/>
    </>,
    mover: <>
      <ellipse cx="40" cy="68" rx="27" ry="4" fill="#dbe4eb"/>
      <path {...common} d="M18 31h44v32H18z" fill="#d99a5b"/>
      <path {...common} d="m18 31 10-12h24l10 12M40 20v43" fill="#f0bc77"/>
      <path {...common} d="M25 45h10m-5-5 5 5-5 5M55 51H45m5-5-5 5 5 5"/>
      <path {...common} d="M34 19h12v12H34z" fill="#fff0cf"/>
    </>,
    mail: <>
      <path {...common} d="M16 27h48v34H16z" fill="#75c8ef"/>
      <path {...common} d="m17 29 23 19 23-19M17 59l17-17m29 17L46 42"/>
      <path {...common} d="M12 36c-6 2-8 7-7 12 4-3 8-3 11-1M68 36c6 2 8 7 7 12-4-3-8-3-11-1" fill="#fff"/>
      <circle {...common} cx="59" cy="21" r="9" fill="#ff8f67"/>
      <path {...common} d="M56 21h6"/>
    </>,
    jobs: <>
      <circle {...common} cx="40" cy="41" r="25" fill="#a5a1ff"/>
      <path {...common} d="M40 22v20l13 8"/>
      <circle {...common} cx="40" cy="41" r="3" fill="#fff"/>
      <path {...common} d="M23 17 16 10m41 7 7-7M27 69l-5 5m31-5 5 5"/>
      <path {...common} d="M29 11h22"/>
      <circle cx="64" cy="25" r="7" fill="#ffbd3e" stroke="none"/>
    </>,
    settings: <>
      <path {...common} d="M13 31h54v34H13z" fill="#ff8f67"/>
      <path {...common} d="M28 31v-8c0-5 4-9 9-9h6c5 0 9 4 9 9v8"/>
      <path {...common} d="M13 43h54M34 40h12v9H34z" fill="#ffd76a"/>
      <path {...common} d="m23 57 5-5m0 5-5-5m29 5h7"/>
    </>,
    statistics: <>
      <path {...common} d="M13 64h54"/>
      <path {...common} d="M18 64V45h11v19M35 64V31h11v33M52 64V18h11v46" fill="#75c8ef"/>
      <path {...common} d="m17 35 15-9 12 3 19-16"/>
      <path {...common} d="m56 13h7v7"/>
      <circle cx="20" cy="20" r="8" fill="#ffbd3e" stroke="none"/>
    </>,
    usage: <>
      <ellipse {...common} cx="40" cy="22" rx="24" ry="10" fill="#75c8ef"/>
      <path {...common} d="M16 22v34c0 6 11 11 24 11s24-5 24-11V22" fill="#d8f1fb"/>
      <path {...common} d="M16 39c0 6 11 11 24 11s24-5 24-11M16 55c0 6 11 11 24 11s24-5 24-11"/>
      <path {...common} d="M40 28v10m-5-5 5 5 5-5"/>
      <circle {...common} cx="62" cy="18" r="8" fill="#8edbc4"/>
    </>,
    activity: <>
      <path {...common} d="M21 17h38v51H21z" fill="#fff"/>
      <path {...common} d="M31 12h18v10H31z" fill="#ffbd3e"/>
      <path {...common} d="M29 34h22M29 44h17M29 54h12"/>
      <circle {...common} cx="57" cy="56" r="12" fill="#8edbc4"/>
      <path {...common} d="m52 56 4 4 7-9"/>
    </>,
    registration: <>
      <path {...common} d="M13 63h54"/>
      <path {...common} d="M22 63V25h29v38" fill="#a5a1ff"/>
      <path {...common} d="M51 33h12v30H51z" fill="#fff"/>
      <circle cx="44" cy="44" r="2.5" fill={ink}/>
      <circle cx="20" cy="22" r="10" fill="#ffbd3e" stroke="none"/>
      <path {...common} d="M59 23c8 0 12 4 12 9M67 21l4 11-10-3"/>
    </>,
    services: <>
      <path {...common} d="M13 15h54v18H13zM13 41h54v18H13z" fill="#75c8ef"/>
      <circle {...common} cx="24" cy="24" r="3.5" fill="#8edbc4"/>
      <circle {...common} cx="24" cy="50" r="3.5" fill="#ffbd3e"/>
      <path {...common} d="M35 24h22M35 50h22"/>
      <path {...common} d="M40 66v6M28 72h24"/>
    </>,
    logs: <>
      <path {...common} d="M18 11h30l12 12v46H18z" fill="#fff"/>
      <path {...common} d="M48 11v12h12"/>
      <path {...common} d="M26 33h20M26 42h26M26 51h16"/>
      <circle {...common} cx="57" cy="55" r="11" fill="#ffbd3e"/>
      <path {...common} d="m65 63 7 7"/>
    </>,
    databases: <>
      <ellipse {...common} cx="40" cy="19" rx="23" ry="9" fill="#8edbc4"/>
      <path {...common} d="M17 19v42c0 5 10 9 23 9s23-4 23-9V19" fill="#d7f2ea"/>
      <path {...common} d="M17 33c0 5 10 9 23 9s23-4 23-9M17 47c0 5 10 9 23 9s23-4 23-9"/>
      <circle cx="55" cy="61" r="3" fill="#ff8f67" stroke="none"/>
    </>,
    security: <>
      <path {...common} d="M40 10 66 19v20c0 17-11 28-26 33C25 67 14 56 14 39V19z" fill="#a5a1ff"/>
      <path {...common} d="M33 38h14v13H33z" fill="#fff"/>
      <path {...common} d="M36 38v-5a4 4 0 0 1 8 0v5"/>
    </>,
    console: <>
      <path d="M11 17h58v42H11z" fill="#18222f" stroke={ink} strokeWidth="3.4" strokeLinejoin="round"/>
      <path d="m22 31 8 7-8 7M36 45h16" fill="none" stroke="#8edbc4" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path {...common} d="M28 66h24M40 59v7"/>
    </>,
  };
  return <svg width={size} height={size} viewBox="0 0 80 80" role="img" aria-hidden="true">{art[name] || art.websites}</svg>;
}

function ControlToolButton({ tool, onOpen }) {
  return <button className="ap-tool" onClick={()=>onOpen(tool)} aria-label={`${tool.label}: ${tool.description}`}>
    <span className={`ap-tool-art ${tool.tone || "blue"}`}><ControlToolArt name={tool.art}/></span>
    <span className="ap-tool-name">{tool.label}<span className="ap-tool-arrow">→</span></span>
    <span className="ap-tool-description">{tool.description}</span>
    <span className={`ap-tool-status ${tool.tone || "blue"}`}>{tool.status}</span>
  </button>;
}


const PANEL_CSS = `
  .ap-shell{height:100%;display:flex;flex-direction:column;background:#f5f7fa;color:#17212b;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--ap-blue:#1d5e92;--ap-navy:#17293a;--ap-green:#167362;--ap-border:#d7dde5;--ap-muted:#687486;--ap-red:#a13932;--ap-amber:#9b6517}
  .ap-topbar{height:70px;flex:0 0 70px;display:flex;align-items:center;gap:22px;padding:0 22px;background:#fff;border-bottom:1px solid #d8dfe6;box-shadow:0 1px 0 rgba(25,39,53,.02);z-index:2}
  .ap-home-brand{appearance:none;border:0;background:transparent;padding:0;display:flex;align-items:center;gap:10px;cursor:pointer;color:#17212b;text-align:left;font:inherit;min-width:178px}.ap-home-mark{width:38px;height:38px;border-radius:10px;background:#1f607f;display:flex;align-items:center;justify-content:center;box-shadow:inset 0 -3px 0 rgba(0,0,0,.12)}.ap-home-brand strong{display:block;font-size:14px;font-weight:800;letter-spacing:.01em}.ap-home-brand small{display:block;color:#778493;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;margin-top:2px}
  .ap-tool-search{height:38px;max-width:430px;flex:1;margin:0 auto;border:1px solid #cbd4dd;border-radius:9px;background:#f7f9fb;display:flex;align-items:center;gap:9px;padding:0 11px;color:#738190}.ap-tool-search:focus-within{background:#fff;border-color:#6c98b9;box-shadow:0 0 0 3px #e6f0f6}.ap-tool-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:#1e2a36;font:12.5px inherit}.ap-tool-search input::placeholder{color:#8a96a3}.ap-tool-search button{border:0;background:transparent;color:#718090;font-size:18px;cursor:pointer;padding:0 2px}
  .ap-crumb{display:flex;align-items:center;gap:9px;flex:1;color:#87929d;font-size:11.5px}.ap-crumb button{border:0;background:transparent;color:#356581;display:flex;align-items:center;gap:6px;padding:6px 0;cursor:pointer;font:700 11.5px inherit}.ap-crumb strong{color:#263442;font-size:12px}
  .ap-top-status{margin-left:auto;display:flex;align-items:center;gap:8px;color:#405062;font-size:10.5px;white-space:nowrap}.ap-live-dot{width:8px;height:8px;border-radius:50%;background:#2b946a;box-shadow:0 0 0 3px #e3f3ec}.ap-live-dot.attention{background:#c38325;box-shadow:0 0 0 3px #fff1d9}.ap-review-pill{border:1px solid #e1c479;background:#fff8e6;color:#7b5413;border-radius:14px;padding:5px 9px;font:750 10px inherit;cursor:pointer}.ap-refresh{width:30px;height:30px;border:1px solid #d2d9e0;border-radius:7px;background:#fff;color:#4d6071;display:flex;align-items:center;justify-content:center;cursor:pointer}.ap-refresh:hover{background:#f4f7f9}.ap-refresh:disabled{opacity:.5}
  .ap-main{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;background:#f5f7fa}.ap-content{flex:1;overflow:auto;padding:12px 14px 20px}.ap-content-inner{max-width:none;margin:0}.ap-section-head{display:flex;align-items:flex-end;gap:12px;margin-bottom:14px}.ap-section-head h2{font-size:13.5px;margin:0;color:#17212b;font-weight:800}.ap-section-head p{font-size:11.5px;color:var(--ap-muted);margin:4px 0 0;line-height:1.5}.ap-section-head .ap-actions{margin-left:auto}
  .ap-launch-intro{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:0 2px 20px}.ap-eyebrow{color:#50758c;font-size:9.5px;font-weight:850;letter-spacing:.13em;text-transform:uppercase}.ap-launch-intro h1{font-size:25px;line-height:1.1;margin:5px 0 4px;color:#17212b;letter-spacing:-.025em}.ap-launch-intro p{font-size:11.5px;color:#697787;margin:0}.ap-health-ticket{min-width:238px;border:1px solid #c7ddd3;background:#f4fbf7;border-radius:9px;padding:9px 12px;display:flex;align-items:center;gap:9px;color:#176649}.ap-health-ticket.warn{border-color:#ead5a6;background:#fff9eb;color:#875610}.ap-health-ticket strong{display:block;font-size:11px}.ap-health-ticket small{display:block;font-size:9.5px;margin-top:2px;color:#65766f}.ap-health-ticket.warn small{color:#7a684c}
  .ap-tool-group{margin:0 0 10px;background:#fff;border:1px solid #dde3e9;border-radius:8px;padding:9px 10px 10px}.ap-group-heading{display:flex;align-items:center;gap:10px;margin:0 0 7px;padding-bottom:5px;border-bottom:1px solid #eaeef2}.ap-group-heading h2{font-size:10px;margin:0;color:#4b5b6a;text-transform:uppercase;letter-spacing:.09em;font-weight:850}.ap-group-heading p{font-size:9.8px;color:#7a8795;margin:2px 0 0}.ap-group-heading>span{margin-left:auto;color:#8b96a2;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .ap-tool-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:4px}.ap-tool{appearance:none;position:relative;border:1px solid transparent;border-radius:7px;background:#fff;padding:11px 6px 9px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:7px;text-align:center;color:#26333f;cursor:pointer;font:inherit;transition:background .12s ease,border-color .12s ease}.ap-tool:hover{background:#eef4f9;border-color:#c3d4e0}.ap-tool:active{background:#e2ecf4}.ap-tool:focus-visible{outline:2px solid #6ca7ce;outline-offset:1px}.ap-tool-art{width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:#e8f5fa;flex:none}.ap-tool-art svg{width:24px;height:24px}.ap-tool-art.green{background:#e6f6ef}.ap-tool-art.yellow{background:#fff4cf}.ap-tool-art.orange{background:#fff0df}.ap-tool-art.purple{background:#efedff}.ap-tool-art.coral{background:#ffebe5}.ap-tool-name{display:block;font-size:10.5px;font-weight:700;line-height:1.25;margin:0;letter-spacing:-.005em}.ap-tool-arrow{display:none}.ap-tool-description{display:none}.ap-tool-status{display:none}.ap-tool-status.amber{display:block;position:absolute;top:5px;right:6px;border-radius:9px;padding:1px 5px;background:#ffefcd;color:#8a5e17;font-size:8.4px;font-weight:800;line-height:1.5;max-width:78%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ap-no-tools{padding:38px 20px;background:#fff;border:1px dashed #c9d2da;border-radius:12px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:7px;color:#758291}.ap-no-tools strong{font-size:13px;color:#344352}.ap-no-tools span{font-size:10.5px}.ap-snapshot{display:flex;flex-wrap:wrap;align-items:stretch;border:1px solid #d9e0e6;border-radius:6px;background:#fff;margin-top:5px;overflow:hidden}.ap-snapshot>div{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;gap:6px;white-space:nowrap}.ap-snapshot-top{margin:0 0 12px}.ap-snapshot-state.good strong{color:#177355}.ap-snapshot-state.warn{background:#fff9ec}.ap-snapshot-state.warn strong{color:#8a5c10}.ap-snapshot-state strong{display:flex;align-items:center;gap:5px}.ap-snapshot>div{padding:6px 11px;border-right:1px solid #e2e7eb}.ap-snapshot>div:last-child{border-right:0}.ap-snapshot span{display:block;color:#8995a1;font-size:8.6px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;flex:none}.ap-snapshot strong{display:block;color:#31404e;font-size:10.5px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ap-snapshot strong small{color:#7e8a96;font-weight:600}
  .ap-grid-4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.ap-grid-2{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(260px,.85fr);gap:12px;margin-bottom:14px}.ap-grid-even{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:14px}
  .ap-card{background:#fff;border:1px solid var(--ap-border);border-radius:7px;box-shadow:0 1px 1px rgba(20,34,50,.025)}.ap-card-head{min-height:45px;padding:11px 14px;border-bottom:1px solid #e2e6eb;display:flex;align-items:center;gap:8px}.ap-card-head strong{font-size:12.5px}.ap-card-head span{font-size:10.5px;color:var(--ap-muted);margin-left:auto}.ap-card-body{padding:14px}
  .ap-metric{background:#fff;border:1px solid var(--ap-border);border-radius:7px;padding:13px 14px;min-height:94px}.ap-metric-top{display:flex;align-items:center;color:#596779;font-size:10.5px;font-weight:700}.ap-metric-icon{width:28px;height:28px;border:1px solid #d5dfe7;background:#eef4f8;border-radius:5px;display:flex;align-items:center;justify-content:center;margin-right:8px;color:var(--ap-blue)}.ap-metric-value{font-size:23px;line-height:1.1;font-weight:760;margin-top:12px;color:#17212b}.ap-metric-note{font-size:10px;color:#788493;margin-top:4px}
  .ap-btn{appearance:none;border:1px solid #c5ced7;background:#fff;color:#344152;border-radius:5px;padding:7px 11px;font:650 11.5px inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}.ap-btn:hover{border-color:#9cabb8;background:#f8fafb}.ap-btn:disabled{opacity:.5;cursor:default}.ap-btn.primary{border-color:#1d5e92;background:#1d5e92;color:#fff}.ap-btn.primary:hover{background:#174f7c}.ap-btn.green{border-color:#167362;background:#167362;color:#fff}.ap-btn.danger{border-color:#b96e67;color:#923a33;background:#fff8f7}.ap-btn.small{padding:5px 8px;font-size:10.5px}.ap-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
  .ap-table-wrap{overflow:auto}.ap-table{width:100%;border-collapse:collapse;font-size:11.5px}.ap-table th{text-align:left;padding:8px 12px;background:#f7f9fa;border-bottom:1px solid var(--ap-border);color:#697585;font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:800;white-space:nowrap}.ap-table td{padding:10px 12px;border-bottom:1px solid #e7eaee;color:#344152;vertical-align:middle}.ap-table tr:last-child td{border-bottom:0}.ap-table strong{color:#17212b;font-size:11.8px}.ap-table .secondary{color:#7a8594;font-size:10.5px;margin-top:2px}
  .ap-badge{display:inline-flex;align-items:center;gap:5px;border-radius:10px;border:1px solid;padding:3px 7px;font-size:9.5px;font-weight:750;text-transform:capitalize;white-space:nowrap}.ap-badge.ok{color:#176649;background:#edf8f3;border-color:#b9dfd1}.ap-badge.warn{color:#875610;background:#fff8e8;border-color:#ead5a6}.ap-badge.bad{color:#923a33;background:#fff2f0;border-color:#e4b5b0}.ap-badge.info{color:#24577e;background:#eef5fa;border-color:#c3d8e7}.ap-badge.neutral{color:#5f6b79;background:#f4f6f8;border-color:#d8dee5}
  .ap-callout{border:1px solid #c6d5df;border-left:4px solid var(--ap-blue);border-radius:6px;background:#fff;padding:12px 14px;display:flex;gap:11px;align-items:flex-start;margin-bottom:14px}.ap-callout.good{border-left-color:var(--ap-green)}.ap-callout.warn{border-left-color:#b27a25}.ap-callout.bad{border-left-color:var(--ap-red)}.ap-callout strong{display:block;font-size:12.5px;margin-bottom:3px}.ap-callout p{font-size:11px;line-height:1.5;color:#5d6a79;margin:0}.ap-callout .ap-actions{margin-left:auto;align-self:center}
  .ap-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.ap-field{display:flex;flex-direction:column;gap:5px}.ap-field.full{grid-column:1/-1}.ap-field label{font-size:10.5px;font-weight:700;color:#536172}.ap-input{width:100%;border:1px solid #c7d0d9;border-radius:5px;background:#fff;color:#17212b;padding:8px 9px;font:12px inherit;outline:none}.ap-input:focus{border-color:#5f8caf;box-shadow:0 0 0 2px #e5f0f7}.ap-field small{font-size:9.8px;color:#7b8795;line-height:1.4}.ap-check{display:flex;align-items:flex-start;gap:8px;font-size:11.5px;color:#465466;line-height:1.45}.ap-check input{margin-top:2px}
  .ap-empty{padding:30px 20px;display:flex;flex-direction:column;align-items:center;text-align:center;color:#758190;font-size:11.5px;gap:7px}.ap-empty strong{font-size:13px;color:#405062}.ap-list-row{padding:11px 13px;border-bottom:1px solid #e4e8ec;display:flex;gap:10px;align-items:flex-start}.ap-list-row:last-child{border-bottom:0}.ap-list-icon{width:28px;height:28px;flex:0 0 28px;border-radius:5px;background:#eef4f8;border:1px solid #d5dfe7;display:flex;align-items:center;justify-content:center;color:#2b638d}.ap-list-title{font-size:11.8px;font-weight:700;color:#263340}.ap-list-note{font-size:10.5px;color:#738090;line-height:1.45;margin-top:3px}.ap-list-row .ap-actions{margin-left:auto;align-self:center}
  .ap-chart{height:235px;padding:12px 14px 5px}.ap-chart svg{width:100%;height:190px;display:block}.ap-chart-labels{display:flex;justify-content:space-between;color:#82909e;font-size:9.5px;padding:0 7px}.ap-rank{display:flex;align-items:center;gap:8px;margin-bottom:11px}.ap-rank:last-child{margin-bottom:0}.ap-rank-label{width:105px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:#465466}.ap-rank-track{height:7px;background:#e9edf1;flex:1;border-radius:2px;overflow:hidden}.ap-rank-fill{height:100%;background:#477da5;transition:width .3s ease}.ap-rank-track.warn .ap-rank-fill{background:#d9a441}.ap-rank-track.bad .ap-rank-fill{background:#c05a4e}.ap-rank-value small{color:#7a8794;font-weight:600}.ap-rank-value{width:35px;text-align:right;font-size:10px;color:#687486}
  .ap-step{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #e7eaee}.ap-step:last-child{border:0}.ap-step-num{width:22px;height:22px;border-radius:50%;background:#e9f1f6;color:#1d5e92;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex:0 0 22px}.ap-step strong{font-size:11.5px}.ap-step p{font-size:10.5px;color:#6b7786;margin:3px 0 0;line-height:1.45}
  .ap-notice{position:sticky;bottom:0;margin:12px auto 0;max-width:720px;padding:9px 12px;border-radius:5px;background:#17293a;color:#fff;font-size:11px;box-shadow:0 4px 14px rgba(15,29,42,.2);z-index:3}.ap-notice.error{background:#8e3731}
  .ap-toolbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:9px 12px;border-bottom:1px solid #e6eaee;background:#fbfcfd}.ap-toolbar .ap-input{width:auto;min-width:0;flex:0 1 190px;padding:6px 8px;font-size:11.5px}.ap-toolbar select.ap-input{flex:0 1 auto}.ap-toolbar label{font-size:10.5px;font-weight:700;color:#5b6878}.ap-toolbar .spacer{margin-left:auto}
  .ap-logpane{background:#132330;color:#d3e2ee;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:11px 13px;max-height:430px;overflow:auto;white-space:pre-wrap;word-break:break-word}.ap-logpane .ap-loghit{color:#ffd76a}.ap-logpane .num{color:#6b8397;user-select:none}
  .ap-gate{border:1px dashed #cdd6de;border-radius:6px;background:#fafbfc;padding:13px 15px;color:#68747f;font-size:11.5px;line-height:1.55;display:flex;gap:11px;align-items:flex-start;margin-bottom:12px}.ap-gate strong,.ap-gate-reason{display:block}.ap-gate strong{color:#3f4d5c;font-size:12px;margin-bottom:3px}.ap-gate code{font:10.5px ui-monospace,Menlo,monospace;background:#eef1f4;border-radius:3px;padding:1px 4px}
  .ap-offlist{border:1px solid #e3e8ec;border-radius:6px;background:#fbfcfd;padding:8px 11px;margin-top:7px}.ap-offlist h3{margin:0 0 5px;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:#8b96a2;font-weight:850}.ap-offlist div{font-size:10.5px;color:#6d7986;line-height:1.5;padding:2px 0}.ap-offlist b{color:#4c5a68;font-weight:700}
  .ap-mono{font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .ap-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:#b9c3cc}.ap-dot.on{background:#2b946a}.ap-dot.off{background:#c0563f}
  .ap-scroll{max-height:420px;overflow:auto}
  /* Files, Mail and Settings are the same components the desktop opens in a
     window. A window supplies their ground and their palette; inside the panel
     this does, by redeclaring the OS tokens in the panel's own light values.
     The components are untouched and there is no second copy of them: they
     read --os-* wherever they are mounted and get whichever shell they are in.
     --os-ink is the one that does most of the work, because almost every
     surface in those apps is a translucent layer mixed from it. */
  .ap-embed{
    --os-ink:23,33,43;
    --os-win:#fff; --os-panel:#f7f9fb; --os-bar:#f2f5f8; --os-title:#eef2f6;
    --os-hover:rgba(23,33,43,.05); --os-active:rgba(23,33,43,.09);
    --os-border:#dbe1e8; --os-inpbg:#fff;
    --os-txt:#17212b; --os-txt2:#5d6a79; --os-txt3:#8b96a2;
    --os-accent-bg:#1d5e92; --os-accent-border:#1d5e92; --os-accent-txt:#fff;
    --os-accent-soft:#eaf2f8;
    --os-danger-bg:#fff5f4; --os-danger-border:#e0b4ae; --os-danger-txt:#923a33;
    height:calc(100vh - 190px);min-height:420px;border:1px solid var(--ap-border);
    border-radius:7px;overflow:hidden;background:var(--os-win);color:var(--os-txt);position:relative
  }
  /* Inputs inside an embedded app are drawn by the app, not by PANEL_CSS, so
     they need the panel's border rather than the desktop's translucent one. */
  .ap-embed input,.ap-embed textarea,.ap-embed select{border-color:var(--os-border)}
  .ap-signout{border:1px solid #d2d9e0;background:#fff;color:#4d6071;border-radius:7px;padding:5px 9px;font:650 10.5px inherit;cursor:pointer}.ap-signout:hover{background:#f4f7f9}
  .ap-workspace{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
  .ap-shell.standalone{flex-direction:row;font-size:12px;background:#eef1f4}
  .ap-shell.standalone *{border-radius:0!important}
  .ap-sidebar{width:214px;flex:0 0 214px;background:#17212b;color:#d9e0e7;border-right:1px solid #0c151d;display:flex;flex-direction:column;overflow:auto}
  .ap-sidebar-title{height:44px;display:flex;align-items:center;padding:0 14px;border-bottom:1px solid #2a3742;font-size:12px;font-weight:800;color:#fff}
  .ap-sidebar-group{padding:10px 8px 3px;color:#7f8d99;font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
  .ap-sidebar-search{width:100%;background:#0f1922;border:1px solid #2a3742;color:#d9e0e7;padding:6px 8px;font:600 11px/1.2 inherit;outline:none}
  .ap-sidebar-search:focus{border-color:#64a0c4}
  .ap-sidebar-search::placeholder{color:#6b7a86}
  .ap-sidebar button{appearance:none;width:100%;border:0;border-left:3px solid transparent;background:transparent;color:#b9c4ce;text-align:left;padding:7px 10px;font:600 11px/1.2 inherit;cursor:pointer}
  .ap-sidebar button:hover{background:#202d38;color:#fff}.ap-sidebar button.active{background:#263744;border-left-color:#64a0c4;color:#fff}
  .ap-sidebar-foot{margin-top:auto;border-top:1px solid #2a3742;padding:8px}.ap-sidebar-foot button{color:#96a4b0}
  .ap-shell.standalone .ap-topbar{height:44px;flex:0 0 44px;padding:0 12px;gap:0;background:#fff;box-shadow:none}
  .ap-machine-name{font-weight:800;color:#182531;padding-right:16px;min-width:180px}.ap-machine-platform{font-weight:500;color:#7b8793;margin-left:6px;font-size:10px}
  .ap-machine-metric{height:44px;min-width:116px;border-left:1px solid #e0e4e8;padding:7px 12px;display:flex;flex-direction:column;justify-content:center}.ap-machine-metric span{font-size:8.5px;text-transform:uppercase;letter-spacing:.08em;color:#7b8793;font-weight:800}.ap-machine-metric strong{font-size:11px;color:#2c3945;margin-top:2px}
  .ap-shell.standalone .ap-top-status{border-left:1px solid #e0e4e8;padding-left:12px}.ap-shell.standalone .ap-content{padding:10px 12px 18px}.ap-shell.standalone .ap-section-head{align-items:center;margin-bottom:8px;min-height:28px}.ap-shell.standalone .ap-section-head h2{font-size:12px}.ap-shell.standalone .ap-section-head p{display:none}
  .ap-shell.standalone .ap-card,.ap-shell.standalone .ap-metric,.ap-shell.standalone .ap-tool-group{box-shadow:none}.ap-shell.standalone .ap-card-head{min-height:34px;padding:7px 9px}.ap-shell.standalone .ap-card-body{padding:9px}.ap-shell.standalone .ap-table{font-size:11px}.ap-shell.standalone .ap-table th{padding:6px 8px}.ap-shell.standalone .ap-table td{padding:7px 8px}.ap-shell.standalone .ap-btn{padding:5px 8px;font-size:10.5px}.ap-shell.standalone .ap-input{padding:6px 7px;font-size:11px}
  .ap-setup-doors{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid #cdd5dc;margin-top:10px}.ap-setup-door{min-height:58px;padding:8px;border:0;border-right:1px solid #d8dee4;background:#fff;color:#344250;text-align:left;text-decoration:none;font:inherit;cursor:pointer;display:block}.ap-setup-door:last-child{border-right:0}.ap-setup-door:hover{background:#f3f6f8}.ap-setup-door b{display:block;font-size:10.5px}.ap-setup-door span{display:block;font-size:9.5px;color:#75818d;margin-top:3px}
  .ap-operator-table{margin-bottom:10px}.ap-operator-table .ap-state{width:130px}.ap-operator-table .ap-row-action{width:90px;text-align:right}
  @media(max-width:900px){
    .ap-shell.standalone{flex-direction:column}
    .ap-sidebar{width:auto;flex:0 0 auto;flex-direction:row;overflow-x:auto;overflow-y:hidden;gap:2px;padding:0 8px;border-right:0;border-bottom:1px solid #0c151d;-webkit-overflow-scrolling:touch}
    .ap-sidebar>div{display:flex;align-items:center;gap:2px}
    .ap-sidebar-title,.ap-sidebar-group,.ap-sidebar-foot{display:none}
    .ap-sidebar button{white-space:nowrap;padding:11px 12px;border-left:0;border-bottom:2px solid transparent}
    .ap-sidebar button.active{border-left:0;border-bottom-color:#5b9dd9;background:transparent}
    .ap-workspace{min-width:0}
    .ap-snapshot{grid-template-columns:repeat(2,minmax(0,1fr))}
    .ap-tool-grid{grid-template-columns:repeat(auto-fill,minmax(84px,1fr))}
    .ap-table-wrap{overflow-x:auto}
    .ap-topbar{overflow-x:auto;gap:0}
    .ap-machine-metric{flex:0 0 auto;padding:0 12px}
    .ap-machine-name{flex:0 0 auto;padding-right:12px}
    .ap-grid-2,.ap-grid-4,.ap-grid-even{grid-template-columns:1fr}
.ap-topbar{padding:0 14px;gap:12px}.ap-home-brand{min-width:150px}.ap-tool-grid{grid-template-columns:repeat(auto-fill,minmax(90px,1fr))}.ap-grid-4{grid-template-columns:repeat(2,1fr)}.ap-grid-2,.ap-grid-even{grid-template-columns:1fr}.ap-content{padding:18px 16px 26px}.ap-form{grid-template-columns:1fr}.ap-field.full{grid-column:auto}.ap-launch-intro{align-items:flex-start}.ap-snapshot>div{flex:1 1 46%}.ap-snapshot>div:nth-child(2){border-right:0}.ap-snapshot>div:nth-child(-n+2){border-bottom:1px solid #e2e7eb}}
  @media(max-width:650px){.ap-home-brand small,.ap-top-status>span:not(.ap-live-dot){display:none}.ap-home-brand{min-width:auto}.ap-tool-search{max-width:none}.ap-launch-intro{display:block}.ap-health-ticket{margin-top:12px}.ap-tool-grid{grid-template-columns:repeat(auto-fill,minmax(84px,1fr))}.ap-group-heading p{display:none}.ap-crumb strong{display:none}}

  /* ── Newspaper. One marked block, delete it whole to go back. ──────
     Flat, because flat is also cheap: no gradients, no shadows, nothing
     to load. DirectAdmin's own forum measures twenty-four to thirty
     second loads against VestaCP's two to three, so weight is the thing
     to avoid, and a broadsheet is the one look that gets denser and
     faster at the same time. Hierarchy comes from rules and type rather
     than from depth and colour. */
  .ap-card{border-radius:0;box-shadow:none;border-color:#c9d1d9}
  .ap-card-head{border-bottom:1px solid #18222f;background:transparent}
  .ap-card-head strong{letter-spacing:-.01em}
  .ap-tool{border-radius:0;border-color:transparent}
  .ap-tool:hover{background:#f4f6f8;border-color:#c9d1d9}
  /* The mark stands on the page rather than sitting in a coloured chip. */
  .ap-tool-art{background:transparent;border-radius:0;width:34px;height:34px}
  .ap-tool-art.blue,.ap-tool-art.green,.ap-tool-art.coral,
  .ap-tool-art.orange,.ap-tool-art.yellow,.ap-tool-art.purple{background:transparent}
  .ap-tool-name{font-size:10.5px;letter-spacing:.01em}
  /* A section head is a masthead rule, heavy above and hairline below. */
  .ap-tool-group{border-top:2px solid #18222f;padding-top:9px}
  .ap-group-heading{border-bottom:1px solid #c9d1d9;padding-bottom:6px}
  .ap-group-heading h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase}
  .ap-badge{border-radius:0}
  .ap-btn{border-radius:0}
  .ap-input,.ap-field input,.ap-field select,.ap-field textarea{border-radius:0}
  .ap-table thead th{border-bottom:1px solid #18222f;letter-spacing:.07em}
  .ap-rank-track{border-radius:0}
  .ap-snapshot{border-radius:0}
  .ap-gate,.ap-empty,.ap-notice,.ap-callout,.ap-offlist{border-radius:0}
  .ap-setup-door{border-radius:0}
`;

function panelFormatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function panelDate(value, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], includeTime
    ? { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }
    : { day:"numeric", month:"short", year:"numeric" });
}

function PanelBadge({ tone = "neutral", children }) {
  return <span className={`ap-badge ${tone}`}>{children}</span>;
}

function certificateTone(status) {
  if (status === "healthy") return "ok";
  if (["warning", "not_configured"].includes(status)) return "warn";
  if (["critical", "expired", "invalid", "unreachable"].includes(status)) return "bad";
  return "neutral";
}

function actionTone(status) {
  if (status === "executed") return "ok";
  if (status === "approved" || status === "executing") return "info";
  if (status === "failed") return "bad";
  // Interrupted is not a failure and must not be coloured as one. It means the
  // panel stopped while the action was running and the outcome was never seen.
  if (status === "pending" || status === "interrupted") return "warn";
  return "neutral";
}

// Which sites are actually being counted, and how to start counting the ones
// that are not.
//
// This exists because of the shape of the traffic feature: a site gains its
// log line when its configuration is written, and nothing rewrites the ones
// that already existed. So on a machine with a history the graph reads zero and
// is right to. Saying nothing would be the worst of the three options — a
// customer would conclude the panel cannot count, rather than that it has not
// been asked to yet.
function StatisticsCoverage({ ops }) {
  const coverage = useServerRead(ops?.api, "statistics-coverage", "", !!ops?.can("site.statistics.status"));
  const sites = coverage.data?.sites || [];
  const waiting = sites.filter(site => !site.counted && site.safe);
  const blocked = sites.filter(site => !site.counted && !site.safe);
  if (!sites.length || (!waiting.length && !blocked.length)) return null;
  return (
    <div className="ap-card" style={{ marginBottom: 14 }}>
      <div className="ap-card-head">
        <strong>{t("Some sites are not being counted yet")}</strong>
        <span>{t("{n} of {total} counted", { n: sites.length - waiting.length - blocked.length, total: sites.length })}</span>
      </div>
      <div className="ap-card-body">
        {waiting.length > 0 && (
          <>
            <p style={{ fontSize: 12, color: "#344152", marginTop: 0 }}>
              {t("These sites were set up before traffic counting existed. Adding it rewrites their web-server configuration and reloads it, so it is offered rather than done quietly:")}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {waiting.map(site => <span key={site.domain} className="ap-rank-label">{site.domain}</span>)}
            </div>
            {ops?.can("site.statistics.enable") && (
              <button className="ap-btn" disabled={!!ops.busy} onClick={() => ops.propose("site.statistics.enable", {})}>
                {t("Start counting these")}
              </button>
            )}
          </>
        )}
        {/* Named rather than swept along. Rewriting one of these would throw
            away whatever somebody added by hand, and the panel does not know
            what that was or whether it mattered. */}
        {blocked.length > 0 && (
          <div style={{ marginTop: waiting.length ? 14 : 0 }}>
            <p style={{ fontSize: 12, color: "#344152", marginTop: 0 }}>
              {t("These cannot be done automatically, because their configuration has been edited outside the panel and rewriting it would discard those changes:")}
            </p>
            {blocked.map(site => (
              <div key={site.domain} className="ap-rank">
                <div className="ap-rank-label">{site.domain}</div>
                <div className="ap-rank-value" style={{ fontSize: 11, color: "#7a8594" }}>{site.reason}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PanelStatistics({ data }) {
  const daily = data?.daily || [];
  const max = Math.max(1, ...daily.map(d => Number(d.pageviews || 0)));
  const width = 760, height = 170, pad = 12;
  const points = daily.map((d, i) => {
    const x = daily.length < 2 ? width / 2 : pad + i * ((width - pad * 2) / (daily.length - 1));
    const y = height - pad - (Number(d.pageviews || 0) / max) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const total = data?.totals || {};
  const ranks = (rows, key = "pageviews") => {
    const best = Math.max(1, ...rows.map(r => Number(r[key] || r.count || 0)));
    return rows.slice(0, 6).map((row, i) => {
      const label = row.path || row.source || row.device || t("Direct / none");
      const value = Number(row[key] || row.count || 0);
      return <div className="ap-rank" key={`${label}-${i}`}><div className="ap-rank-label" title={label}>{label}</div><div className="ap-rank-track"><div className="ap-rank-fill" style={{ width:`${(value / best) * 100}%` }} /></div><div className="ap-rank-value">{value}</div></div>;
    });
  };
  return <>
    <div className="ap-grid-4">
      <div className="ap-metric"><div className="ap-metric-top"><span className="ap-metric-icon"><PanelIcon name="statistics" size={15}/></span>{t("Page views")}</div><div className="ap-metric-value">{Number(total.pageviews || 0).toLocaleString()}</div><div className="ap-metric-note">{t("{count}{countvalue}% from prior period", { count: Number(total.pageviews_change_pct || 0) >= 0 ? "+" : "", countvalue: Number(total.pageviews_change_pct || 0) })}</div></div>
      <div className="ap-metric"><div className="ap-metric-top"><span className="ap-metric-icon"><PanelIcon name="user" size={15}/></span>{t("Visitors")}</div><div className="ap-metric-value">{Number(total.visitors || 0).toLocaleString()}</div><div className="ap-metric-note">{t("One-way count; no raw IP stored")}</div></div>
      <div className="ap-metric"><div className="ap-metric-top"><span className="ap-metric-icon"><PanelIcon name="globe" size={15}/></span>{t("Active sites")}</div><div className="ap-metric-value">{Number(total.sites || 0)}</div><div className="ap-metric-note">{t("Sites receiving verified visits")}</div></div>
      <div className="ap-metric"><div className="ap-metric-top"><span className="ap-metric-icon"><PanelIcon name="statistics" size={15}/></span>{t("Hits")}</div><div className="ap-metric-value">{Number(total.hits || 0).toLocaleString()}</div><div className="ap-metric-note">{panelFormatBytes(total.bandwidth)}{t(" served · ")}{Number(total.bot_hits || 0).toLocaleString()}{t(" bot hits")}</div></div>
    </div>
    {data?.access_logs?.filter(item => !item.ok).map(item => <div className="ap-notice warn" key={item.path}><strong>{t("Website traffic is not being counted")}</strong><span>{item.reason}</span></div>)}
    <div className="ap-grid-2">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Visits over the last {count} days", { count: data?.period?.days || 30 })}</strong><span>{t("verified ")}{panelDate(data?.generated_at, true)}</span></div><div className="ap-chart">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("Daily page views")}>
          {[.25,.5,.75,1].map(n => <line key={n} x1={pad} x2={width-pad} y1={height-pad-n*(height-pad*2)} y2={height-pad-n*(height-pad*2)} stroke="#e1e6eb" strokeWidth="1" />)}
          {points && <><polyline points={`${pad},${height-pad} ${points} ${width-pad},${height-pad}`} fill="#eaf2f7" stroke="none"/><polyline points={points} fill="none" stroke="#1d5e92" strokeWidth="2.4" vectorEffect="non-scaling-stroke"/></>}
        </svg>
        <div className="ap-chart-labels"><span>{panelDate(daily[0]?.day)}</span><span>{daily.every(d => !d.pageviews) ? t("No verified visits in this period") : t("{count} peak daily views", { count: max.toLocaleString() })}</span><span>{panelDate(daily[daily.length-1]?.day)}</span></div>
      </div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Top pages")}</strong><span>{t("page views")}</span></div><div className="ap-card-body">{data?.top_pages?.length ? ranks(data.top_pages) : <div className="ap-empty"><PanelIcon name="document" size={25}/><strong>{t("No page data yet")}</strong><span>{t("Published JotNotes sites record visits here automatically.")}</span></div>}</div></div>
    </div>
    <div className="ap-grid-even">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Where visits came from")}</strong><span>{t("referrer domains only")}</span></div><div className="ap-card-body">{data?.sources?.length ? ranks(data.sources, "visits") : <div className="ap-empty"><strong>{t("No sources recorded")}</strong></div>}</div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Devices")}</strong><span>{t("browser category")}</span></div><div className="ap-card-body">{data?.devices?.length ? ranks(data.devices, "visits") : <div className="ap-empty"><strong>{t("No device data recorded")}</strong></div>}</div></div>
    </div>
    <div className="ap-grid-even">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Status codes")}</strong><span>{t("404s and server responses")}</span></div><div className="ap-card-body">{data?.statuses?.length ? data.statuses.map(row => <div className="ap-rank" key={row.status}><div className="ap-rank-label">HTTP {row.status}</div><div className="ap-rank-value">{Number(row.hits).toLocaleString()}</div></div>) : <div className="ap-empty"><strong>{t("No responses recorded")}</strong></div>}</div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Entry pages")}</strong><span>{t("direct and external arrivals")}</span></div><div className="ap-card-body">{data?.entry_pages?.length ? ranks(data.entry_pages, "entries") : <div className="ap-empty"><strong>{t("No entry pages recorded")}</strong></div>}</div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Traffic by hour")}</strong><span>{t("people, UTC")}</span></div><div className="ap-card-body">{data?.hourly?.length ? data.hourly.map(row => <div className="ap-rank" key={row.hour}><div className="ap-rank-label">{row.hour}:00</div><div className="ap-rank-value">{Number(row.hits).toLocaleString()}</div></div>) : <div className="ap-empty"><strong>{t("No hourly traffic recorded")}</strong></div>}</div></div>
    </div>
    <div className="ap-notice"><strong>{t("Privacy")}</strong><span>{data?.privacy || t("Unique visitors use a one-way server hash. Raw IP addresses are not stored.")}</span></div>
  </>;
}

// ── Server operations ─────────────────────────────────────────────
// Every screen below draws itself from what the server said it can do. There
// is no local list of features: if the engine underneath does not provide the
// capability, the control is not rendered and its reason is printed instead.

function useServerRead(api, resource, query, enabled) {
  const [state, setState] = useState({ loading: !!enabled, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) { setState({ loading:false, data:null, error:null }); return undefined; }
    let live = true;
    setState(previous => ({ ...previous, loading:true }));
    api(`/api/panel/server/read/${resource}${query ? `?${query}` : ""}`)
      .then(data => { if (live) setState({ loading:false, data, error:null }); })
      .catch(error => { if (live) setState({ loading:false, data:null, error:error.message }); });
    return () => { live = false; };
  }, [api, resource, query, enabled, nonce]);
  return { ...state, reload: () => setNonce(n => n + 1) };
}

// A number in a table is read; a bar is glanced at. Everything on this landing
// is something an operator checks rather than reads, so it is a bar with a
// colour that changes at the point where it starts to matter.
function meterTone(value, of) {
  const percent = of ? (Number(value) / Number(of)) * 100 : Number(value);
  if (!Number.isFinite(percent)) return "";
  if (percent >= 90) return "bad";
  if (percent >= 70) return "warn";
  return "";
}

function PanelMeter({ label, value, of, percent, unit, note, tone }) {
  const filled = percent != null ? Number(percent)
    : (of ? Math.min(100, (Number(value) / Number(of)) * 100) : null);
  const shown = percent != null ? `${Math.round(Number(percent))}%`
    : (value == null ? "—" : `${value}${unit ? ` ${unit}` : ""}${of ? ` / ${of}` : ""}`);
  return <div className="ap-rank">
    <div className="ap-rank-label">{label}</div>
    <div className={`ap-rank-track ${tone || ""}`}><div className="ap-rank-fill" style={{width:`${Math.max(0, Math.min(100, filled || 0))}%`}}/></div>
    <div className="ap-rank-value">{shown}{note?<small> · {note}</small>:null}</div>
  </div>;
}

export function serverUnavailableMessage(area) {
  if (area === "mailadmin" || String(area || "").startsWith("mail.")) return t("The mail server is not installed yet");
  if (area === "databases" || String(area || "").startsWith("database.")) return t("The database server is not installed yet");
  return t("This isn't available on this server yet");
}

function ServerReason({ reason }) {
  if (!reason) return null;
  return <details style={{marginTop:5}}><summary style={{fontSize:10.5,cursor:"pointer",color:"#667385"}}>{t("Details")}</summary><span className="ap-gate-reason">{reason}</span></details>;
}

function ServerGate({ reason, title, area, setup, ops }) {
  return <div className="ap-gate"><PanelIcon name="alert" size={17}/><div style={{flex:1}}><strong>{title || serverUnavailableMessage(area)}</strong><ServerReason reason={reason}/>{setup && <div className="ap-setup-doors">
    {/* A section may have more than one thing worth installing. Databases has
        two engines and offering only the first is how an operation exists with
        no button in front of it. */}
    {(Array.isArray(setup.install) ? setup.install : [setup.install]).map(door => (
      <button key={door.operation} className="ap-setup-door" disabled={!!ops?.busy} onClick={()=>ops?.propose(door.operation,{})}><b>{door.label}</b><span>{t("One approval, then verify it here")}</span></button>
    ))}
    <a className="ap-setup-door" href={setup.buy.href} target="_blank" rel="noreferrer"><b>{setup.buy.label}</b><span>{t("Open the provider in a new tab")}</span></a>
    <button className="ap-setup-door" onClick={()=>ops?.connect(setup.connect.kind)}><b>{setup.connect.label}</b><span>{t("Use connection settings you already have")}</span></button>
  </div>}</div></div>;
}

function ServerLoad({ state, empty, children }) {
  if (state.loading) return <div className="ap-empty"><strong>{t("Reading the server…")}</strong></div>;
  if (state.error) return <div className="ap-empty"><PanelIcon name="alert" size={24}/><strong>{t("The server would not answer")}</strong><span>{state.error}</span></div>;
  if (!state.data) return <div className="ap-empty"><strong>{empty || t("Nothing to show")}</strong></div>;
  return children(state.data);
}

function panelBytes(value) { return value == null ? "—" : panelFormatBytes(value); }
function panelDuration(seconds) {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function ServerResourceHistory({ ops }) {
  const history = useServerRead(ops.api, "system-metrics-history", "", ops.can("system.metrics.history"));
  const charts = [
    { field:"cpu_percent", label:t("Processor"), suffix:"%", ceiling:100 },
    { field:"memory_percent", label:t("Memory"), suffix:"%", ceiling:100 },
    { field:"disk_percent", label:t("Disk"), suffix:"%", ceiling:100 },
    { field:"load_1", label:t("Load"), suffix:"", ceiling:null },
  ];
  return <div className="ap-card" style={{marginBottom:12}}>
    <div className="ap-card-head"><strong>{t("Machine resources over time")}</strong><span>{history.data?.samples?.length ? t("{count} samples", { count: history.data.samples.length }) : t("short history")}</span>{ops.can("system.metrics.history")&&<button className="ap-btn small" style={{marginLeft:8}} onClick={()=>history.reload()}><PanelIcon name="refresh" size={12}/></button>}</div>
    {!ops.can("system.metrics.history") ? <div className="ap-card-body"><ServerGate reason={ops.why("system.metrics.history")}/></div> : <ServerLoad state={history} empty={t("No resource samples yet")}>{data => {
      const samples = data.samples || [];
      if (!samples.length) return <div className="ap-empty"><strong>{t("No resource samples yet")}</strong><span>{t("The first points appear after the sampler has run.")}</span></div>;
      return <div className="ap-grid-2" style={{padding:12,margin:0}}>{charts.map(chart => {
        const values = samples.map(sample => Number(sample[chart.field])).filter(Number.isFinite);
        const top = chart.ceiling || Math.max(1, ...values);
        const width = 360, height = 92, pad = 8;
        const points = values.map((value, index) => {
          const x = values.length < 2 ? width / 2 : pad + index * ((width - pad * 2) / (values.length - 1));
          const y = height - pad - (Math.max(0, Math.min(top, value)) / top) * (height - pad * 2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
        const latest = values[values.length - 1];
        return <div className="ap-card" key={chart.field}>
          <div className="ap-card-head"><strong>{chart.label}</strong><span>{Number.isFinite(latest) ? `${latest.toFixed(chart.suffix ? 0 : 2)}${chart.suffix}` : "—"}</span></div>
          <div className="ap-chart" style={{padding:10}}><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("{label} history", { label: chart.label })}>
            {[.25,.5,.75,1].map(n => <line key={n} x1={pad} x2={width-pad} y1={height-pad-n*(height-pad*2)} y2={height-pad-n*(height-pad*2)} stroke="#e1e6eb" strokeWidth="1"/>)}
            {points && <polyline points={points} fill="none" stroke="#1d5e92" strokeWidth="2.2" vectorEffect="non-scaling-stroke"/>}
          </svg><div className="ap-chart-labels"><span>{panelDate(samples[0]?.at,true)}</span><span>{panelDate(samples[samples.length-1]?.at,true)}</span></div></div>
        </div>;
      })}</div>;
    }}</ServerLoad>}
  </div>;
}

function ServerServices({ ops }) {
  const [named, setNamed] = useState("");
  const [filter, setFilter] = useState("");
  const [detail, setDetail] = useState(null);
  const [procQuery, setProcQuery] = useState("");
  const [procApplied, setProcApplied] = useState("");
  const [procSort, setProcSort] = useState("cpu");
  const services = useServerRead(ops.api, "services", "", ops.can("service.list"));
  const processes = useServerRead(ops.api, "processes", `search=${encodeURIComponent(procApplied)}&sort=${procSort}`, ops.can("process.list"));
  const verbs = [["service.restart",t("Restart")],["service.reload",t("Reload")],["service.stop",t("Stop")],["service.start",t("Start")]];

  const showStatus = async unit => {
    setDetail({ unit, loading:true });
    try { setDetail({ unit, data: await ops.api(`/api/panel/server/read/service?unit=${encodeURIComponent(unit)}`) }); }
    catch (error) { setDetail({ unit, error: error.message }); }
  };

  return <>
    <div className="ap-section-head"><div><h2>{t("Services and processes")}</h2><p>{t("Naming a service works for anything the machine runs, including Tomcat and the mail server.")}</p></div>
      {ops.can("system.reboot") && <div className="ap-actions"><button className="ap-btn danger" disabled={!!ops.busy} onClick={()=>ops.propose("system.reboot",{})}>{t("Restart the machine")}</button></div>}</div>

    <ServerResourceHistory ops={ops}/>

    {!ops.can("service.list") ? <ServerGate reason={ops.why("service.list")} title={t("Service control is not available here")}/> : <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-toolbar">
        <input className="ap-input" value={filter} onChange={e=>setFilter(e.target.value)} placeholder={t("Filter services")}/>
        <span className="spacer"/>
        <input className="ap-input" value={named} onChange={e=>setNamed(e.target.value)} placeholder={"tomcat9"}/>
        {ops.can("service.control") && <button className="ap-btn" disabled={!!ops.busy||!named.trim()} onClick={()=>ops.propose("service.restart",{unit:named.trim()})}>{t("Restart named service")}</button>}
        <button className="ap-btn small" onClick={()=>services.reload()}><PanelIcon name="refresh" size={12}/></button>
      </div>
      <ServerLoad state={services} empty={t("No services were listed")}>{data => {
        const rows = (data.services||[]).filter(s => !filter.trim() || `${s.unit} ${s.description||""}`.toLowerCase().includes(filter.trim().toLowerCase()));
        return <div className="ap-table-wrap ap-scroll"><table className="ap-table"><thead><tr><th>{t("Service")}</th><th>{t("State")}</th><th>{t("Uptime")}</th><th>{t("Actions")}</th></tr></thead><tbody>
          {rows.map(service => <tr key={service.unit}>
            <td><strong>{service.unit}</strong><div className="secondary">{service.description||"—"}</div></td>
            <td><span className={`ap-dot ${service.active==="active"?"on":service.active==="failed"?"off":""}`}/>{service.active}<div className="secondary">{service.sub}</div></td>
            <td className="ap-mono">{service.uptime_seconds!=null?panelDuration(service.uptime_seconds):"—"}</td>
            <td><div className="ap-actions">
              {ops.can("service.status") && <button className="ap-btn small" onClick={()=>showStatus(service.unit)}>{t("Status")}</button>}
              {ops.can("service.control") && verbs.map(([op,label]) => <button key={op} className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose(op,{unit:service.unit})}>{label}</button>)}
            </div></td>
          </tr>)}
          {!rows.length && <tr><td colSpan={4}>{t("Nothing matches “{filter}”.", { filter: filter })}</td></tr>}
        </tbody></table></div>;
      }}</ServerLoad>
      {!ops.can("service.control") && <div style={{padding:"9px 12px",borderTop:"1px solid #e6eaee"}}><ServerGate reason={ops.why("service.control")} title={t("Reading only")}/></div>}
    </div>}

    {detail && <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{detail.unit}</strong><span>{t("read from the service manager just now")}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>setDetail(null)}>{t("Close")}</button></div>
      <div className="ap-card-body">
        {detail.loading && t("Reading…")}
        {detail.error && <PanelBadge tone="bad">{detail.error}</PanelBadge>}
        {detail.data && <div className="ap-grid-4">
          <div className="ap-metric"><div className="ap-metric-top">{t("State")}</div><div className="ap-metric-value" style={{fontSize:18}}>{detail.data.active}</div><div className="ap-metric-note">{detail.data.sub} · {detail.data.enabled}</div></div>
          <div className="ap-metric"><div className="ap-metric-top">{t("Uptime")}</div><div className="ap-metric-value" style={{fontSize:18}}>{panelDuration(detail.data.uptime_seconds)}</div><div className="ap-metric-note">{t("since ")}{panelDate(detail.data.since,true)}</div></div>
          <div className="ap-metric"><div className="ap-metric-top">{t("Memory held")}</div><div className="ap-metric-value" style={{fontSize:18}}>{panelBytes(detail.data.memory_bytes)}</div><div className="ap-metric-note">{t("main pid {count}", { count: detail.data.main_pid??"—" })}</div></div>
          <div className="ap-metric"><div className="ap-metric-top">{t("Restarts")}</div><div className="ap-metric-value" style={{fontSize:18}}>{detail.data.restarts??"—"}</div><div className="ap-metric-note">{t("last result {count}", { count: detail.data.result||"—" })}</div></div>
        </div>}
      </div>
    </div>}

    <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Processes")}</strong><span>{processes.data?t("{matched} of {total}", { matched: processes.data.matched, total: processes.data.total }):""}</span></div>
      {!ops.can("process.list") ? <div className="ap-card-body"><ServerGate reason={ops.why("process.list")}/></div> : <>
        <div className="ap-toolbar">
          {/* A form rather than a keydown handler, so Enter submits the way it
              does in every other search box a person has ever used. */}
          <form style={{display:"contents"}} onSubmit={e=>{ e.preventDefault(); setProcApplied(procQuery.trim()); }}>
            <input className="ap-input" value={procQuery} onChange={e=>setProcQuery(e.target.value)} placeholder={t("Filter by command, user or pid")}/>
            <button className="ap-btn small" type="submit">{t("Search")}</button>
          </form>
          <label>{t("Sort")}</label>
          <select className="ap-input" value={procSort} onChange={e=>setProcSort(e.target.value)}><option value="cpu">{t("Processor")}</option><option value="memory">{t("Memory")}</option><option value="pid">{t("Process id")}</option></select>
          <span className="spacer"/>
          <button className="ap-btn small" onClick={()=>processes.reload()}><PanelIcon name="refresh" size={12}/></button>
        </div>
        <ServerLoad state={processes} empty={t("No processes were listed")}>{data => <div className="ap-table-wrap ap-scroll"><table className="ap-table">
          <thead><tr><th>{t("Process")}</th><th>{t("User")}</th><th>CPU</th><th>{t("Memory")}</th><th>{t("Ran for")}</th><th>{t("Actions")}</th></tr></thead>
          <tbody>{(data.processes||[]).map(row => <tr key={row.pid}>
            <td><strong className="ap-mono">{row.pid}</strong><div className="secondary ap-mono" style={{maxWidth:420,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row.command}</div></td>
            <td>{row.user}</td><td className="ap-mono">{row.cpu.toFixed(1)}%</td>
            <td className="ap-mono">{panelBytes(row.rss_bytes)}<div className="secondary">{row.memory.toFixed(1)}%</div></td>
            <td className="ap-mono">{row.elapsed}</td>
            <td>{ops.can("process.kill") && row.pid !== data.own_pid && <div className="ap-actions">
              <button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("process.kill",{pid:row.pid,signal:"TERM"})}>{t("Stop")}</button>
              <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("process.kill",{pid:row.pid,signal:"KILL"})}>{t("Force")}</button>
            </div>}{row.pid === data.own_pid && <PanelBadge tone="info">{t("this panel")}</PanelBadge>}</td>
          </tr>)}</tbody>
        </table></div>}</ServerLoad>
      </>}
    </div>
  </>;
}

function ServerLogs({ ops }) {
  const [selected, setSelected] = useState("");
  const [lines, setLines] = useState(200);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [unit, setUnit] = useState("");
  const [journal, setJournal] = useState(null);
  const sources = useServerRead(ops.api, "logs", "", ops.can("log.sources"));
  const active = selected || sources.data?.sources?.[0]?.id || "";
  const tail = useServerRead(ops.api, "log-tail", `id=${encodeURIComponent(active)}&lines=${lines}`, !!active && !applied && ops.can("log.tail"));
  const found = useServerRead(ops.api, "log-search", `id=${encodeURIComponent(active)}&query=${encodeURIComponent(applied)}`, !!active && !!applied && ops.can("log.search"));

  const readJournal = async () => {
    setJournal({ loading:true });
    try { setJournal({ data: await ops.api(`/api/panel/server/read/journal?unit=${encodeURIComponent(unit)}&lines=200`) }); }
    catch (error) { setJournal({ error: error.message }); }
  };

  if (!ops.can("log.sources")) return <><div className="ap-section-head"><div><h2>{t("Logs")}</h2></div></div><ServerGate reason={ops.why("log.sources")}/></>;

  return <>
    <div className="ap-section-head"><div><h2>{t("Logs")}</h2><p>{t("Only files this panel can actually read are listed, with their real path and size.")}</p></div></div>
    <div className="ap-card">
      <div className="ap-toolbar">
        <select className="ap-input" value={active} onChange={e=>{ setSelected(e.target.value); setApplied(""); }}>
          {(sources.data?.sources||[]).map(source => <option key={source.id} value={source.id}>{source.role} — {source.path}</option>)}
        </select>
        <label>{t("Lines")}</label>
        <select className="ap-input" value={lines} onChange={e=>setLines(Number(e.target.value))}>{[100,200,500,1000,2000].map(n=><option key={n} value={n}>{n}</option>)}</select>
        {ops.can("log.search") && <>
          {/* Searching the same term again re-reads the file rather than
              doing nothing, because a log is a moving target. */}
          <form style={{display:"contents"}} onSubmit={e=>{ e.preventDefault(); const next=query.trim(); if (next===applied) found.reload(); else setApplied(next); }}>
            <input className="ap-input" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t("Search this log")}/>
            <button className="ap-btn small" type="submit" disabled={!query.trim()}>{t("Search")}</button>
          </form>
          {applied && <button className="ap-btn small" onClick={()=>{ setApplied(""); setQuery(""); }}>{t("Back to tail")}</button>}
        </>}
        <span className="spacer"/>
        {ops.can("log.download") && <button className="ap-btn small" disabled={!active||!!ops.busy} onClick={()=>ops.download(`/api/panel/server/logs/${encodeURIComponent(active)}/download`, `${active}.log`)}><PanelIcon name="download" size={12}/>{t("Download")}</button>}
        <button className="ap-btn small" onClick={()=>(applied?found:tail).reload()}><PanelIcon name="refresh" size={12}/></button>
      </div>
      {applied
        ? <ServerLoad state={found} empty={t("Nothing searched yet")}>{data => <>
            <div style={{padding:"8px 12px",fontSize:11,color:"#68747f",borderBottom:"1px solid #eef1f4"}}>{data.capped
              ? t("The first {matchcount} lines matching “{query}”. The search stopped there, {count} lines into the file, so there are more.", { matchcount: data.match_count, query: data.query, count: data.lines_scanned.toLocaleString() })
              : (data.match_count===1 ? t("{matchcount} line match “{query}”, out of {countvalue} read.", { matchcount: data.match_count, query: data.query, countvalue: data.lines_scanned.toLocaleString() }) : t("{matchcount} lines match “{query}”, out of {countvalue} read.", { matchcount: data.match_count, query: data.query, countvalue: data.lines_scanned.toLocaleString() }))}</div>
            <div className="ap-logpane">{data.matches.length ? data.matches.map(match => <div key={match.line_number}><span className="num">{String(match.line_number).padStart(7," ")}  </span><span className="ap-loghit">{match.text}</span></div>) : t("No line in this file contains that text.")}</div>
          </>}</ServerLoad>
        : <ServerLoad state={tail} empty={t("Choose a log")}>{data => <>
            <div style={{padding:"8px 12px",fontSize:11,color:"#68747f",borderBottom:"1px solid #eef1f4"}}>{data.path} · {panelBytes(data.size_bytes)} · {data.line_count===1?t("showing the only line in it"):t("showing the last {linecount} lines", { linecount: data.line_count })}</div>
            <div className="ap-logpane">{data.lines.length ? data.lines.join("\n") : t("This log is empty.")}</div>
          </>}</ServerLoad>}
    </div>
    <div className="ap-card" style={{marginTop:12}}>
      <div className="ap-card-head"><strong>{t("Service journal")}</strong><span>{"systemd"}</span></div>
      {!ops.can("log.journal") ? <div className="ap-card-body"><ServerGate reason={ops.why("log.journal")}/></div> : <>
        <div className="ap-toolbar"><input className="ap-input" value={unit} onChange={e=>setUnit(e.target.value)} placeholder={t("Leave empty for everything, or name a service")}/><button className="ap-btn small" onClick={readJournal}>{t("Read journal")}</button></div>
        {journal?.loading && <div className="ap-card-body">{t("Reading…")}</div>}
        {journal?.error && <div className="ap-card-body"><PanelBadge tone="bad">{journal.error}</PanelBadge></div>}
        {journal?.data && <div className="ap-logpane">{journal.data.lines.join("\n")}</div>}
      </>}
    </div>
  </>;
}

function ServerDatabases({ ops }) {
  const [form, setForm] = useState({ name:"", username:"", password:"", grantDb:"", grantUser:"", privileges:"all", pwUser:"", pwValue:"", engine:"" });
  const [tables, setTables] = useState(null);
  const [upload, setUpload] = useState(null);
  const databases = useServerRead(ops.api, "databases", "", ops.can("database.list"));
  // Only the engines this machine can actually serve. The read lists both so
  // the screen can say why one is absent; offering an absent one in the picker
  // would be a button that cannot work.
  const engines = (databases.data?.engines || []).filter(e => e.available !== false).map(e => e.engine);
  const absentEngines = (databases.data?.engines || []).filter(e => e.available === false);
  const engineOf = name => (databases.data?.databases || []).find(d => d.name === name)?.engine || form.engine || engines[0];

  const browse = async row => {
    setTables({ name: row.name, loading: true });
    try { setTables({ name: row.name, data: await ops.api(`/api/panel/server/read/database-tables?name=${encodeURIComponent(row.name)}&engine=${encodeURIComponent(row.engine||"")}`) }); }
    catch (error) { setTables({ name: row.name, error: error.message }); }
  };

  const uploadDump = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    const body = new FormData(); body.append("dump", file);
    try { const result = await ops.api("/api/panel/server/databases/upload", { method:"POST", body }); setUpload(result.upload); ops.notify(t("{filename} is held. Choose the database to import it into.", { filename: result.upload.filename })); }
    catch (error) { ops.notify(error.message, true); }
    event.target.value = "";
  };

  if (!ops.can("database.list")) return <><div className="ap-section-head"><div><h2>{t("Databases")}</h2></div></div><ServerGate reason={ops.why("database.list")} area="databases" setup={ops.setup("databases")} ops={ops}/></>;

  return <>
    <div className="ap-section-head"><div><h2>{t("Databases")}</h2><p>{t("This panel manages the databases it created, named ")}<code className="ap-mono">{databases.data?.prefix||"…"}</code>{t(". Anything else on the machine is out of its reach and is not listed.")}</p></div></div>

    {absentEngines.map(entry => <div className="ap-callout" style={{marginBottom:10}} key={entry.engine}>
      <PanelIcon name="alert" size={16}/>
      <div style={{flex:1}}><strong>{t("{count} is not serving on this machine", { count: entry.engine === "postgres" ? "PostgreSQL" : "MariaDB" })}</strong><p>{entry.reason}</p></div>
      {ops.can("stack.install") && <button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose(entry.engine === "postgres" ? "stack.install.postgres" : "stack.install.database",{})}>{t("Install {count}", { count: entry.engine === "postgres" ? "PostgreSQL" : "MariaDB" })}</button>}
    </div>)}

    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("Databases")}</strong><span>{databases.data?.databases?.length||0}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>databases.reload()}><PanelIcon name="refresh" size={12}/></button></div>
      <ServerLoad state={databases} empty={t("No databases")}>{data => data.databases.length ? <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Database")}</th><th>{t("Engine")}</th><th>{t("Size")}</th><th>{t("Actions")}</th></tr></thead>
        <tbody>{data.databases.map(row => <tr key={`${row.engine}-${row.name}`}>
          <td><strong className="ap-mono">{row.name}</strong>{row.user&&<div className="secondary">{t("user {user}", { user: row.user })}</div>}</td>
          <td>{row.engine}</td><td className="ap-mono">{panelBytes(row.size_bytes)}</td>
          <td><div className="ap-actions">
            {ops.can("database.tables") && <button className="ap-btn small" onClick={()=>browse(row)}>{t("Tables")}</button>}
            {ops.can("database.dump") && <button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.download("/api/panel/server/databases/dump", `${row.name}.sql`, { method:"POST", body:JSON.stringify({ name:row.name, engine:row.engine }) })}>{t("Dump")}</button>}
            {ops.can("database.import") && upload && <button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("database.import",{ name:row.name, engine:row.engine, uploadId:upload.uploadId })}>{t("Import held file")}</button>}
            {ops.can("database.drop") && <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("database.drop",{ name:row.name, engine:row.engine })}>{t("Delete")}</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div> : <div className="ap-empty"><PanelIcon name="storage" size={25}/><strong>{t("No databases yet")}</strong><span>{t("Create the first one below. It is proposed, approved and then created.")}</span></div>}</ServerLoad>
    </div>

    {tables && <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{tables.name}</strong><span>{t("tables")}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>setTables(null)}>{t("Close")}</button></div>
      {tables.loading && <div className="ap-card-body">{t("Reading…")}</div>}
      {tables.error && <div className="ap-card-body"><PanelBadge tone="bad">{tables.error}</PanelBadge></div>}
      {tables.data && (tables.data.tables.length ? <div className="ap-table-wrap ap-scroll"><table className="ap-table"><thead><tr><th>{t("Table")}</th><th>{t("Rows")}</th><th>{t("Size")}</th></tr></thead><tbody>
        {tables.data.tables.map(tabId => <tr key={tabId.table}><td className="ap-mono">{tabId.table}</td><td className="ap-mono">{Number(tabId.rows).toLocaleString()}</td><td className="ap-mono">{panelBytes(tabId.size_bytes)}</td></tr>)}
      </tbody></table></div> : <div className="ap-empty"><strong>{t("This database has no tables yet")}</strong></div>)}
    </div>}

    <div className="ap-grid-even">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Create a database")}</strong><span>{databases.data?.prefix}…</span></div><div className="ap-card-body">
        {!ops.can("database.create") ? <ServerGate reason={ops.why("database.create")}/> : <>
          <div className="ap-field"><label>{t("Name")}</label><input className="ap-input" value={form.name} onChange={e=>setForm(v=>({...v,name:e.target.value}))} placeholder={"shop"}/><small>{t("The prefix is added for you.")}</small></div>
          {engines.length>1 && <div className="ap-field"><label>{t("Engine")}</label><select className="ap-input" value={form.engine} onChange={e=>setForm(v=>({...v,engine:e.target.value}))}>{engines.map(e=><option key={e} value={e}>{e}</option>)}</select></div>}
          <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy||!form.name.trim()} onClick={()=>ops.propose("database.create",{name:form.name.trim(),engine:form.engine||engines[0]})}>{t("Propose database")}</button></div>
        </>}
      </div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Create a database user")}</strong><span>{t("login only")}</span></div><div className="ap-card-body">
        {!ops.can("database.user.create") ? <ServerGate reason={ops.why("database.user.create")}/> : <>
          <div className="ap-field"><label>{t("Username")}</label><input className="ap-input" value={form.username} onChange={e=>setForm(v=>({...v,username:e.target.value}))} placeholder={"shop_app"}/></div>
          <div className="ap-field"><label>{t("Password")}</label><input className="ap-input" type="password" value={form.password} onChange={e=>setForm(v=>({...v,password:e.target.value}))} placeholder={t("10 characters or more")}/><small>{t("Letters, digits and ! # % * + - = ? @ ^ _ ~ .")}</small></div>
          <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy||!form.username.trim()||!form.password} onClick={()=>ops.propose("database.user.create",{username:form.username.trim(),password:form.password,engine:form.engine||engines[0]})}>{t("Propose user")}</button></div>
        </>}
      </div></div>
    </div>

    <div className="ap-grid-even">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Grant a user to a database")}</strong></div><div className="ap-card-body">
        {!ops.can("database.grant") ? <ServerGate reason={ops.why("database.grant")}/> : <>
          <div className="ap-form">
            <div className="ap-field"><label>{t("Database")}</label><select className="ap-input" value={form.grantDb} onChange={e=>setForm(v=>({...v,grantDb:e.target.value}))}><option value="">{t("Choose")}</option>{(databases.data?.databases||[]).map(d=><option key={d.name} value={d.name}>{d.name}</option>)}</select></div>
            <div className="ap-field"><label>{t("User")}</label><select className="ap-input" value={form.grantUser} onChange={e=>setForm(v=>({...v,grantUser:e.target.value}))}><option value="">{t("Choose")}</option>{(databases.data?.users||[]).map(u=><option key={u.name} value={u.name}>{u.name}</option>)}</select></div>
            <div className="ap-field"><label>{t("Access")}</label><select className="ap-input" value={form.privileges} onChange={e=>setForm(v=>({...v,privileges:e.target.value}))}><option value="all">{t("Full")}</option><option value="read">{t("Read only")}</option></select></div>
          </div>
          <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy||!form.grantDb||!form.grantUser} onClick={()=>ops.propose("database.grant",{name:form.grantDb,username:form.grantUser,privileges:form.privileges,engine:engineOf(form.grantDb)})}>{t("Propose grant")}</button></div>
        </>}
      </div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Change a user password")}</strong></div><div className="ap-card-body">
        {!ops.can("database.password") ? <ServerGate reason={ops.why("database.password")}/> : <>
          <div className="ap-field"><label>{t("User")}</label><select className="ap-input" value={form.pwUser} onChange={e=>setForm(v=>({...v,pwUser:e.target.value}))}><option value="">{t("Choose")}</option>{(databases.data?.users||[]).map(u=><option key={u.name} value={u.name}>{u.name}</option>)}</select></div>
          <div className="ap-field"><label>{t("New password")}</label><input className="ap-input" type="password" value={form.pwValue} onChange={e=>setForm(v=>({...v,pwValue:e.target.value}))}/></div>
          <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy||!form.pwUser||!form.pwValue} onClick={()=>ops.propose("database.password",{username:form.pwUser,password:form.pwValue,engine:engineOf(form.pwUser)})}>{t("Propose password change")}</button></div>
        </>}
      </div></div>
    </div>

    <div className="ap-card"><div className="ap-card-head"><strong>{t("Import a dump")}</strong><span>{".sql"}</span></div><div className="ap-card-body">
      {!ops.can("database.import") ? <ServerGate reason={ops.why("database.import")}/> : <>
        <p style={{fontSize:11.5,color:"#5d6a79",lineHeight:1.55,margin:"0 0 12px"}}>{t("The file is uploaded and held. Nothing runs until you choose a database above, approve the import and execute it.")}</p>
        <label className="ap-btn primary" style={{cursor:"pointer"}}><PanelIcon name="upload" size={13}/>{t("Choose an .sql file")}<input type="file" accept=".sql" hidden onChange={uploadDump}/></label>
        {upload && <div className="ap-callout warn" style={{margin:"12px 0 0"}}><PanelIcon name="alert" size={17}/><div><strong>{t("{filename} is held, {count}", { filename: upload.filename, count: panelBytes(upload.bytes) })}</strong><p>{t("{count}{countvalue}Choose “Import held file” beside the database you want it to run against.", { count: upload.drops_tables?t("This file contains DROP statements and can remove existing tables. "):"", countvalue: upload.creates_tables?t("It creates tables. "):"" })}</p></div></div>}
      </>}
    </div></div>
  </>;
}

// The operator's account-level answer. The archive browser below answers what
// files exist; this answers whether every account has a usable recovery point,
// which is why failures stay above healthy rows and why the state is a sentence
// rather than a green tick.
function ServerBackupHealth({ ops }) {
  const health = useServerRead(ops.api, "backup-health", "", ops.can("backup.health.list"));
  const tone = status => ({ failed:"bad", overdue:"warn", never_backed_up:"warn", running:"info", healthy:"ok" }[status] || "info");
  const state = status => ({ failed:"failed", overdue:"overdue", never_backed_up:"never", running:"running", healthy:"healthy" }[status] || status);

  if (!ops.can("backup.health.list")) return <><div className="ap-section-head"><div><h2>{t("Backup health")}</h2></div></div><ServerGate reason={ops.why("backup.health.list")} ops={ops}/></>;

  return <>
    <div className="ap-section-head"><div><h2>{t("Backup health")}</h2><p>{t("One row per account, from the run evidence and the schedule the machine read back. A failed attempt leaves the last verified recovery point visible.")}</p></div>
      <div className="ap-actions"><button className="ap-btn" onClick={()=>health.reload()}><PanelIcon name="refresh" size={13}/>{t("Refresh")}</button></div>
    </div>
    <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Accounts on this server")}</strong><span>{health.data?.health?.length||0}</span></div>
      <ServerLoad state={health} empty={t("No accounts")}>{data => data.health?.length ? <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Account")}</th><th>{t("Status")}</th><th>{t("Last attempt")}</th><th>{t("Last verified")}</th><th>{t("Recovery point")}</th><th>{t("Next due")}</th><th>{t("Latest error")}</th></tr></thead>
        <tbody>{data.health.map(row => <tr key={row.account_id}>
          <td><strong>{row.account}</strong><div className="secondary">{row.primary_domain||t("No primary domain")}</div><div className="secondary">{t("Policy {count}", { count: row.policy_state||t("none") })}</div></td>
          <td><PanelBadge tone={tone(row.status)}>{state(row.status)}</PanelBadge><div className="ap-list-note" style={{marginTop:5}}>{row.status_label}</div></td>
          <td>{row.last_attempt_at ? <><span className="ap-mono" style={{fontSize:10.5}}>{panelDate(row.last_attempt_at,true)}</span><div className="secondary">{row.last_attempt_status}</div></> : <span className="secondary">{t("No attempt")}</span>}</td>
          <td>{row.last_verified_at ? <span className="ap-mono" style={{fontSize:10.5}}>{panelDate(row.last_verified_at,true)}</span> : <span className="secondary">{t("None")}</span>}</td>
          <td>{row.last_verified_at ? <><strong>{panelBytes(row.bytes_total)}</strong><div className="secondary">{row.components?.length ? row.components.join(", ") : t("No components recorded")}</div></> : <span className="secondary">{t("No verified artifact")}</span>}</td>
          <td>{row.status==="overdue" && row.overdue_at ? <><PanelBadge tone="warn">{t("deadline passed")}</PanelBadge><div className="secondary ap-mono" style={{marginTop:5,fontSize:10.5}}>{panelDate(row.overdue_at,true)}</div></> : row.next_due_at ? <span className="ap-mono" style={{fontSize:10.5}}>{panelDate(row.next_due_at,true)}</span> : <span className="secondary">{t("Not scheduled")}</span>}</td>
          <td>{row.failure_summary ? <><PanelBadge tone="bad">{row.failure_code||t("failed")}</PanelBadge><div className="ap-list-note" style={{marginTop:5}}>{row.failure_summary}</div><div className="secondary">{(row.consecutive_failures===1 ? t("{consecutivefailures} consecutive failure", { consecutivefailures: row.consecutive_failures }) : t("{consecutivefailures} consecutive failures", { consecutivefailures: row.consecutive_failures }))}</div></> : <span className="secondary">{t("None")}</span>}</td>
        </tr>)}</tbody>
      </table></div> : <div className="ap-empty"><PanelIcon name="archive" size={25}/><strong>{t("No accounts are recorded yet")}</strong><span>{t("The first account appears here as soon as its organization exists.")}</span></div>}</ServerLoad>
    </div>
  </>;
}

// Every list, every action here reads or calls a capability that already
// exists in serverOps (backup.list, backup.create, backup.restore,
// backup.schedule.set/clear, backup.fetch) plus the standing
// /api/panel/server/backups/send route that reuses deploy credentials. None
// of it is new backend surface, only the screen that was missing for it.
function ServerBackups({ ops }) {
  const [domainFilter, setDomainFilter] = useState("");
  const [form, setForm] = useState({ domain:"", parts:["files","mail"], databases:"", keep:"7" });
  const [schedule, setSchedule] = useState({ domain:"", when:"daily", parts:["files","mail"], databases:"", keep:"7" });
  const [restoring, setRestoring] = useState(null); // { domain, id, part, mode, path }
  const [sending, setSending] = useState(null); // { domain, id, part, credentialId, remoteDir }
  const [creds, setCreds] = useState([]);

  const sites = useServerRead(ops.api, "server-sites", "", ops.can("site.list"));
  const backups = useServerRead(ops.api, "backups", domainFilter ? `domain=${encodeURIComponent(domainFilter)}` : "", ops.can("backup.list"));
  const schedules = useServerRead(ops.api, "backup-schedules", "", ops.can("backup.schedule.status"));
  const domainOptions = (sites.data?.sites || []).map(s => s.domain);

  useEffect(() => {
    if (!ops.can("backup.create")) return;
    let live = true;
    ops.api("/api/platform/config")
      .then(config => config?.deployPushEnabled === true ? ops.api("/api/deploy/credentials") : null)
      .then(list => { if (live && Array.isArray(list)) setCreds(list); })
      .catch(() => {});
    return () => { live = false; };
  }, [ops.can("backup.create")]);

  const togglePart = (bag, setBag, key, part) => setBag(v => ({ ...v, [key]: v[key].includes(part) ? v[key].filter(p=>p!==part) : [...v[key], part] }));

  const proposeCreate = () => ops.propose("backup.create", {
    domain: form.domain, parts: form.parts,
    databases: form.parts.includes("databases") ? form.databases.split(",").map(s=>s.trim()).filter(Boolean) : [],
    keep: Number(form.keep) || 7,
  });
  const proposeSchedule = () => ops.propose("backup.schedule.set", {
    domain: schedule.domain, when: schedule.when, parts: schedule.parts,
    databases: schedule.parts.includes("databases") ? schedule.databases.split(",").map(s=>s.trim()).filter(Boolean) : [],
    keep: Number(schedule.keep) || 7,
  });
  const proposeRestore = () => ops.propose("backup.restore", {
    domain: restoring.domain, id: restoring.id, part: restoring.part,
    // A database restore has no copy-alongside and no single file: it is the
    // contents of one database going back into that database.
    ...(restoring.part === "databases" ? {} : { mode: restoring.mode, path: restoring.path ? restoring.path.trim() : null }),
  }).then(() => setRestoring(null));
  const sendOffsite = async () => {
    if (!sending.credentialId) { ops.notify(t("Choose where to send it"), true); return; }
    try {
      const result = await ops.api("/api/panel/server/backups/send", { method:"POST", body: JSON.stringify({
        domain: sending.domain, id: sending.id, part: sending.part, credentialId: sending.credentialId, remoteDir: sending.remoteDir || undefined,
      })});
      ops.notify(t("Sent to {host}{path} ({count}, checksum verified).", { host: result.host, path: result.path, count: panelBytes(result.bytes) }));
      setSending(null);
    } catch (error) { ops.notify(error.message, true); }
  };

  if (!ops.can("backup.list")) return <><div className="ap-section-head"><div><h2>{t("Backups")}</h2></div></div><ServerGate reason={ops.why("backup.list")} setup={ops.setup("backups")} ops={ops}/></>;

  return <>
    <div className="ap-section-head"><div><h2>{t("Backups")}</h2><p>{t("Archives of the files, the mail and the databases, and a restore that can put back one file rather than an account.")}</p></div>
      {domainOptions.length > 1 && <div className="ap-actions"><select className="ap-input" value={domainFilter} onChange={e=>setDomainFilter(e.target.value)}><option value="">{t("All sites")}</option>{domainOptions.map(d=><option key={d} value={d}>{d}</option>)}</select></div>}
    </div>

    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("Scheduled backups")}</strong><span>{schedules.data?.schedules?.length||0}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>schedules.reload()}><PanelIcon name="refresh" size={12}/></button></div>
      <ServerLoad state={schedules} empty={t("No schedules")}>{data => data.schedules.length ? <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Domain")}</th><th>{t("When")}</th><th>{t("Keeps")}</th><th>{t("State")}</th><th>{t("Next run")}</th><th>{t("Last run")}</th><th>{t("Actions")}</th></tr></thead>
        <tbody>{data.schedules.map(row => <tr key={row.domain}>
          <td><strong>{row.domain}</strong></td>
          <td>{row.when}</td>
          <td>{row.keep||7}</td>
          <td>{row.suspended_by_hoster ? <PanelBadge tone="warn">{t("suspended")}</PanelBadge> : row.armed ? <PanelBadge tone="ok">{t("armed")}</PanelBadge> : <PanelBadge tone="bad">{t("not armed")}</PanelBadge>}</td>
          <td className="ap-mono" style={{fontSize:10.5}}>{row.next_run ? panelDate(row.next_run, true) : "—"}</td>
          <td>{row.last_run ? (row.last_run.failed ? <PanelBadge tone="bad">{t("failed: {failed}", { failed: row.last_run.failed })}</PanelBadge> : <PanelBadge tone="ok">{t("{archived} part(s), {count}", { archived: row.last_run.archived, count: panelDate(row.last_run.at, true) })}</PanelBadge>) : <span className="secondary">{t("never run")}</span>}</td>
          <td>{ops.can("backup.schedule.clear") && <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("backup.schedule.clear",{domain:row.domain})}>{t("Stop")}</button>}</td>
        </tr>)}</tbody>
      </table></div> : <div className="ap-empty"><PanelIcon name="archive" size={25}/><strong>{t("No domain backs itself up yet")}</strong><span>{t("Set one below. It survives a reboot and catches up if the machine was off when it was due.")}</span></div>}</ServerLoad>
    </div>

    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("Backups taken")}</strong><span>{backups.data?.backups?.length||0}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>backups.reload()}><PanelIcon name="refresh" size={12}/></button></div>
      <ServerLoad state={backups} empty={t("No backups")}>{data => data.backups.length ? <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Domain")}</th><th>{t("Taken")}</th><th>{t("Size")}</th><th>{t("Contains")}</th><th>{t("Actions")}</th></tr></thead>
        <tbody>{data.backups.map(row => <tr key={`${row.domain}-${row.id}`}>
          <td><strong>{row.domain}</strong><div className="secondary ap-mono" style={{fontSize:10}}>{row.id}</div></td>
          <td className="ap-mono" style={{fontSize:10.5}}>{panelDate(row.created_at, true)}</td>
          <td className="ap-mono">{panelBytes(row.bytes)}</td>
          <td>{row.empty ? <PanelBadge tone="bad">{t("empty")}</PanelBadge> : row.parts.join(", ")}{row.skipped?.length ? <div className="secondary">{row.skipped.map(s=>t("{part} skipped: {reason}", { part: s.part, reason: s.reason })).join("; ")}</div> : null}
            {row.parts.some(p=>p.startsWith("databases:")) && <div className="secondary">{t("A database goes back by downloading its dump and importing it, not through Restore.")}</div>}</td>
          <td><div className="ap-actions">
            {/* The part name is passed whole. A database part is named
                `databases:<name>` and stripping the qualifier asks for a
                "databases" archive that no manifest has, which is a 400. */}
            {ops.can("backup.fetch") && row.parts.map(part => <button key={part} className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.download(`/api/panel/server/backups/download?domain=${encodeURIComponent(row.domain)}&id=${encodeURIComponent(row.id)}&part=${encodeURIComponent(part)}`, part.startsWith("databases:") ? `${part.split(":")[1]}-${row.id}.sql.gz` : `${row.domain}-${row.id}-${part}.tar.gz`)}>{t("Download {count}", { count: part.startsWith("databases:") ? part.split(":")[1] : part })}</button>)}
            {ops.can("backup.restore") &&
              <button className="ap-btn small" onClick={()=>setRestoring({ domain:row.domain, id:row.id, part:row.parts.find(p=>p==="files"||p==="mail")||"databases", mode:"copy", path:"", parts:row.parts })}>{t("Restore")}</button>}
            {creds.length>0 && <button className="ap-btn small" onClick={()=>setSending({ domain:row.domain, id:row.id, part:row.parts[0]||"files", credentialId:creds[0].id, remoteDir:"" })}>{t("Send offsite")}</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div> : <div className="ap-empty"><PanelIcon name="archive" size={25}/><strong>{t("No backups yet")}</strong><span>{t("Take the first one below.")}</span></div>}</ServerLoad>
    </div>

    {restoring && <div className="ap-card" style={{marginBottom:12,borderColor:"#c8922a"}}>
      <div className="ap-card-head"><strong>{t("Restore {domain}", { domain: restoring.domain })}</strong><span>{t("from {id}", { id: restoring.id })}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>setRestoring(null)}>{t("Close")}</button></div>
      <div className="ap-card-body">
        <div className="ap-callout warn"><PanelIcon name="alert" size={17}/><div><strong>{t("This is proposed, then needs approval and a typed confirmation")}</strong><p>{t("Nothing is written until you approve and execute it in Activity.")}</p></div></div>
        <div className="ap-form" style={{marginTop:12}}>
          {/* Only the parts this backup actually holds. A database is restored
              by the same operation now, so it is one of the choices. */}
          <div className="ap-field"><label>{t("Part")}</label><select className="ap-input" value={restoring.part} onChange={e=>setRestoring(v=>({...v,part:e.target.value}))}>
            {(restoring.parts||["files"]).some(p=>p==="files") && <option value="files">{t("files")}</option>}
            {(restoring.parts||[]).some(p=>p==="mail") && <option value="mail">{t("mail")}</option>}
            {(restoring.parts||[]).some(p=>p.startsWith("databases:")) && <option value="databases">{t("databases")}</option>}
          </select></div>
          {restoring.part === "databases"
            ? <div className="ap-callout" style={{margin:"0 0 12px"}}><PanelIcon name="storage" size={16}/><div><p>{t("The database is created first if it is no longer on this server, then the contents are written over whatever is in it now.")}</p></div></div>
            : <>
              <div className="ap-field"><label>{t("Mode")}</label><select className="ap-input" value={restoring.mode} onChange={e=>setRestoring(v=>({...v,mode:e.target.value}))}><option value="copy">{t("copy alongside (safe, compare after)")}</option><option value="in-place">{t("in-place (overwrites what is there now)")}</option></select></div>
              <div className="ap-field"><label>{t("Single file (optional)")}</label><input className="ap-input" value={restoring.path} onChange={e=>setRestoring(v=>({...v,path:e.target.value}))} placeholder={t("Leave empty to restore everything in this part")}/></div>
            </>}
        </div>
        <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy} onClick={proposeRestore}>{t("Propose restore")}</button></div>
      </div>
    </div>}

    {sending && <div className="ap-card" style={{marginBottom:12,borderColor:"#c8922a"}}>
      <div className="ap-card-head"><strong>{t("Send {domain} offsite", { domain: sending.domain })}</strong><span>{sending.id}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>setSending(null)}>{t("Close")}</button></div>
      <div className="ap-card-body">
        <div className="ap-form">
          <div className="ap-field"><label>{t("Destination")}</label><select className="ap-input" value={sending.credentialId} onChange={e=>setSending(v=>({...v,credentialId:e.target.value}))}>{creds.map(c=><option key={c.id} value={c.id}>{c.host} ({c.protocol})</option>)}</select></div>
          <div className="ap-field"><label>{t("Remote folder")}</label><input className="ap-input" value={sending.remoteDir} onChange={e=>setSending(v=>({...v,remoteDir:e.target.value}))} placeholder="/backups"/></div>
        </div>
        <p style={{fontSize:11.5,color:"#5d6a79",margin:"10px 0 0"}}>{t("Uploaded now, over the credential's own protocol, and the size read back from the far end is checked against the archive before this is called done.")}</p>
        <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy} onClick={sendOffsite}>{t("Send now")}</button></div>
      </div>
    </div>}

    <div className="ap-grid-even">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Take a backup now")}</strong></div><div className="ap-card-body">
        {!ops.can("backup.create") ? <ServerGate reason={ops.why("backup.create")}/> : <>
          <div className="ap-field"><label>{t("Domain")}</label><select className="ap-input" value={form.domain} onChange={e=>setForm(v=>({...v,domain:e.target.value}))}><option value="">{t("Choose…")}</option>{domainOptions.map(d=><option key={d} value={d}>{d}</option>)}</select></div>
          <div className="ap-field"><label>{t("Contents")}</label><div className="ap-actions">{["files","databases","mail"].map(part => <label key={part} className="ap-check"><input type="checkbox" checked={form.parts.includes(part)} onChange={()=>togglePart(form,setForm,"parts",part)}/><span>{part}</span></label>)}</div></div>
          {form.parts.includes("databases") && <div className="ap-field"><label>{t("Database names")}</label><input className="ap-input" value={form.databases} onChange={e=>setForm(v=>({...v,databases:e.target.value}))} placeholder={"shop_prod, shop_staging"}/></div>}
          <div className="ap-field"><label>{t("Keep")}</label><input className="ap-input" type="number" min="1" value={form.keep} onChange={e=>setForm(v=>({...v,keep:e.target.value}))}/><small>{t("Older ones beyond this are deleted.")}</small></div>
          <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy||!form.domain||!form.parts.length} onClick={proposeCreate}>{t("Propose backup")}</button></div>
        </>}
      </div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Back up on a schedule")}</strong></div><div className="ap-card-body">
        {!ops.can("backup.schedule.set") ? <ServerGate reason={ops.why("backup.schedule.set")}/> : <>
          <div className="ap-field"><label>{t("Domain")}</label><select className="ap-input" value={schedule.domain} onChange={e=>setSchedule(v=>({...v,domain:e.target.value}))}><option value="">{t("Choose…")}</option>{domainOptions.map(d=><option key={d} value={d}>{d}</option>)}</select></div>
          <div className="ap-field"><label>{t("How often")}</label><select className="ap-input" value={schedule.when} onChange={e=>setSchedule(v=>({...v,when:e.target.value}))}><option value="hourly">{t("hourly")}</option><option value="daily">{t("daily")}</option><option value="weekly">{t("weekly")}</option><option value="monthly">{t("monthly")}</option></select></div>
          <div className="ap-field"><label>{t("Contents")}</label><div className="ap-actions">{["files","databases","mail"].map(part => <label key={part} className="ap-check"><input type="checkbox" checked={schedule.parts.includes(part)} onChange={()=>togglePart(schedule,setSchedule,"parts",part)}/><span>{part}</span></label>)}</div></div>
          {schedule.parts.includes("databases") && <div className="ap-field"><label>{t("Database names")}</label><input className="ap-input" value={schedule.databases} onChange={e=>setSchedule(v=>({...v,databases:e.target.value}))} placeholder={"shop_prod, shop_staging"}/></div>}
          <div className="ap-field"><label>{t("Keep")}</label><input className="ap-input" type="number" min="1" value={schedule.keep} onChange={e=>setSchedule(v=>({...v,keep:e.target.value}))}/></div>
          <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy||!schedule.domain||!schedule.parts.length} onClick={proposeSchedule}>{t("Propose schedule")}</button></div>
        </>}
      </div></div>
    </div>
  </>;
}

function ServerMailAdmin({ ops }) {
  const [domain, setDomain] = useState("");
  const [box, setBox] = useState({ account:"", password:"", generatePassword:false, quotaMb:"1024", forwardTo:"", autoreply:"", catchall:"" });
  const domains = useServerRead(ops.api, "mail-domains", "", ops.can("mail.domains"));
  // A domain appears in the mail list only once it has a mailbox, so on a new
  // server the list was empty and the first mailbox could never be made. The
  // server's own websites are offered beside it.
  const siteList = useServerRead(ops.api, "server-sites", "", ops.can("site.list"));
  const domainChoices = [...new Set([...(domains.data?.domains||[]).map(d => d.domain), ...(siteList.data?.sites||[]).map(s => s.domain)])];
  const active = domain || domainChoices[0] || "";
  const mailboxes = useServerRead(ops.api, "mailboxes", `domain=${encodeURIComponent(active)}`, !!active && ops.can("mail.mailbox.list"));
  const webmail = useServerRead(ops.api, "webmail", "", ops.can("webmail.status"));
  const queue = useServerRead(ops.api, "mail-queue", "", ops.isOperator && ops.can("mail.queue.list"));
  const current = (domains.data?.domains||[]).find(d => d.domain === active);
  const webmailEntry = address => {
    const url = (webmail.data?.mailboxes||[]).find(entry => entry.address === address)?.url;
    return /^https?:\/\//i.test(String(url||"")) ? url : null;
  };

  return <>
    <div className="ap-section-head"><div><h2>{t("Mail administration")}</h2><p>{t("Mailboxes on this server. The Mail app is the client and still asks for a server, a port and a protocol only when somebody adds an account inside it.")}</p></div></div>

    {!ops.can("mail.mailbox.list") ? <ServerGate reason={ops.why("mail.mailbox.list")} area="mailadmin" setup={ops.setup("mailadmin")} ops={ops}/> : <>
      <div className="ap-card" style={{marginBottom:12}}>
        <div className="ap-toolbar">
          <label>{t("Domain")}</label>
          <select className="ap-input" value={active} onChange={e=>setDomain(e.target.value)}>{domainChoices.map(d=><option key={d} value={d}>{d}</option>)}</select>
          {current && <span style={{fontSize:10.5,color:"#68747f"}}>{t("{accounts} mailboxes · spam filter {count} · signing key {countvalue}", { accounts: current.accounts, count: current.antispam?t("on"):t("off"), countvalue: current.dkim?t("present"):t("none") })}</span>}
          <span className="spacer"/>
          <button className="ap-btn small" onClick={()=>mailboxes.reload()}><PanelIcon name="refresh" size={12}/></button>
        </div>
        <ServerLoad state={mailboxes} empty={t("Choose a domain")}>{data => data.mailboxes.length ? <div className="ap-table-wrap ap-scroll"><table className="ap-table">
          <thead><tr><th>{t("Mailbox")}</th><th>{t("Size")}</th><th>{t("Forwarding")}</th><th>{t("Actions")}</th></tr></thead>
          <tbody>{data.mailboxes.map(mailbox => <tr key={mailbox.address}>
            <td><strong>{mailbox.address}</strong>{mailbox.autoreply&&<div className="secondary">{t("automatic reply is on")}</div>}</td>
            <td className="ap-mono">{panelBytes(mailbox.used_bytes)}<div className="secondary">{t("of {count}", { count: mailbox.quota_mb?`${mailbox.quota_mb} MB`:t("unlimited") })}</div></td>
            <td>{mailbox.forwarders.length ? mailbox.forwarders.map(f => <div key={f} className="ap-mono" style={{fontSize:10.5}}>{f}{ops.can("mail.forwarder.delete")&&<button className="ap-btn small" style={{marginLeft:6}} onClick={()=>ops.propose("mail.forwarder.delete",{domain:active,account:mailbox.account,forward:f})}>×</button>}</div>) : <span className="secondary">{t("none")}</span>}</td>
            <td><div className="ap-actions">
              {webmailEntry(mailbox.address) && <a className="ap-btn small" href={webmailEntry(mailbox.address)} target="_blank" rel="noreferrer">{t("Open webmail")}</a>}
              {ops.can("mail.autoreply.clear") && mailbox.autoreply && <button className="ap-btn small" onClick={()=>ops.propose("mail.autoreply.clear",{domain:active,account:mailbox.account})}>{t("Stop reply")}</button>}
              {ops.can("mail.mailbox.delete") && <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("mail.mailbox.delete",{domain:active,account:mailbox.account})}>{t("Delete")}</button>}
            </div></td>
          </tr>)}</tbody>
        </table></div> : <div className="ap-empty"><PanelIcon name="mail" size={25}/><strong>{t("No mailboxes on {active}", { active: active })}</strong><span>{t("Create the first one below.")}</span></div>}</ServerLoad>
      </div>

      {!ops.can("webmail.status") && <div className="ap-card" style={{marginBottom:12}}>
        <div className="ap-card-head"><strong>{t("Webmail")}</strong><span>Roundcube</span></div>
        <div className="ap-card-body"><ServerGate reason={ops.why("webmail.status")} title={t("Browser mail is not available on this server")}/>
          {ops.can("stack.install") && <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy} onClick={()=>ops.propose("stack.install.webmail",{})}>{t("Install Roundcube here")}</button></div>}
        </div>
      </div>}

      <div className="ap-grid-even">
        <div className="ap-card"><div className="ap-card-head"><strong>{t("Create a mailbox")}</strong><span>{t("on {count}", { count: active||t("this domain") })}</span></div><div className="ap-card-body">
          {!ops.can("mail.mailbox.create") ? <ServerGate reason={ops.why("mail.mailbox.create")} area="mail.mailbox.create"/> : <>
            <div className="ap-field"><label>{t("Address")}</label><input className="ap-input" value={box.account} onChange={e=>setBox(v=>({...v,account:e.target.value}))} placeholder={"sales"}/><small>{active?`@${active}`:""}</small></div>
            <div className="ap-field"><label>{t("Size, MB")}</label><input className="ap-input" value={box.quotaMb} onChange={e=>setBox(v=>({...v,quotaMb:e.target.value}))} placeholder="1024"/></div>
            <div className="ap-field"><label>{t("Password")}</label><input className="ap-input" type="password" disabled={box.generatePassword} value={box.password} onChange={e=>setBox(v=>({...v,password:e.target.value}))}/></div>
            <div className="ap-actions" style={{marginTop:8}}><button className={`ap-btn${box.generatePassword?" primary":""}`} type="button" onClick={()=>setBox(v=>({...v,generatePassword:!v.generatePassword,password:""}))}>{box.generatePassword?t("The server will generate it"):t("Generate a password")}</button></div>
            <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy||!active||!box.account.trim()||(!box.generatePassword&&!box.password)} onClick={()=>ops.propose("mail.mailbox.create",{domain:active,account:box.account.trim(),...(box.generatePassword?{}:{password:box.password}),quotaMb:Number(box.quotaMb)||null},box.generatePassword?{generate:["password"]}:undefined)}>{t("Propose mailbox")}</button></div>
          </>}
        </div></div>
        <div className="ap-card"><div className="ap-card-head"><strong>{t("Forwarders and replies")}</strong></div><div className="ap-card-body">
          {!ops.can("mail.forwarder.set") && !ops.can("mail.autoreply.set") ? <ServerGate reason={ops.why("mail.forwarder.set")}/> : <>
            <div className="ap-field"><label>{t("Mailbox")}</label><select className="ap-input" value={box.account} onChange={e=>setBox(v=>({...v,account:e.target.value}))}><option value="">{t("Choose")}</option>{(mailboxes.data?.mailboxes||[]).map(m=><option key={m.account} value={m.account}>{m.address}</option>)}</select></div>
            {ops.can("mail.forwarder.set") && <><div className="ap-field"><label>{t("Forward a copy to")}</label><input className="ap-input" value={box.forwardTo} onChange={e=>setBox(v=>({...v,forwardTo:e.target.value}))} placeholder="someone@example.com"/></div>
            <div className="ap-actions" style={{margin:"0 0 12px"}}><button className="ap-btn" disabled={!!ops.busy||!box.account||!box.forwardTo} onClick={()=>ops.propose("mail.forwarder.set",{domain:active,account:box.account,forward:box.forwardTo})}>{t("Propose forwarder")}</button></div></>}
            {ops.can("mail.autoreply.set") && <><div className="ap-field"><label>{t("Automatic reply")}</label><input className="ap-input" value={box.autoreply} onChange={e=>setBox(v=>({...v,autoreply:e.target.value}))} placeholder={t("Away until Monday")}/></div>
            <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn" disabled={!!ops.busy||!box.account||!box.autoreply.trim()} onClick={()=>ops.propose("mail.autoreply.set",{domain:active,account:box.account,message:box.autoreply})}>{t("Propose automatic reply")}</button></div></>}
          </>}
        </div></div>
      </div>

      <div className="ap-grid-even">
        <div className="ap-card"><div className="ap-card-head"><strong>{t("Catch-all")}</strong><span>{current?.catchall||t("not set")}</span></div><div className="ap-card-body">
          {!ops.can("mail.catchall.set") ? <ServerGate reason={ops.why("mail.catchall.set")}/> : <>
            <div className="ap-field"><label>{t("Send unknown addresses to")}</label><input className="ap-input" value={box.catchall} onChange={e=>setBox(v=>({...v,catchall:e.target.value}))} placeholder="office@example.com"/><small>{t("A catch-all collects spam as well as typing mistakes.")}</small></div>
            <div className="ap-actions" style={{marginTop:12}}>
              <button className="ap-btn primary" disabled={!!ops.busy||!active||!box.catchall} onClick={()=>ops.propose("mail.catchall.set",{domain:active,forward:box.catchall})}>{t("Propose catch-all")}</button>
              {current?.catchall && <button className="ap-btn" disabled={!!ops.busy} onClick={()=>ops.propose("mail.catchall.set",{domain:active,forward:""})}>{t("Propose removal")}</button>}
            </div>
          </>}
        </div></div>
        <div className="ap-card"><div className="ap-card-head"><strong>{t("Spam filtering and signing")}</strong></div><div className="ap-card-body">
          {!ops.can("mail.antispam.set") && !ops.can("mail.dkim.enable") ? <ServerGate reason={ops.why("mail.antispam.set")}/> : <div className="ap-actions">
            {ops.can("mail.antispam.set") && <button className="ap-btn" disabled={!!ops.busy||!active} onClick={()=>ops.propose("mail.antispam.set",{domain:active,enabled:!current?.antispam})}>{current?.antispam?t("Propose switching spam filtering off"):t("Propose switching spam filtering on")}</button>}
            {ops.can("mail.dkim.enable") && !current?.dkim && <button className="ap-btn" disabled={!!ops.busy||!active} onClick={()=>ops.propose("mail.dkim.enable",{domain:active})}>{t("Propose a signing key")}</button>}
            {current?.dkim && <PanelBadge tone="ok">{t("signing key present")}</PanelBadge>}
          </div>}
        </div></div>
      </div>
    </>}

    {ops.isOperator && <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Mail queue")}</strong><span>{queue.data?t("{count} waiting", { count: queue.data.count }):""}</span>
        {ops.can("mail.queue.action") && queue.data?.count>0 && <div className="ap-actions" style={{marginLeft:8}}>
          <button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("mail.queue.retry",{id:"ALL"})}>{t("Try all again")}</button>
          <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("mail.queue.delete",{id:"ALL"})}>{t("Delete all")}</button>
        </div>}
      </div>
      {!ops.can("mail.queue.list") ? <div className="ap-card-body"><ServerGate reason={ops.why("mail.queue.list")}/></div>
        : <ServerLoad state={queue} empty={t("No queue")}>{data => data.messages.length ? <div className="ap-table-wrap ap-scroll"><table className="ap-table">
            <thead><tr><th>{t("Message")}</th><th>{t("From")}</th><th>{t("Waiting since")}</th><th>{t("Held because")}</th><th>{t("Actions")}</th></tr></thead>
            <tbody>{data.messages.map(message => <tr key={message.id}>
              <td><strong className="ap-mono">{message.id}</strong><div className="secondary">{message.recipients.join(", ")||"—"}</div></td>
              <td className="ap-mono">{message.sender}</td><td>{message.arrived}</td>
              <td style={{maxWidth:280}}><span className="secondary">{message.reason||t("waiting its turn")}</span></td>
              <td>{ops.can("mail.queue.action") && <div className="ap-actions">
                <button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("mail.queue.retry",{id:message.id})}>{t("Retry")}</button>
                <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("mail.queue.delete",{id:message.id})}>{t("Delete")}</button>
              </div>}</td>
            </tr>)}</tbody>
          </table></div> : <div className="ap-empty"><PanelIcon name="check" size={25}/><strong>{t("The mail queue is empty")}</strong><span>{t("Nothing is stuck waiting to be delivered.")}</span></div>}</ServerLoad>}
    </div>}
  </>;
}

function ServerSites({ ops }) {
  const [form, setForm] = useState({ domain:"", alias:"", newDomain:"", documentRoot:"public", redirect:"", certEmail:"", staging:true, forceHttps:false });
  const sites = useServerRead(ops.api, "server-sites", "", ops.can("site.list"));
  const certificates = useServerRead(ops.api, "certificates", "", ops.can("certificate.list"));
  const runtimes = useServerRead(ops.api, "runtimes", "", ops.can("runtime.list"));
  const [app, setApp] = useState({ domain:"", runtime:"node", entry:"" });
  const active = form.domain || sites.data?.sites?.[0]?.domain || "";
  const activeSite = (sites.data?.sites || []).find(site=>site.domain===active) || null;
  const chosen = (runtimes.data?.runtimes || []).find(entry => entry.runtime === app.runtime);

  if (!ops.can("site.list")) return <><div className="ap-section-head"><div><h2>{t("Websites on this server")}</h2></div></div><ServerGate reason={ops.why("site.list")} setup={ops.setup("serversites")} ops={ops}/></>;

  return <>
    <div className="ap-section-head"><div><h2>{t("Websites")}</h2></div><div className="ap-actions"><button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("site.reload",{})}>{t("Test & reload nginx")}</button></div></div>
    <div className="ap-grid-even">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Add a domain or subdomain")}</strong></div><div className="ap-card-body">
        {!ops.can("site.create") ? <ServerGate reason={ops.why("site.create")}/> : <>
          <div className="ap-form"><div className="ap-field"><label>{t("Domain")}</label><input className="ap-input" value={form.newDomain} onChange={e=>setForm(v=>({...v,newDomain:e.target.value}))} placeholder="shop.example.com"/></div><div className="ap-field"><label>{t("Document root")}</label><input className="ap-input" value={form.documentRoot} onChange={e=>setForm(v=>({...v,documentRoot:e.target.value}))} placeholder={t("public")}/></div></div>
          <div className="ap-actions" style={{marginTop:9}}><button className="ap-btn primary" disabled={!!ops.busy||!form.newDomain.trim()} onClick={()=>ops.propose("site.create",{domain:form.newDomain.trim(),documentRoot:form.documentRoot})}>{t("Add site")}</button></div>
          {ops.can("site.alias.set") && <><div className="ap-field" style={{marginTop:14}}><label>{t("Park a domain on {count}", { count: active||t("a site") })}</label><input className="ap-input" value={form.alias} onChange={e=>setForm(v=>({...v,alias:e.target.value}))} placeholder="example.net"/></div>
          <div className="ap-actions" style={{marginTop:9}}><button className="ap-btn" disabled={!!ops.busy||!active||!form.alias.trim()} onClick={()=>ops.propose("site.alias.add",{domain:active,alias:form.alias.trim()})}>{t("Add alias")}</button></div></>}
        </>}
      </div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Selected site")}</strong><span>{active||t("none")}</span></div><div className="ap-card-body">
        <div className="ap-field"><label>{t("Document root")}</label><input className="ap-input" value={form.documentRoot} onChange={e=>setForm(v=>({...v,documentRoot:e.target.value}))}/></div>
        <div className="ap-actions" style={{margin:"8px 0 12px"}}><button className="ap-btn" disabled={!!ops.busy||!active} onClick={()=>ops.propose("site.document-root",{domain:active,documentRoot:form.documentRoot})}>{t("Save root")}</button></div>
        <div className="ap-field"><label>{t("Redirect URL, blank to remove")}</label><input className="ap-input" value={form.redirect} onChange={e=>setForm(v=>({...v,redirect:e.target.value}))} placeholder="https://www.example.com/"/></div>
        <div className="ap-actions" style={{marginTop:8}}><button className="ap-btn" disabled={!!ops.busy||!active} onClick={()=>ops.propose("site.redirect",{domain:active,target:form.redirect})}>{t("Save redirect")}</button></div>
      </div></div>
    </div>
    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("Sites")}</strong><span>{sites.data?.sites?.length||0}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>sites.reload()}><PanelIcon name="refresh" size={12}/></button></div>
      <ServerLoad state={sites} empty={t("No sites")}>{data => <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Domain")}</th><th>{t("State")}</th><th>{t("Runs as")}</th><th>{t("Served by")}</th><th>{t("Redirect")}</th><th>{t("Document root")}</th><th>{t("Actions")}</th></tr></thead>
        <tbody>{data.sites.map(site => <tr key={site.domain}>
          <td><strong>{site.domain}</strong><div className="secondary">{site.aliases?.length?(site.aliases.length===1 ? t("{count} alias", { count: site.aliases.length }) : t("{count} aliases", { count: site.aliases.length })):t("no aliases")}</div></td>
          <td><PanelBadge tone={site.ssl?"ok":"neutral"}>{site.ssl?"HTTPS":"HTTP"}</PanelBadge></td>
          <td className="ap-mono" style={{fontSize:10.5}}>{site.user||<span className="secondary">{t("shared")}</span>}</td>
          <td>{site.runtime?<PanelBadge tone="info">{site.runtime.label||site.runtime.id}</PanelBadge>:site.php?<PanelBadge tone="ok">PHP {site.php}</PanelBadge>:<span className="secondary">{t("its own files")}</span>}</td>
          <td className="ap-mono">{site.redirect||"—"}</td>
          <td className="ap-mono" style={{fontSize:10.5,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis"}}>{site.document_root}</td>
          <td><div className="ap-actions">
            <button className="ap-btn small" onClick={()=>setForm(v=>({...v,domain:site.domain,documentRoot:site.document_root.split("/").slice(-1)[0]||"public",redirect:site.redirect||""}))}>{t("Edit")}</button>
            {ops.can("certificate.renew")&&site.ssl&&<button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("certificate.renew",{domain:site.domain,dryRun:false})}>{t("Renew")}</button>}
            {ops.can("site.delete") && <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("site.delete",{domain:site.domain})}>{t("Remove")}</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}</ServerLoad>
    </div>
    {/* Runtimes beyond PHP. One mechanism for every language: a program owned
        by the site's own user, behind the reverse proxy that is already there.
        The list of languages comes from the machine, which asks each interpreter
        to run rather than looking for it on disk, so nothing is offered here
        that would fail on the first site that tried it. */}
    {ops.can("runtime.list") && <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("Run a site with something other than PHP")}</strong><span>{t("{count} available", { count: (runtimes.data?.available||[]).length })}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>runtimes.reload()}><PanelIcon name="refresh" size={12}/></button></div>
      <ServerLoad state={runtimes} empty={t("No runtimes answered")}>{data => <>
        <div className="ap-table-wrap"><table className="ap-table">
          <thead><tr><th>{t("Language")}</th><th>{t("State")}</th><th>{t("Starts from")}</th><th>{t("Detail")}</th><th>{t("Actions")}</th></tr></thead>
          <tbody>{data.runtimes.map(entry => <tr key={entry.runtime}>
            <td><strong>{entry.label}</strong></td>
            <td><PanelBadge tone={entry.available?"ok":"neutral"}>{entry.available?t("ready"):t("not installed")}</PanelBadge></td>
            <td className="ap-mono" style={{fontSize:10.5}}>{entry.example}</td>
            <td className="secondary" style={{maxWidth:340,whiteSpace:"normal"}}>{entry.available?entry.detail:entry.reason}</td>
            <td>{!entry.available&&entry.installable&&ops.can("runtime.install")
              ? <button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("runtime.install",{runtime:entry.runtime})}>{t("Install {label}", { label: entry.label })}</button>
              : <span className="secondary">—</span>}</td>
          </tr>)}</tbody>
        </table></div>
        {(data.running||[]).length>0 && <div className="ap-card-body" style={{paddingBottom:0}}>
          <div className="ap-list-title">{t("Sites being served by a program")}</div>
          <div className="ap-table-wrap"><table className="ap-table">
            <thead><tr><th>{t("Site")}</th><th>{t("Language")}</th><th>{t("Starts from")}</th><th>{t("Port")}</th><th>{t("Actions")}</th></tr></thead>
            <tbody>{data.running.map(row => <tr key={row.domain}>
              <td><strong>{row.domain}</strong></td>
              <td>{row.runtime}</td>
              <td className="ap-mono" style={{fontSize:10.5}}>{row.entry}</td>
              <td className="ap-mono">{row.port}</td>
              <td><div className="ap-actions">
                {ops.can("runtime.restart")&&<button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("runtime.restart",{domain:row.domain})}>{t("Restart")}</button>}
                {ops.can("runtime.clear")&&<button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("runtime.clear",{domain:row.domain})}>{t("Stop")}</button>}
              </div></td>
            </tr>)}</tbody>
          </table></div>
        </div>}
        <div className="ap-card-body">
          {!ops.can("runtime.set") ? <ServerGate reason={ops.why("runtime.set")}/> : <>
            <div className="ap-form">
              <div className="ap-field"><label>{t("Site")}</label>
                <select className="ap-input" value={app.domain} onChange={e=>setApp(v=>({...v,domain:e.target.value}))}>
                  <option value="">{t("Choose a site")}</option>
                  {(sites.data?.sites||[]).map(site => <option key={site.domain} value={site.domain}>{site.domain}</option>)}
                </select>
              </div>
              <div className="ap-field"><label>{t("Language")}</label>
                <select className="ap-input" value={app.runtime} onChange={e=>setApp(v=>({...v,runtime:e.target.value}))}>
                  {data.runtimes.map(entry => <option key={entry.runtime} value={entry.runtime} disabled={!entry.available}>{entry.label}{entry.available?"":t(" — not installed")}</option>)}
                </select>
              </div>
              <div className="ap-field"><label>{t("Starting file")}</label><input className="ap-input ap-mono" value={app.entry} onChange={e=>setApp(v=>({...v,entry:e.target.value}))} placeholder={chosen?.example||"server.js"}/></div>
            </div>
            {chosen?.note && <p style={{fontSize:11.5,color:"#5d6a79",lineHeight:1.55,margin:"11px 0 0"}}>{t("{note} The panel gives the program its own port on this machine and points the web server at it; nothing outside can reach the port directly.", { note: chosen.note })}</p>}
            <div className="ap-actions" style={{marginTop:12}}>
              <button className="ap-btn primary" disabled={!!ops.busy||!app.domain||!app.entry.trim()||!chosen?.available} onClick={()=>ops.propose("runtime.set",{domain:app.domain,runtime:app.runtime,entry:app.entry.trim()})}>{t("Propose running this site with {count}", { count: chosen?.label||app.runtime })}</button>
            </div>
            <div className="ap-callout warn" style={{margin:"12px 0 0"}}><PanelIcon name="alert" size={16}/><div><p>{t("The site stops being served from its files the moment this runs. Everything under the domain goes to the program, so it has to answer for the pages the files used to serve.")}</p></div></div>
          </>}
        </div>
      </>}</ServerLoad>
    </div>}

    <div className="ap-grid-even">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Issue certificate")}</strong><span>{active||t("select a site")}</span></div><div className="ap-card-body">
        {!ops.can("certificate.issue")?<ServerGate reason={ops.why("certificate.issue")} setup={ops.setup("serversites")?.certificates} ops={ops}/>:<><div className="ap-field"><label>{t("ACME email, optional")}</label><input className="ap-input" value={form.certEmail} onChange={e=>setForm(v=>({...v,certEmail:e.target.value}))} placeholder="admin@example.com"/></div><label className="ap-check" style={{marginTop:8}}><input type="checkbox" checked={form.staging} onChange={e=>setForm(v=>({...v,staging:e.target.checked}))}/>{t("Use the staging issuer")}</label><label className="ap-check" style={{marginTop:6}}><input type="checkbox" checked={form.forceHttps} onChange={e=>setForm(v=>({...v,forceHttps:e.target.checked}))}/>{t("Redirect HTTP to HTTPS")}</label><div className="ap-actions" style={{marginTop:9}}><button className="ap-btn primary" disabled={!!ops.busy||!active} onClick={()=>ops.propose("certificate.issue",{domain:active,email:form.certEmail,staging:form.staging,forceHttps:form.forceHttps})}>{t("Issue")}</button><button className="ap-btn" disabled={!!ops.busy||!active} onClick={()=>ops.propose("certificate.renew",{domain:active,dryRun:true})}>{t("Test renewal")}</button></div></>}
      </div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Certificates")}</strong><span>{certificates.data?.sites?.filter(row=>row.certificate).length||0}</span></div><ServerLoad state={certificates} empty={t("No certificates")}>{data=><div className="ap-table-wrap"><table className="ap-table"><thead><tr><th>{t("Domain")}</th><th>{t("State")}</th><th>{t("Expires")}</th><th>HTTPS</th><th>{t("Actions")}</th></tr></thead><tbody>{data.sites.map(row=><tr key={row.domain}>
        <td><strong>{row.domain}</strong></td>
        <td><PanelBadge tone={row.certificate?"ok":"neutral"}>{row.certificate?t("issued"):t("none")}</PanelBadge></td>
        <td>{row.certificate?panelDate(row.certificate.expires_at):"—"}</td>
        <td><PanelBadge tone={row.force_https?"ok":"neutral"}>{row.force_https?t("forced"):t("optional")}</PanelBadge></td>
        <td><div className="ap-actions">
          {ops.can("certificate.renew")&&row.certificate&&<button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("certificate.renew",{domain:row.domain,dryRun:false})}>{t("Renew")}</button>}
          {ops.can("certificate.https")&&row.certificate&&<button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("certificate.https",{domain:row.domain,enabled:!row.force_https})}>{row.force_https?t("Allow HTTP"):t("Force HTTPS")}</button>}
        </div></td>
      </tr>)}</tbody></table></div>}</ServerLoad></div>
    </div>
    <div className="ap-grid-even">
      <SiteApplications ops={ops} domain={active} installed={activeSite?.application}/>
      <SiteSftp ops={ops} domain={active}/>
    </div>
  </>;
}

// One click, one application, on one site. The list says why an application
// cannot be offered rather than showing a tile that fails when pressed.
function SiteApplications({ ops, domain, installed }) {
  const apps = useServerRead(ops.api, "applications", "", ops.can("application.list"));
  if (!ops.can("application.list")) {
    return <div className="ap-card"><div className="ap-card-head"><strong>{t("Applications")}</strong></div>
      <div className="ap-card-body"><ServerGate reason={ops.why("application.list")} setup={ops.setup("serversites")?.php} ops={ops}/></div></div>;
  }
  return <div className="ap-card">
    <div className="ap-card-head"><strong>{t("Applications")}</strong><span>{domain||t("select a site")}</span></div>
    {installed&&<div className="ap-callout good" style={{margin:10}}><PanelIcon name="check" size={17}/><div><strong>{t("{count} is installed", { count: installed.label||installed.id })}</strong><p>{t("Installed ")}{panelDate(installed.installed_at,true)}{t(". A site holds one catalogue application, so choose another site to install a different one.")}</p></div></div>}
    <ServerLoad state={apps} empty={t("Nothing installable")}>{data => <div className="ap-table-wrap"><table className="ap-table">
      <thead><tr><th>{t("Application")}</th><th>{t("Uses")}</th><th>{t("State")}</th><th>{t("Actions")}</th></tr></thead>
      <tbody>{(data.applications||[]).map(app => { const ui=APPLICATION_UI[app.id]||{icon:"panel",description:t("Application supplied by this server."),parameters:[t("site domain")]}; return <tr key={app.id}>
        <td><div style={{display:"flex",alignItems:"flex-start",gap:8}}><span className="ap-list-icon" style={{width:25,height:25,flexBasis:25}}><PanelIcon name={ui.icon} size={13}/></span><div><strong>{app.label}</strong><div className="secondary">{ui.description}</div></div></div></td>
        <td><div className="secondary">{ui.parameters.join(" · ")}</div>{app.needs_database&&<div className="secondary">{t("Database required")}</div>}</td>
        <td>{app.available?<PanelBadge tone="ok">{t("ready")}</PanelBadge>:<PanelBadge tone="warn">{t("unavailable")}</PanelBadge>}
          {!app.available&&app.reason&&<div className="secondary">{app.reason}</div>}</td>
        <td>{!app.available?<span className="secondary">{t("Not offered on this machine")}</span>:!domain?<span className="secondary">{t("Choose a site above")}</span>:installed?<span className="secondary">{t("Choose a site without an application")}</span>:<button className="ap-btn small primary" disabled={!!ops.busy}
          onClick={()=>ops.propose("application.install",{application:app.id,domain})}>{t("Install on {domain}", { domain: domain })}</button>}</td>
      </tr>;})}</tbody>
    </table></div>}</ServerLoad>
  </div>;
}

// SFTP is per site and it is the site's own user, so the panel says which
// account and where it lands, which is the question every host answers by email.
function SiteSftp({ ops, domain }) {
  const [password, setPassword] = useState("");
  const state = useServerRead(ops.api, "sftp", domain?`domain=${encodeURIComponent(domain)}`:"", ops.can("sftp.status")&&!!domain);
  if (!ops.can("sftp.status")) {
    return <div className="ap-card"><div className="ap-card-head"><strong>SFTP</strong></div>
      <div className="ap-card-body"><ServerGate reason={ops.why("sftp.status")}/></div></div>;
  }
  const on = state.data?.enabled === true;
  return <div className="ap-card">
    <div className="ap-card-head"><strong>SFTP</strong><span>{domain||t("select a site")}</span></div>
    <div className="ap-card-body">
      {!domain ? <div className="secondary">{t("Choose a site above.")}</div> : <>
        <div className="ap-list-row" style={{padding:"6px 0"}}>
          <div style={{flex:1,minWidth:0}}>
            <div className="ap-list-title ap-mono" style={{fontSize:11}}>{state.data?.user||"—"}</div>
            <div className="ap-list-note">{t("port {count} · lands in {countvalue} · no shell", { count: state.data?.port||22, countvalue: state.data?.path_after_login||"/" })}</div>
          </div>
          <PanelBadge tone={on?"ok":"neutral"}>{on?t("on"):t("off")}</PanelBadge>
        </div>
        <div className="ap-field"><label>{on?t("Change the password"):t("Password, 12 characters or more")}</label>
          <input className="ap-input" type="password" value={password} autoComplete="new-password"
            onChange={e=>setPassword(e.target.value)} placeholder={t("letters, digits and . _ ~ ! @ # % ^ * + = -")}/></div>
        <div className="ap-actions" style={{marginTop:9}}>
          <button className="ap-btn primary" disabled={!!ops.busy||password.length<12}
            onClick={()=>{ ops.propose("sftp.enable",{domain,password}); setPassword(""); }}>{on?t("Set new password"):t("Turn on SFTP")}</button>
          {on&&<button className="ap-btn danger" disabled={!!ops.busy}
            onClick={()=>ops.propose("sftp.disable",{domain})}>{t("Turn off")}</button>}
        </div>
      </>}
    </div>
  </div>;
}

// The screen owns its own site list, because the panel's `sites` is JotPanel's list
// of websites and this one wants the sites this machine is actually serving,
// which is a different question with a different answer.
function SiteFileManagerScreen({ ops }) {
  const sites = useServerRead(ops.api, "server-sites", "", ops.can("site.list"));
  if (!ops.can("site.files.list")) {
    return <><div className="ap-section-head"><div><h2>{t("Site files")}</h2></div></div>
      <ServerGate reason={ops.why("site.files.list")} setup={ops.setup("serversites")} ops={ops}/></>;
  }
  return <SiteFileManager ops={ops} sites={sites.data?.sites || []}/>;
}

// ── The site file manager ─────────────────────────────────────────
// Designed against docs/UI_BRIEF_FOR_DESIGNERS.md and reviewed rather than
// pasted: no invented classes, no imports, no direct changes, uploads staged
// first and only proposed afterwards, and a missing capability drawn as a gate
// that says why rather than as a button that fails.
function SiteFileManager({ ops, sites = [], initialDomain = "" }) {
  const siteDomains = sites
    .map(site => typeof site === "string" ? site : site?.domain || site?.hostname || site?.name || "")
    .filter(Boolean);
  const [domain, setDomain] = useState(initialDomain || siteDomains[0] || "");
  const [dir, setDir] = useState("");
  const [chosen, setChosen] = useState([]);
  const [tool, setTool] = useState("");
  const [form, setForm] = useState({ folder:"", rename:"", archive:".tar.gz", extract:"" });
  const [editor, setEditor] = useState(null);
  const [queue, setQueue] = useState([]);
  const [dragging, setDragging] = useState(false);

  const files = useServerRead(
    ops.api,
    "site-files",
    `domain=${encodeURIComponent(domain)}&dir=${encodeURIComponent(dir)}`,
    !!domain && ops.can("site.files.list")
  );

  useEffect(() => {
    if (!domain && siteDomains.length) setDomain(siteDomains[0]);
  }, [domain, siteDomains.join("\n")]);

  const joinPath = (...parts) => parts
    .filter(part => part != null && String(part).trim() !== "")
    .map(part => String(part).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  const parentPath = path => {
    const parts = String(path || "").split("/").filter(Boolean);
    return parts.slice(0, -1).join("/");
  };
  const formatBytes = value => {
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let amount = bytes / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
  };
  const formatDate = value => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], { year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit" });
  };
  const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const updateQueue = (id, patch) => setQueue(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
  const selectedPaths = chosen.map(name => joinPath(dir, name));
  const selectedEntries = (files.data?.entries || []).filter(entry => chosen.includes(entry.name));
  const selectedArchives = selectedEntries.filter(entry => !entry.directory && /\.(zip|tar\.gz|tgz)$/i.test(entry.name));
  const pathParts = dir.split("/").filter(Boolean);
  // The document root is `public` at the top of the site directory, which is
  // what the nginx configuration this panel writes actually points at. Being
  // inside it is what makes a file readable by the internet, so it is worked
  // out from where you are rather than assumed from the screen you are on.
  const publicPath = pathParts[0] === "public";

  const resetLocationState = () => {
    setChosen([]);
    setTool("");
    setEditor(null);
  };
  const goTo = nextDir => {
    setDir(nextDir);
    resetLocationState();
  };
  const chooseSite = nextDomain => {
    setDomain(nextDomain);
    setDir("");
    resetLocationState();
  };
  const toggle = name => setChosen(current => current.includes(name)
    ? current.filter(item => item !== name)
    : [...current, name]);

  const openTool = nextTool => {
    if (nextTool === "folder") setForm(current => ({ ...current, folder:"" }));
    if (nextTool === "rename") setForm(current => ({ ...current, rename:chosen[0] || "" }));
    if (nextTool === "archive") {
      setForm(current => ({
        ...current,
        archive:chosen.length === 1 ? `${joinPath(dir, chosen[0])}.tar.gz` : ".tar.gz"
      }));
    }
    if (nextTool === "extract") setForm(current => ({ ...current, extract:dir }));
    setTool(nextTool);
  };

  const proposeMany = async (operation, inputs) => {
    for (const input of inputs) await ops.propose(operation, input);
    setTool("");
  };

  const submitTool = async event => {
    event.preventDefault();
    if (!domain || ops.busy) return;
    if (tool === "folder" && form.folder.trim()) {
      await ops.propose("site.files.folder", { domain, path:joinPath(dir, form.folder.trim()) });
      setTool("");
    }
    if (tool === "rename" && selectedPaths.length === 1 && form.rename.trim()) {
      await ops.propose("site.files.rename", {
        domain,
        path:selectedPaths[0],
        target:joinPath(dir, form.rename.trim())
      });
      setTool("");
    }
    if (tool === "archive" && selectedPaths.length) {
      const inputs = selectedPaths.map(path => ({
        domain,
        path,
        target:selectedPaths.length === 1 ? form.archive.trim() : `${path}${form.archive.trim() || ".tar.gz"}`
      }));
      await proposeMany("site.files.archive", inputs);
    }
    if (tool === "extract" && selectedArchives.length) {
      await proposeMany("site.files.extract", selectedArchives.map(entry => ({
        domain,
        path:joinPath(dir, entry.name),
        target:form.extract.trim()
      })));
    }
    if (tool === "delete" && selectedPaths.length) {
      await proposeMany("site.files.delete", selectedPaths.map(path => ({ domain, path })));
    }
  };

  const openEditor = async entry => {
    const path = joinPath(dir, entry.name);
    setEditor({ path, name:entry.name, content:"", size:entry.size_bytes, loading:true, error:"" });
    try {
      const data = await ops.api(`/api/panel/server/read/site-file?domain=${encodeURIComponent(domain)}&path=${encodeURIComponent(path)}`);
      setEditor({
        path:data.path || path,
        name:entry.name,
        content:data.content == null ? "" : String(data.content),
        size:data.size_bytes == null ? entry.size_bytes : data.size_bytes,
        loading:false,
        error:""
      });
    } catch (error) {
      setEditor({ path, name:entry.name, content:"", size:entry.size_bytes, loading:false, error:error.message });
    }
  };

  const saveEditor = async () => {
    if (!editor || editor.loading || editor.error) return;
    await ops.propose("site.files.write", { domain, path:editor.path, content:editor.content });
  };

  const stageUpload = async item => {
    updateQueue(item.id, { status:item.staged ? "waiting" : "uploading", detail:item.staged ? t("Retrying the approval request…") : t("Staging on the panel…") });
    try {
      let staged = item.staged;
      let target = item.target;
      if (!staged) {
        const body = new FormData();
        body.append("file", item.file);
        const result = await ops.api("/api/panel/server/site-files/upload", { method:"POST", body });
        staged = result.staged;
        target = joinPath(item.destinationDir, result.name || item.name);
        updateQueue(item.id, {
          status:"waiting",
          name:result.name || item.name,
          size:result.bytes == null ? item.size : result.bytes,
          target,
          staged,
          detail:t("Staged; recording the approval request…")
        });
      }
      updateQueue(item.id, {
        status:"waiting",
        target,
        staged,
        detail:t("Staged; recording the approval request…")
      });
      await ops.propose("site.files.upload", {
        domain:item.destinationDomain,
        path:target,
        staged
      });
      updateQueue(item.id, { status:"waiting", detail:t("Waiting for approval and execution") });
    } catch (error) {
      updateQueue(item.id, { status:"failed", detail:error.message || t("Upload failed") });
    }
  };

  const acceptFiles = fileList => {
    if (!domain || !ops.can("site.files.place")) return;
    const additions = Array.from(fileList || []).map(file => ({
      id:newId(),
      name:file.name,
      size:file.size,
      file,
      destinationDomain:domain,
      destinationDir:dir,
      target:joinPath(dir, file.name),
      status:"queued",
      detail:t("Queued for staging")
    }));
    if (!additions.length) return;
    setQueue(current => [...current, ...additions]);
    additions.forEach(stageUpload);
  };

  const downloadEntry = async entry => {
    const id = newId();
    const path = joinPath(dir, entry.name);
    setQueue(current => [...current, {
      id,
      name:entry.name,
      size:entry.size_bytes,
      target:path,
      status:"downloading",
      detail:t("Preparing a verified download…")
    }]);
    try {
      const server = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
      const response = await fetch(
        `${server}/api/panel/server/site-files/download?domain=${encodeURIComponent(domain)}&path=${encodeURIComponent(path)}`,
        { headers:{ Authorization:`Bearer ${readPanelStorage("jwt") || ""}` } }
      );
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || t("Download failed ({status})", { status: response.status }));
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = entry.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      setQueue(current => current.filter(row => row.id !== id));
    } catch (error) {
      updateQueue(id, { status:"failed", detail:error.message || t("Download failed") });
    }
  };

  const queueTone = status => status === "failed" ? "bad" : status === "waiting" ? "warn" : "info";
  const queueLabel = status => ({
    queued:"queued",
    uploading:"uploading",
    downloading:"downloading",
    waiting:t("waiting approval"),
    failed:"failed"
  }[status] || status);

  const missingCapabilities = [
    ["site.files.read", t("Text editing is not available")],
    ["site.files.stage", t("Downloads are not available")],
    ["site.files.folder", t("New folders are not available")],
    ["site.files.rename", t("Renaming is not available")],
    ["site.files.archive", t("Archiving is not available")],
    ["site.files.extract", t("Extraction is not available")],
    ["site.files.delete", t("Deletion is not available")]
  ].filter(([capability]) => !ops.can(capability));

  if (!ops.can("site.files.list")) return <>
    <div className="ap-section-head"><div><h2>{t("File manager")}</h2></div></div>
    <ServerGate reason={ops.why("site.files.list")} setup={ops.setup("serversites")} ops={ops}/>
  </>;

  return <>
    <div className="ap-section-head">
      <div><h2>{t("File manager")}</h2></div>
      <PanelBadge tone={domain ? "ok" : "warn"}>{domain || t("no site selected")}</PanelBadge>
    </div>

    <div className="ap-card">
      <div className="ap-toolbar">
        <div className="ap-field">
          <label>{t("Site")}</label>
          {siteDomains.length ? <select className="ap-input" value={domain} onChange={event => chooseSite(event.target.value)}>
            {siteDomains.map(name => <option key={name} value={name}>{name}</option>)}
          </select> : <input className="ap-input ap-mono" value={domain} onChange={event => chooseSite(event.target.value)} placeholder="example.com"/>}
        </div>
        <div className="ap-actions">
          <button className="ap-btn small" disabled={!dir} onClick={() => goTo(parentPath(dir))}>{t("Up one level")}</button>
          <button className="ap-btn small" disabled={!domain || !!ops.busy} onClick={() => files.reload()}>
            <PanelIcon name="refresh" size={12}/>{t(" Refresh")}</button>
        </div>
      </div>
      <div className="ap-toolbar">
        <strong>{t("Path")}</strong>
        <button className="ap-btn small ap-mono" onClick={() => goTo("")}>/</button>
        {pathParts.map((part, index) => <button
          key={`${part}-${index}`}
          className="ap-btn small ap-mono"
          onClick={() => goTo(pathParts.slice(0, index + 1).join("/"))}
        >{part}/</button>)}
        <span className="ap-mono">{files.data?.root || ""}</span>
      </div>
      {/* Which half of the site you are standing in, said plainly and worked
          out from the path rather than written once at the top. `public` is the
          document root nginx serves, so a file put here can be fetched by
          anybody who guesses its name; everything beside it in the site
          directory is the site's own private area and is not served at all.
          Nothing else on this screen distinguishes them, and a file list looks
          identical either way. */}
      {publicPath
        ? <div className="ap-callout warn" role="status">
            <PanelIcon name="globe" size={16}/>
            <div>
              <strong>{t("Anything here can be read from the internet")}</strong>
              <p>{t("This is ")}{domain}{t("'s document root. A file put here is served at ")}<span className="ap-mono">{domain}/{dir.split("/").slice(1).filter(Boolean).join("/")}</span>{t(" to anybody who asks for it, signed in or not.")}</p>
            </div>
          </div>
        : <div className="ap-callout" role="status">
            <PanelIcon name="shield" size={16}/>
            <div>
              <strong>{t("Not served to the internet")}</strong>
              <p>{t("This part of ")}{domain || t("the site")}{t(" is outside the document root. Put configuration, backups and anything private here. Only ")}<span className="ap-mono">public/</span>{t(" is web-served.")}</p>
            </div>
          </div>}
    </div>

    <div className="ap-grid-2">
      <div className="ap-main">
        <div className="ap-card">
          <div className="ap-card-head"><strong>{t("Transfer")}</strong><span>{t("{count} queued", { count: queue.length })}</span></div>
          {!ops.can("site.files.place") ? <div className="ap-card-body">
            <ServerGate reason={ops.why("site.files.place")} title={t("Uploads are not available")}/>
          </div> : <div
            className={dragging ? "ap-notice" : "ap-card-body"}
            onDragEnter={event => { event.preventDefault(); setDragging(true); }}
            onDragOver={event => { event.preventDefault(); setDragging(true); }}
            onDragLeave={event => { event.preventDefault(); setDragging(false); }}
            onDrop={event => { event.preventDefault(); setDragging(false); acceptFiles(event.dataTransfer.files); }}
          >
            <div className="ap-empty">
              <PanelIcon name="upload" size={25}/>
              <strong>{dragging ? t("Drop to upload") : t("Drag files here")}</strong>
              <span className="ap-mono">{domain ? `${domain}:/${dir}` : t("Select a site first")}</span>
            </div>
            <div className="ap-field">
              <label>{t("Or choose files")}</label>
              <input className="ap-input" type="file" multiple disabled={!domain || !!ops.busy} onChange={event => { acceptFiles(event.target.files); event.target.value = ""; }}/>
            </div>
          </div>}

          {!!queue.length && <div className="ap-card-body">
            {queue.map(item => <div className="ap-list-row" key={item.id}>
              <div className="ap-list-icon"><PanelIcon name={item.status === "downloading" ? "download" : "upload"} size={16}/></div>
              <div>
                <div className="ap-list-title">{item.name}</div>
                <div className="ap-list-note"><span className="ap-mono">{item.target}</span> · {formatBytes(item.size)} · {item.detail}</div>
              </div>
              <PanelBadge tone={queueTone(item.status)}>{queueLabel(item.status)}</PanelBadge>
              <div className="ap-row-action">
                {item.status === "failed" && item.file && <button className="ap-btn small" disabled={!!ops.busy} onClick={() => stageUpload(item)}>{t("Retry")}</button>}
                {(item.status === "failed" || item.status === "waiting") && <button className="ap-btn small" onClick={() => setQueue(rows => rows.filter(row => row.id !== item.id))}>{t("Dismiss")}</button>}
              </div>
            </div>)}
          </div>}
        </div>

        {tool && <div className="ap-card">
          <div className="ap-card-head">
            <strong>{tool === "folder" ? t("New folder") : tool === "rename" ? t("Rename") : tool === "archive" ? t("Archive") : tool === "extract" ? t("Extract") : t("Delete")}</strong>
            <button className="ap-btn small" onClick={() => setTool("")}>{t("Close")}</button>
          </div>
          <form className="ap-card-body" onSubmit={submitTool}>
            {tool === "folder" && <div className="ap-field"><label>{t("Folder name")}</label><input className="ap-input ap-mono" autoFocus value={form.folder} onChange={event => setForm(current => ({ ...current, folder:event.target.value }))}/></div>}
            {tool === "rename" && <div className="ap-field"><label>{t("New name")}</label><input className="ap-input ap-mono" autoFocus value={form.rename} onChange={event => setForm(current => ({ ...current, rename:event.target.value }))}/></div>}
            {tool === "archive" && <div className="ap-field">
              <label>{selectedPaths.length === 1 ? t("Archive target") : t("Suffix for each selected item")}</label>
              <input className="ap-input ap-mono" autoFocus value={form.archive} onChange={event => setForm(current => ({ ...current, archive:event.target.value }))} placeholder={selectedPaths.length === 1 ? "backup.tar.gz" : ".tar.gz"}/>
            </div>}
            {tool === "extract" && <div className="ap-field"><label>{t("Extract into; blank means document root")}</label><input className="ap-input ap-mono" autoFocus value={form.extract} onChange={event => setForm(current => ({ ...current, extract:event.target.value }))}/></div>}
            {tool === "delete" && <div className="ap-callout"><PanelIcon name="alert" size={18}/><strong>{(selectedPaths.length === 1 ? t("{count} item; approval requires DELETE", { count: selectedPaths.length }) : t("{count} items; approval requires DELETE", { count: selectedPaths.length }))}</strong></div>}
            <div className="ap-actions">
              <button className={`ap-btn ${tool === "delete" ? "danger" : "primary"}`} type="submit" disabled={!!ops.busy}>{t("Propose {tool}", { tool: tool })}</button>
              <button className="ap-btn" type="button" onClick={() => setTool("")}>{t("Cancel")}</button>
            </div>
          </form>
        </div>}

        {!!missingCapabilities.length && <div className="ap-card">
          <div className="ap-card-head"><strong>{t("Unavailable actions")}</strong><span>{missingCapabilities.length}</span></div>
          <div className="ap-card-body">
            {missingCapabilities.map(([capability, title]) => <ServerGate key={capability} title={title} reason={ops.why(capability)}/>)}
          </div>
        </div>}
      </div>

      <div className="ap-card">
        <div className="ap-card-head">
          <strong>{t("Server files")}</strong>
          <span>{t("{count} entries · {countvalue} selected", { count: files.data?.count == null ? 0 : files.data.count, countvalue: chosen.length })}</span>
        </div>
        <div className="ap-toolbar">
          {ops.can("site.files.folder") && <button className="ap-btn small" disabled={!domain || !!ops.busy} onClick={() => openTool("folder")}><PanelIcon name="plus" size={12}/>{t(" New folder")}</button>}
          {ops.can("site.files.rename") && <button className="ap-btn small" disabled={chosen.length !== 1 || !!ops.busy} onClick={() => openTool("rename")}>{t("Rename")}</button>}
          {ops.can("site.files.archive") && <button className="ap-btn small" disabled={!chosen.length || !!ops.busy} onClick={() => openTool("archive")}><PanelIcon name="archive" size={12}/>{t(" Archive")}</button>}
          {ops.can("site.files.extract") && <button className="ap-btn small" disabled={!selectedArchives.length || !!ops.busy} onClick={() => openTool("extract")}>{t("Extract")}</button>}
          {ops.can("site.files.delete") && <button className="ap-btn danger small" disabled={!chosen.length || !!ops.busy} onClick={() => openTool("delete")}><PanelIcon name="trash" size={12}/>{t(" Delete")}</button>}
        </div>

        {!domain ? <div className="ap-empty"><PanelIcon name="globe" size={25}/><strong>{t("Select a site")}</strong></div> : <ServerLoad state={files} empty={t("Nothing here")}>{data => {
          const entries = [...(data.entries || [])].sort((left, right) => {
            if (!!left.directory !== !!right.directory) return left.directory ? -1 : 1;
            return left.name.localeCompare(right.name, undefined, { numeric:true, sensitivity:"base" });
          });
          const allSelected = !!entries.length && entries.every(entry => chosen.includes(entry.name));
          return entries.length ? <div className="ap-table-wrap ap-scroll">
            <table className="ap-table ap-operator-table">
              <thead><tr>
                <th><input type="checkbox" aria-label={t("Select all")} checked={allSelected} onChange={event => setChosen(event.target.checked ? entries.map(entry => entry.name) : [])}/></th>
                <th>{t("Name")}</th><th>{t("Size")}</th><th>{t("Modified")}</th><th>{t("Permissions")}</th><th>{t("Actions")}</th>
              </tr></thead>
              <tbody>{entries.map(entry => {
                const path = joinPath(dir, entry.name);
                return <tr key={entry.name} onDoubleClick={() => entry.directory && goTo(path)}>
                  <td><input type="checkbox" aria-label={t("Select {name}", { name: entry.name })} checked={chosen.includes(entry.name)} onChange={() => toggle(entry.name)}/></td>
                  <td>
                    <div className="ap-list-row">
                      <span className="ap-list-icon"><PanelIcon name={entry.directory ? "folder" : "document"} size={15}/></span>
                      <strong className="ap-mono">{entry.name}{entry.directory ? "/" : ""}</strong>
                      {entry.symlink && <PanelBadge tone="neutral">{t("link")}</PanelBadge>}
                    </div>
                  </td>
                  <td className="ap-mono">{entry.directory ? "—" : formatBytes(entry.size_bytes)}</td>
                  <td>{formatDate(entry.modified)}</td>
                  <td className="ap-mono">{entry.mode || "—"}</td>
                  <td><div className="ap-row-action">
                    {entry.directory && <button className="ap-btn small" onClick={() => goTo(path)}>{t("Open")}</button>}
                    {!entry.directory && ops.can("site.files.read") && <button className="ap-btn small" disabled={!!ops.busy} onClick={() => openEditor(entry)}>{t("Edit")}</button>}
                    {!entry.directory && ops.can("site.files.stage") && <button className="ap-btn small" disabled={!!ops.busy} onClick={() => downloadEntry(entry)}><PanelIcon name="download" size={12}/>{t(" Download")}</button>}
                  </div></td>
                </tr>;
              })}</tbody>
            </table>
          </div> : <div className="ap-empty"><PanelIcon name="folder" size={25}/><strong>{t("This folder is empty")}</strong></div>;
        }}</ServerLoad>}

        {editor && <div className="ap-card-body">
          <div className="ap-card-head">
            <strong className="ap-mono">{t("Editing {path}", { path: editor.path })}</strong>
            <span>{formatBytes(editor.size)}</span>
            <button className="ap-btn small" onClick={() => setEditor(null)}>{t("Close")}</button>
          </div>
          {editor.loading ? <div className="ap-empty"><strong>{t("Reading the file…")}</strong></div>
            : editor.error ? <div className="ap-callout"><PanelIcon name="alert" size={18}/><strong>{editor.error}</strong></div>
            : <>
              <div className="ap-field"><label>{t("Contents")}</label><textarea className="ap-input ap-mono" rows="18" spellCheck="false" value={editor.content} onChange={event => setEditor(current => ({ ...current, content:event.target.value }))}/></div>
              <div className="ap-actions">
                {ops.can("site.files.write") ? <button className="ap-btn primary" disabled={!!ops.busy} onClick={saveEditor}>{t("Propose save")}</button>
                  : <ServerGate reason={ops.why("site.files.write")} title={t("Saving is not available")}/>}
                <button className="ap-btn" onClick={() => setEditor(null)}>{t("Cancel")}</button>
              </div>
            </>}
        </div>}
      </div>
    </div>
  </>;
}

function ServerFiles({ ops }) {
  const [dir, setDir] = useState("");
  const [chosen, setChosen] = useState([]);
  const [form, setForm] = useState({ mode:"644", recursive:false, archive:"backup.tar.gz" });
  const files = useServerRead(ops.api, "files", `dir=${encodeURIComponent(dir)}`, ops.can("file.list"));
  const diskUsage = useServerRead(ops.api, "disk-usage", "", ops.isOperator && ops.can("disk.usage"));
  const toggle = name => setChosen(list => list.includes(name) ? list.filter(n => n !== name) : [...list, name]);
  const within = name => (dir ? `${dir.replace(/\/$/,"")}/${name}` : name);
  const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";

  return <>
    <div className="ap-section-head"><div><h2>{t("Files and uploads")}</h2><p>{t("Permissions and archives inside this account's own file area. Uploads go over SFTP, turned on per website.")}</p></div></div>
    {ops.isOperator && <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("Disk usage by folder")}</strong><span>{diskUsage.data?.folders?.length||0}</span>{ops.can("disk.usage")&&<button className="ap-btn small" style={{marginLeft:8}} onClick={()=>diskUsage.reload()}><PanelIcon name="refresh" size={12}/></button>}</div>
      {!ops.can("disk.usage") ? <div className="ap-card-body"><ServerGate reason={ops.why("disk.usage")}/></div> : <ServerLoad state={diskUsage} empty={t("No folder usage was returned")}>{data => data.folders.length ? <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Folder")}</th><th>{t("Used")}</th></tr></thead>
        <tbody>{data.folders.map(row=><tr key={row.path}><td><strong className="ap-mono">{row.path}</strong></td><td className="ap-mono">{panelBytes(row.bytes)}</td></tr>)}</tbody>
      </table></div> : <div className="ap-empty"><PanelIcon name="folder" size={25}/><strong>{t("No folder usage was returned")}</strong></div>}</ServerLoad>}
    </div>}
    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("Files")}</strong><span className="ap-mono">{files.data?.dir||"/"}</span><button className="ap-btn small" style={{marginLeft:8}} onClick={()=>files.reload()}><PanelIcon name="refresh" size={12}/></button></div>
      {!ops.can("file.list") ? <div className="ap-card-body"><ServerGate reason={ops.why("file.list")}/></div> : <>
        <div className="ap-toolbar">
          {dir && <button className="ap-btn small" onClick={()=>{ setDir(parent); setChosen([]); }}>{t("Up one level")}</button>}
          <span style={{fontSize:10.5,color:"#68747f"}}>{t("{count} selected", { count: chosen.length })}</span>
          <span className="spacer"/>
          {ops.can("file.archive") && <>
            <input className="ap-input" value={form.archive} onChange={e=>setForm(v=>({...v,archive:e.target.value}))} placeholder="backup.tar.gz"/>
            <button className="ap-btn small" disabled={!!ops.busy||!chosen.length} onClick={()=>ops.propose("file.archive",{sources:chosen.map(within),archive:within(form.archive)})}>{t("Archive selection")}</button>
          </>}
        </div>
        <ServerLoad state={files} empty={t("Nothing here")}>{data => data.entries.length ? <div className="ap-table-wrap ap-scroll"><table className="ap-table">
          <thead><tr><th style={{width:28}}></th><th>{t("Name")}</th><th>{t("Permissions")}</th><th>{t("Size")}</th><th>{t("Actions")}</th></tr></thead>
          <tbody>{data.entries.map(entry => <tr key={entry.name}>
            <td><input type="checkbox" checked={chosen.includes(entry.name)} onChange={()=>toggle(entry.name)}/></td>
            <td>{entry.kind==="folder" ? <button className="ap-btn small" onClick={()=>{ setDir(within(entry.name)); setChosen([]); }}>{entry.name}/</button> : <strong>{entry.name}</strong>}</td>
            <td className="ap-mono">{entry.mode||"—"}</td>
            <td className="ap-mono">{entry.kind==="folder"?"—":panelBytes(entry.size_bytes)}</td>
            <td><div className="ap-actions">
              {ops.can("file.permissions") && <button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("file.permissions",{target:within(entry.name),mode:form.mode,recursive:form.recursive&&entry.kind==="folder"})}>{t("Set {mode}", { mode: form.mode })}</button>}
              {ops.can("file.extract") && /\.(zip|tar\.gz|tgz)$/i.test(entry.name) && <button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("file.extract",{archive:within(entry.name),into:dir})}>{t("Extract")}</button>}
            </div></td>
          </tr>)}</tbody>
        </table></div> : <div className="ap-empty"><PanelIcon name="folder" size={25}/><strong>{t("This folder is empty")}</strong></div>}</ServerLoad>
        {ops.can("file.permissions") && <div className="ap-toolbar" style={{borderTop:"1px solid #e6eaee",borderBottom:0}}>
          <label>{t("Permissions to apply")}</label>
          <input className="ap-input" style={{flex:"0 0 80px"}} value={form.mode} onChange={e=>setForm(v=>({...v,mode:e.target.value}))} placeholder="644"/>
          <label className="ap-check" style={{fontSize:10.5}}><input type="checkbox" checked={form.recursive} onChange={e=>setForm(v=>({...v,recursive:e.target.checked}))}/>{t("and everything inside a folder")}</label>
        </div>}
      </>}
    </div>
    <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Uploading files")}</strong></div>
      <div className="ap-card-body">
        <p style={{margin:0,fontSize:12,lineHeight:1.6}}>{t("Uploads go over SFTP, which is turned on for one website at a time on that website's own screen. It uses port 22, confines the login to that site's folder, and gives it no shell. There is no FTP: it sends the password in the clear and nothing here needs it.")}</p>
      </div>
    </div>
  </>;
}

// The settings a provider asks for, drawn from what the provider says it needs
// rather than from a list kept in here. A backend added to the manifest gets
// its form for free, which is the point of putting the fields in the manifest.
//
// One field goes over as the bare value, because that is the shape smtp.generic
// has always had and a URL is not improved by being wrapped in JSON. More than
// one goes over as a JSON object, which is what every destination adapter
// parses. Empty optional fields are left out rather than sent as blanks.
function ProviderCredentialFields({ fields, values, onChange }) {
  if (!fields || !fields.length) {
    return <div className="ap-field"><label>{t("Key")}</label>
      <input className="ap-input" type="password" autoComplete="new-password" value={values._single || ""}
        onChange={e=>onChange({...values, _single:e.target.value})} placeholder={t("Stored encrypted. Never shown again.")}/></div>;
  }
  return <>{fields.map(f => <div className="ap-field" key={f.name}>
    <label>{f.label}{f.required && <span style={{color:"#b4442f"}}> *</span>}</label>
    {f.multiline
      ? <textarea className="ap-input" rows={4} value={values[f.name]||""} placeholder={f.example||""}
          onChange={e=>onChange({...values,[f.name]:e.target.value})}/>
      : <input className="ap-input" type={f.secret?"password":"text"} autoComplete={f.secret?"new-password":"off"}
          value={values[f.name]||""} placeholder={f.example||""}
          onChange={e=>onChange({...values,[f.name]:e.target.value})}/>}
    {f.example && !f.multiline && <div style={{fontSize:10.5,color:"#687486",marginTop:3}}>{f.example}</div>}
  </div>)}</>;
}

function buildCredential(fields, values) {
  if (!fields || !fields.length) return values._single || "";
  if (fields.length === 1) return values[fields[0].name] || "";
  const out = {};
  for (const f of fields) { const v = (values[f.name]||"").trim(); if (v) out[f.name] = v; }
  return JSON.stringify(out);
}

// Backup destinations. Its own screen rather than a filter on Integrations,
// because it answers a different question: not who serves each thing, but where
// the backups go and whether that place answered the last time anybody asked.
// The same bindings sit behind both, and connecting one here is the same
// proposed-and-approved write it is there.
function ServerBackupDestinations({ ops }) {
  const [form, setForm] = useState({ provider:"", scope:"platform" });
  const [values, setValues] = useState({});
  const view = useServerRead(ops.api, "integrations", "", ops.can("integration.list"));
  if (!ops.can("integration.list")) {
    return <div className="ap-card"><div className="ap-card-head"><strong>{t("Backup destinations")}</strong></div>
      <div className="ap-card-body"><ServerGate reason={ops.why("integration.list")}/></div></div>;
  }
  return <>
    <div className="ap-section-head"><div><h2>{t("Backup destinations")}</h2>
      <p>{t("Where a backup goes when it leaves this machine. Connect a destination once, here, and every backup can use it. Nobody with a site on this server can name a destination; that is yours to set.")}</p></div></div>
    <ServerLoad state={view} empty={t("Nothing to show")}>{data => {
      const offsite = data.capabilities.find(c => c.capability === "backup.offsite") || { offers:[], binding:null };
      const bound = data.bindings.filter(b => b.capability === "backup.offsite");
      const offers = (offsite.offers||[]).filter(o => o.kind !== "local");
      const chosen = offers.find(o => o.id === form.provider);
      const missing = (chosen?.auth_fields||[]).filter(f => f.required && !(values[f.name]||"").trim());
      return <>
        <div className="ap-card" style={{marginBottom:12}}>
          <div className="ap-card-head"><strong>{t("Where backups go now")}</strong>
            <span>{offsite.served_by_name || t("nowhere but this disk")}</span></div>
          <div className="ap-card-body">
            {!bound.length
              ? <div className="ap-empty"><strong>{t("Backups stay on this machine")}</strong>
                  <span>{t("A copy on the same disk as the site is not a backup of it. Connect somewhere below and the next backup goes there too.")}</span></div>
              : <div className="ap-table-wrap"><table className="ap-table">
                  <thead><tr><th>{t("Destination")}</th><th>{t("Applies to")}</th><th>{t("Settings")}</th><th>{t("Last tested")}</th><th>{t("Actions")}</th></tr></thead>
                  <tbody>{bound.map(b => <tr key={b.id}>
                    <td><strong>{b.provider_name}</strong></td>
                    <td>{b.scope}{b.scope_id?`: ${b.scope_id}`:""}</td>
                    <td className="ap-mono" style={{fontSize:10.5}}>{b.credential ? `…${b.credential.ends_with} · ${b.credential.fingerprint}` : t("none")}</td>
                    <td>{b.last_probe_at
                      ? <><span className={`ap-chip ${b.last_probe_ok?"ok":"danger"}`}>{b.last_probe_ok?t("passed"):t("failed")}</span>
                          <div style={{fontSize:10.5,color:"#687486"}}>{panelDate(b.last_probe_at,true)}</div>
                          {!b.last_probe_ok && b.status_reason && <div style={{fontSize:10.5,color:"#b4442f"}}>{b.status_reason}</div>}</>
                      : <span style={{color:"#687486"}}>{t("never tested since it was connected")}</span>}</td>
                    <td style={{whiteSpace:"nowrap"}}>
                      {ops.can("integration.test") && <button className="ap-btn small" disabled={!!ops.busy}
                        onClick={()=>ops.propose("integration.test",{id:b.id})}>{t("Test")}</button>}{" "}
                      {ops.can("integration.disconnect") && <button className="ap-btn danger small" disabled={!!ops.busy}
                        onClick={()=>ops.propose("integration.disconnect",{id:b.id})}>{t("Remove")}</button>}
                    </td>
                  </tr>)}</tbody>
                </table></div>}
            <p style={{margin:"10px 0 0",fontSize:11.5,lineHeight:1.6,color:"#687486"}}>{t("A test writes a small object to the destination, reads it back, compares it byte for byte and removes it again. Nothing already stored there is touched, and a destination that has not done that is not shown as working.")}</p>
          </div>
        </div>

        {ops.can("integration.connect") && <div className="ap-card" style={{marginBottom:12}}>
          <div className="ap-card-head"><strong>{t("Connect a destination")}</strong></div>
          <div className="ap-card-body">
            <div className="ap-form">
              <div className="ap-field"><label>{t("Kind")}</label>
                <select className="ap-input" value={form.provider} onChange={e=>{setForm(v=>({...v,provider:e.target.value})); setValues({});}}>
                  <option value="">{t("Choose")}</option>
                  {/* A destination that has not been proven against the real
                      service is listed and disabled rather than hidden, so the
                      answer to "can I use B2" is on the screen instead of being
                      absent. It cannot be selected, and the server refuses it
                      too, so this is not the only thing stopping it. */}
                  {offers.map(o => <option key={o.id} value={o.id} disabled={o.available === false}>
                    {o.name}{o.available === false ? t(" (coming soon)") : ""}
                  </option>)}
                </select>
                {chosen?.caveat && <div style={{fontSize:10.5,color:"#8a5a1f",marginTop:4}}>{chosen.caveat}</div>}
                {(offers || []).some(o => o.available === false) && <div style={{fontSize:10.5,color:"#687486",marginTop:4}}>
                  {(offers.find(o => o.available === false) || {}).unavailable_reason}
                </div>}</div>
              <div className="ap-field"><label>{t("Applies to")}</label>
                <select className="ap-input" value={form.scope} onChange={e=>setForm(v=>({...v,scope:e.target.value}))}>
                  <option value="platform">{t("Every account on this deployment")}</option>
                  <option value="reseller">{t("One reseller")}</option>
                  <option value="account">{t("One account")}</option>
                </select></div>
              {chosen && <ProviderCredentialFields fields={chosen.auth_fields} values={values} onChange={setValues}/>}
            </div>
            {chosen && <div className="ap-actions" style={{marginTop:12}}>
              <button className="ap-btn primary" disabled={!!ops.busy||missing.length>0}
                onClick={()=>{ops.propose("integration.connect",{capability:"backup.offsite",provider:form.provider,scope:form.scope,credential:buildCredential(chosen.auth_fields,values)}); setValues({});}}>{t("Propose destination")}</button>
              <span style={{fontSize:11,color:"#687486"}}>
                {missing.length ? t("Still needed: {count}", { count: missing.map(f=>f.label).join(", ") }) : t("Approving it writes a test object there and reads it back. It is not stored as connected unless that works.")}
              </span>
            </div>}
          </div>
        </div>}

        {ops.can("capability.backup.offsite.store") && <div className="ap-card">
          <div className="ap-card-head"><strong>{t("Send a backup offsite now")}</strong></div>
          <div className="ap-card-body">
            <p style={{margin:"0 0 10px",fontSize:12,lineHeight:1.6}}>{t("Takes a backup and stores it wherever this deployment is pointed. It is the same operation a site owner can ask for on their own domain, and neither of you names the destination.")}</p>
            <div className="ap-form">
              <div className="ap-field"><label>{t("Domain")}</label>
                <input className="ap-input" value={form.domain||""} placeholder="example.com"
                  onChange={e=>setForm(v=>({...v,domain:e.target.value}))}/></div>
              <div className="ap-field"><label>{t("Keep how many")}</label>
                <input className="ap-input" type="number" min="1" max="90" value={form.keep||7}
                  onChange={e=>setForm(v=>({...v,keep:e.target.value}))}/></div>
            </div>
            <div className="ap-actions" style={{marginTop:12}}>
              <button className="ap-btn primary" disabled={!!ops.busy||!(form.domain||"").trim()}
                onClick={()=>ops.propose("capability.backup.offsite.store",{domain:(form.domain||"").trim(),parts:["files","mail"],keep:Number(form.keep)||7})}>{t("Propose an offsite backup")}</button>
            </div>
          </div>
        </div>}
      </>;
    }}</ServerLoad>
  </>;
}

// Integrations. Two questions an operator actually has, in this order: who is
// serving each thing here, and what have we connected. Keys are entered once
// and never shown again, so a connected provider shows a fingerprint and a
// Replace, never a Reveal.
function ServerIntegrations({ ops }) {
  const [form, setForm] = useState({ capability:"", provider:"", scope:"platform" });
  const [values, setValues] = useState({});
  const view = useServerRead(ops.api, "integrations", "", ops.can("integration.list"));
  if (!ops.can("integration.list")) {
    return <div className="ap-card"><div className="ap-card-head"><strong>{t("Integrations")}</strong></div>
      <div className="ap-card-body"><ServerGate reason={ops.why("integration.list")}/></div></div>;
  }
  const chip = c => c.usable
    ? <span className="ap-chip ok">{c.via === "local" ? t("this server") : c.via}</span>
    : <span className="ap-chip">{t("not set up")}</span>;
  return <>
    <div className="ap-section-head"><div><h2>{t("Integrations")}</h2><p>{t("Who serves each thing this panel needs from outside. A key is entered once, here, by you, and is never shown again to anyone.")}</p></div></div>
    <ServerLoad state={view} empty={t("Nothing to show")}>{data => <>
      <div className="ap-card" style={{marginBottom:12}}>
        <div className="ap-card-head"><strong>{t("By capability")}</strong><span>{data.capabilities.length}</span></div>
        <div className="ap-table-wrap"><table className="ap-table">
          <thead><tr><th>{t("What")}</th><th>{t("Served by")}</th><th>{t("State")}</th><th>{t("Actions")}</th></tr></thead>
          <tbody>{data.capabilities.map(c => <tr key={c.capability}>
            <td><strong>{c.title}</strong><div style={{fontSize:10.5,color:"#687486"}}>{c.blurb}</div></td>
            <td>{c.served_by_name || <span style={{color:"#687486"}}>{t("nobody yet")}</span>}
              {c.reason && !c.usable && <div style={{fontSize:10.5,color:"#687486"}}>{c.reason}</div>}</td>
            <td>{chip(c)}</td>
            <td>{c.binding && ops.can("integration.disconnect") &&
              <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("integration.disconnect",{id:c.binding.id})}>{t("Disconnect")}</button>}</td>
          </tr>)}</tbody>
        </table></div>
      </div>

      {/* The three doors, for a capability with nothing behind it. Every offer
          says what it costs and where the data sits, and an offer that carries
          a referral says so on the card rather than in a footer nobody reads. */}
      {data.capabilities.filter(c => !c.usable).map(c => (
        <div className="ap-card" style={{marginBottom:12}} key={`offer-${c.capability}`}>
          <div className="ap-card-head"><strong>{t("{title}: nothing is set up", { title: c.title })}</strong></div>
          <div className="ap-card-body">
            <p style={{margin:"0 0 10px",fontSize:12,lineHeight:1.6}}>{t("Three ways forward. Connect an account you already have, use the one that comes with your hosting, or open an account with one of these.")}</p>
            {c.offers.length ? <div className="ap-table-wrap"><table className="ap-table">
              <thead><tr><th>{t("Provider")}</th><th>{t("Cost")}</th><th>{t("Where the data sits")}</th><th></th></tr></thead>
              <tbody>{c.offers.map(o => <tr key={o.id}>
                <td><strong>{o.name}</strong>{o.referral.present && <span className="ap-chip" style={{marginLeft:6}} title={o.referral.disclosed_as}>{t("we earn a commission")}</span>}
                  {o.caveat && <div style={{fontSize:10.5,color:"#687486"}}>{o.caveat}</div>}</td>
                <td>{o.billing_model}</td>
                <td>{(o.data_regions||[]).join(", ")}</td>
                <td>{o.docs_url && <a className="ap-btn small" href={o.docs_url} target="_blank" rel="noreferrer noopener">{t("Docs")}</a>}</td>
              </tr>)}</tbody>
            </table></div> : <div className="ap-empty"><strong>{t("No provider for this yet")}</strong><span>{t("Nothing in this build serves it.")}</span></div>}
          </div>
        </div>
      ))}

      {ops.can("integration.connect") && <div className="ap-card">
        <div className="ap-card-head"><strong>{t("Connect an account")}</strong></div>
        <div className="ap-card-body">
          <div className="ap-form">
            <div className="ap-field"><label>{t("What for")}</label>
              <select className="ap-input" value={form.capability} onChange={e=>setForm(v=>({...v,capability:e.target.value,provider:""}))}>
                <option value="">{t("Choose")}</option>
                {data.capabilities.map(c => <option key={c.capability} value={c.capability}>{c.title}</option>)}
              </select></div>
            <div className="ap-field"><label>{t("Provider")}</label>
              <select className="ap-input" value={form.provider} onChange={e=>{setForm(v=>({...v,provider:e.target.value})); setValues({});}}>
                <option value="">{t("Choose")}</option>
                {(data.capabilities.find(c=>c.capability===form.capability)?.offers||[]).filter(o=>o.kind!=="local").map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select></div>
            <div className="ap-field"><label>{t("Applies to")}</label>
              <select className="ap-input" value={form.scope} onChange={e=>setForm(v=>({...v,scope:e.target.value}))}>
                <option value="platform">{t("Everyone on this deployment")}</option>
                <option value="reseller">{t("One reseller")}</option>
                <option value="account">{t("One account")}</option>
              </select></div>
            {/* Drawn from what the chosen provider says it needs. A destination
                asks for a host and a directory, an object store asks for six
                things, and neither of them is served by one box marked Key. */}
            <ProviderCredentialFields
              fields={(data.capabilities.find(c=>c.capability===form.capability)?.offers||[]).find(o=>o.id===form.provider)?.auth_fields}
              values={values} onChange={setValues}/>
          </div>
          <div className="ap-actions" style={{marginTop:12}}>
            <button className="ap-btn primary" disabled={!!ops.busy||!form.capability||!form.provider}
              onClick={()=>{
                const chosen = (data.capabilities.find(c=>c.capability===form.capability)?.offers||[]).find(o=>o.id===form.provider);
                ops.propose("integration.connect",{capability:form.capability,provider:form.provider,scope:form.scope,credential:buildCredential(chosen?.auth_fields,values)});
                setValues({});
              }}>{t("Propose connection")}</button>
          </div>
        </div>
      </div>}

      {data.bindings.length > 0 && <div className="ap-card" style={{marginTop:12}}>
        <div className="ap-card-head"><strong>{t("Connected")}</strong><span>{data.bindings.length}</span></div>
        <div className="ap-table-wrap"><table className="ap-table">
          <thead><tr><th>{t("Provider")}</th><th>{t("For")}</th><th>{t("Applies to")}</th><th>{t("Key")}</th><th>{t("State")}</th></tr></thead>
          <tbody>{data.bindings.map(b => <tr key={b.id}>
            <td><strong>{b.provider_name}</strong></td><td>{b.capability}</td><td>{b.scope}</td>
            <td className="ap-mono" style={{fontSize:10.5}}>{b.credential ? `…${b.credential.ends_with} · ${b.credential.fingerprint}` : t("none")}</td>
            <td>{b.status}{b.status_reason && <div style={{fontSize:10.5,color:"#687486"}}>{b.status_reason}</div>}</td>
          </tr>)}</tbody>
        </table></div>
      </div>}
    </>}</ServerLoad>
  </>;
}

function ServerDns({ ops }) {
  const [zone, setZone] = useState(ops.scope?.primaryDomain || "");
  const [applied, setApplied] = useState(ops.scope?.primaryDomain || "");
  const [record, setRecord] = useState({ label:"", type:"A", value:"", preference:"10", ttl:"" });
  const zones = useServerRead(ops.api, "dns-zones", "", ops.can("dns.zones"));
  const records = useServerRead(ops.api, "dns-records", `zone=${encodeURIComponent(applied)}`, !!applied && ops.can("dns.records"));

  if (!ops.can("dns.records")) return <><div className="ap-section-head"><div><h2>{t("DNS zone")}</h2></div></div><ServerGate reason={ops.why("dns.records")}/></>;

  return <>
    <div className="ap-section-head"><div><h2>{t("DNS zone")}</h2><p>{t("What is published for this domain right now, read before anything is added to it.")}</p></div></div>
    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-toolbar">
        <label>{t("Zone")}</label>
        {zones.data?.zones?.length
          ? <select className="ap-input" value={applied} onChange={e=>{ setZone(e.target.value); setApplied(e.target.value); }}>{zones.data.zones.map(z=><option key={z.zone} value={z.zone}>{z.zone}</option>)}</select>
          : <form style={{display:"contents"}} onSubmit={e=>{ e.preventDefault(); setApplied(zone.trim()); }}>
              <input className="ap-input" value={zone} onChange={e=>setZone(e.target.value)} placeholder="example.com"/>
              <button className="ap-btn small" type="submit" disabled={!zone.trim()}>{t("Read zone")}</button>
            </form>}
        <span className="spacer"/>
        {records.data && <PanelBadge tone={records.data.authoritative?"ok":"info"}>{records.data.authoritative?t("from the name server"):t("as the internet answers it")}</PanelBadge>}
        <button className="ap-btn small" onClick={()=>records.reload()}><PanelIcon name="refresh" size={12}/></button>
      </div>
      <ServerLoad state={records} empty={t("Name a zone to read it")}>{data => data.records.length ? <div className="ap-table-wrap ap-scroll"><table className="ap-table">
        <thead><tr><th>{t("Name")}</th><th>{t("Type")}</th><th>{t("Value")}</th><th>{t("TTL")}</th><th>{t("Actions")}</th></tr></thead>
        <tbody>{data.records.map((row, i) => <tr key={`${row.type}-${row.name}-${i}`}>
          <td className="ap-mono">{row.name}</td><td><PanelBadge tone="neutral">{row.type}</PanelBadge></td>
          <td className="ap-mono" style={{fontSize:10.5,maxWidth:380,wordBreak:"break-all"}}>{row.value}{row.preference!=null?t(" (priority {preference})", { preference: row.preference }):""}</td>
          <td className="ap-mono">{row.ttl??"—"}</td>
          <td>{ops.can("dns.record.delete") && <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("dns.record.delete",{zone:applied,label:row.name,type:row.type,value:row.value})}>{t("Delete")}</button>}</td>
        </tr>)}</tbody>
      </table></div> : <div className="ap-empty"><PanelIcon name="globe" size={25}/><strong>{t("Nothing is published for {applied}", { applied: applied })}</strong><span>{(data.notes||[]).join("; ")||t("No records answered for the usual types.")}</span></div>}</ServerLoad>
    </div>
    <div className="ap-card"><div className="ap-card-head"><strong>{t("Add a record")}</strong><span>{applied}</span></div><div className="ap-card-body">
      {!ops.can("dns.record.create") ? <ServerGate reason={ops.why("dns.record.create")}/> : <>
        <div className="ap-form">
          <div className="ap-field"><label>{t("Name")}</label><input className="ap-input" value={record.label} onChange={e=>setRecord(v=>({...v,label:e.target.value}))} placeholder={t("www or @")}/></div>
          <div className="ap-field"><label>{t("Type")}</label><select className="ap-input" value={record.type} onChange={e=>setRecord(v=>({...v,type:e.target.value}))}>{["A","AAAA","CNAME","TXT","MX","NS","SRV","CAA"].map(tabId=><option key={tabId} value={tabId}>{tabId}</option>)}</select></div>
          <div className="ap-field"><label>{t("Value")}</label><input className="ap-input" value={record.value} onChange={e=>setRecord(v=>({...v,value:e.target.value}))} placeholder="203.0.113.9"/></div>
          {record.type==="MX" && <div className="ap-field"><label>{t("Priority")}</label><input className="ap-input" value={record.preference} onChange={e=>setRecord(v=>({...v,preference:e.target.value}))}/></div>}
        </div>
        <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy||!applied||!record.value} onClick={()=>ops.propose("dns.record.create",{zone:applied,label:record.label||"@",type:record.type,value:record.value,preference:record.preference,ttl:record.ttl||null})}>{t("Propose record")}</button></div>
      </>}
    </div></div>
  </>;
}

function ServerSecurity({ ops }) {
  const [rule, setRule] = useState({ port:"", protocol:"tcp", address:"" });
  const [key, setKey] = useState("");
  const firewall = useServerRead(ops.api, "firewall", "", ops.can("firewall.list"));
  const fail2ban = useServerRead(ops.api, "fail2ban-bans", "", ops.can("fail2ban.list"));
  const packages = useServerRead(ops.api, "packages", "", ops.can("packages.status"));
  const keys = useServerRead(ops.api, "ssh-keys", "", ops.can("sshkey.list"));

  return <>
    <div className="ap-section-head"><div><h2>{t("Firewall, updates and keys")}</h2><p>{t("The three things that decide who can reach this machine.")}</p></div></div>
    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("Firewall")}</strong><span>{firewall.data?(firewall.data.active?t("{engine} active", { engine: firewall.data.engine }):t("{engine} switched off", { engine: firewall.data.engine })):""}</span></div>
      {!ops.can("firewall.list") ? <div className="ap-card-body"><ServerGate reason={ops.why("firewall.list")}/></div> : <>
        <ServerLoad state={firewall} empty={t("No rules")}>{data => data.rules.length ? <div className="ap-table-wrap ap-scroll"><table className="ap-table">
          <thead><tr><th>#</th><th>{t("Action")}</th><th>{t("Target")}</th><th>{t("From")}</th><th></th></tr></thead>
          <tbody>{data.rules.map(row => <tr key={row.index}><td className="ap-mono">{row.index}</td>
            <td><PanelBadge tone={row.action==="ALLOW"?"ok":"bad"}>{row.action}</PanelBadge></td>
            <td className="ap-mono">{row.target}</td><td className="ap-mono">{row.from}</td>
            <td>{ops.can("firewall.rule") && <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("firewall.remove",{index:row.index})}>{t("Remove")}</button>}</td>
          </tr>)}</tbody>
        </table></div> : <div className="ap-empty"><strong>{t("No firewall rules are set")}</strong></div>}</ServerLoad>
        {ops.can("firewall.rule") && <div className="ap-toolbar" style={{borderTop:"1px solid #e6eaee",borderBottom:0}}>
          <input className="ap-input" style={{flex:"0 0 90px"}} value={rule.port} onChange={e=>setRule(v=>({...v,port:e.target.value}))} placeholder={t("Port")}/>
          <select className="ap-input" value={rule.protocol} onChange={e=>setRule(v=>({...v,protocol:e.target.value}))}><option value="tcp">{"tcp"}</option><option value="udp">{"udp"}</option></select>
          <input className="ap-input" value={rule.address} onChange={e=>setRule(v=>({...v,address:e.target.value}))} placeholder={t("From address or range, optional")}/>
          <button className="ap-btn" disabled={!!ops.busy||!rule.port} onClick={()=>ops.propose("firewall.allow",rule)}>{t("Propose allow")}</button>
          <button className="ap-btn danger" disabled={!!ops.busy||(!rule.port&&!rule.address)} onClick={()=>ops.propose("firewall.deny",rule)}>{t("Propose block")}</button>
        </div>}
      </>}
    </div>
    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("Brute-force blocking")}</strong><span>{fail2ban.data?t("{count} banned", { count: fail2ban.data.bans.length }):"fail2ban"}</span>{ops.can("fail2ban.list")&&<button className="ap-btn small" style={{marginLeft:8}} onClick={()=>fail2ban.reload()}><PanelIcon name="refresh" size={12}/></button>}</div>
      {!ops.can("fail2ban.list") ? <div className="ap-card-body"><ServerGate reason={ops.why("fail2ban.list")} title={t("Automatic brute-force blocking is not available")}/>
        {ops.can("stack.install") && <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy} onClick={()=>ops.propose("stack.install.fail2ban",{})}>{t("Install fail2ban here")}</button></div>}
      </div> : <ServerLoad state={fail2ban} empty={t("No addresses are banned")}>{data => data.bans.length ? <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Address")}</th><th>{t("Jail")}</th><th>{t("Banned")}</th><th>{t("Actions")}</th></tr></thead>
        <tbody>{data.bans.map(row=><tr key={`${row.jail}-${row.ip}`}><td><strong className="ap-mono">{row.ip}</strong></td><td>{row.jail}</td><td>{panelDate(row.banned_at,true)}</td><td>{ops.can("fail2ban.unban")&&<button className="ap-btn small" disabled={!!ops.busy} onClick={()=>ops.propose("fail2ban.unban",{ip:row.ip,jail:row.jail})}>{t("Unban")}</button>}</td></tr>)}</tbody>
      </table></div> : <div className="ap-empty"><PanelIcon name="shield" size={25}/><strong>{t("No addresses are banned")}</strong><span>{t("SSH and mail jails are watching for repeated failures.")}</span></div>}</ServerLoad>}
    </div>
    <div className="ap-grid-even">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Updates")}</strong><span>{packages.data?t("{count} waiting", { count: packages.data.count }):""}</span></div><div className="ap-card-body">
        {!ops.can("packages.status") ? <ServerGate reason={ops.why("packages.status")}/> : <ServerLoad state={packages} empty={t("Not checked")}>{data => <>
          <div className="ap-grid-even" style={{margin:0}}>
            <div><div className="ap-list-title">{t("{securitycount} security", { securitycount: data.security_count })}</div><div className="ap-list-note">{t("of {count} updates waiting", { count: data.count })}</div></div>
            <div><div className="ap-list-title">{data.reboot_state==="unknown"?t("Whether a restart is needed is not recorded here"):data.reboot_required?t("A restart is needed"):t("No restart needed")}</div><div className="ap-list-note">{t("checked ")}{panelDate(data.checked_at,true)}</div></div>
          </div>
          {!!data.packages.length && <div className="ap-scroll" style={{marginTop:11,maxHeight:170}}>{data.packages.slice(0,60).map(p => <div key={p.name} style={{fontSize:10.5,padding:"2px 0",color:"#5d6a79"}}><span className="ap-mono">{p.name}</span> {p.installed} → {p.candidate}{p.security?" · security":""}</div>)}</div>}
          {ops.can("packages.apply") && !!data.count && <div className="ap-actions" style={{marginTop:12}}>
            <button className="ap-btn primary" disabled={!!ops.busy||!data.security_count} onClick={()=>ops.propose("packages.apply",{securityOnly:true})}>{t("Propose security updates")}</button>
            <button className="ap-btn" disabled={!!ops.busy} onClick={()=>ops.propose("packages.apply",{securityOnly:false})}>{t("Propose every update")}</button>
          </div>}
        </>}</ServerLoad>}
      </div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("SSH access")}</strong><span>{keys.data?t("{count} keys", { count: keys.data.keys.length }):""}</span></div><div className="ap-card-body">
        {!ops.can("sshkey.list") ? <ServerGate reason={ops.why("sshkey.list")}/> : <ServerLoad state={keys} empty={t("No keys")}>{data => <>
          {data.keys.length ? data.keys.map(entry => <div key={entry.line} className="ap-list-row" style={{padding:"7px 0"}}>
            <div style={{minWidth:0,flex:1}}><div className="ap-list-title">{entry.comment}</div><div className="ap-list-note ap-mono" style={{fontSize:9.5,wordBreak:"break-all"}}>{entry.type} · {entry.fingerprint||t("fingerprint unavailable")}</div></div>
            {ops.can("sshkey.remove") && <button className="ap-btn danger small" disabled={!!ops.busy} onClick={()=>ops.propose("sshkey.remove",{line:entry.line})}>{t("Revoke")}</button>}
          </div>) : <div className="ap-list-note">{t("No key is authorised on this account, so nobody can sign in over SSH with one.")}</div>}
          {ops.can("sshkey.add") && <>
            <div className="ap-field" style={{marginTop:12}}><label>{t("Add a public key")}</label><input className="ap-input ap-mono" value={key} onChange={e=>setKey(e.target.value)} placeholder={"ssh-ed25519 AAAA… you@laptop"}/></div>
            <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={!!ops.busy||!key.trim()} onClick={()=>ops.propose("sshkey.add",{key:key.trim()})}>{t("Propose key")}</button></div>
          </>}
        </>}</ServerLoad>}
      </div></div>
    </div>
  </>;
}

// The fixed half of the tool list, in one place for both shells.
//
// It is a pure function of the numbers on the badges so it can be checked
// without rendering anything, which is what keeps the two shells from drifting:
// `section` is what the standalone panel opens and `app` is the window the
// desktop opens instead, and a tool without a `section` would be reachable on
// the desktop and dead in the panel. The test asserts every entry has one.
//
// The server-operations group is not here on purpose. It is built from what the
// machine reported it can do, so it has no fixed membership.
export function panelToolGroups({ sites = [], certAttention = 0, overview, stats, usage, license, activeActions = [], operator = false } = {}) {
  return [
    { title:t("Websites & files"), note:t("Everything that makes a site live and movable"), tools:[
      { art:"websites", label:t("Domains & sites"), description:t("Sites, domains and publishing"), keywords:"website dns hosting", section:"sites", status:(sites.length===1 ? t("{count} site", { count: sites.length }) : t("{count} sites", { count: sites.length })), tone:"blue" },
      { art:"certificate", label:t("Certificate health"), description:t("TLS checks and expiry"), keywords:"ssl https security", section:"sites", status:certAttention?t("{certattention} need attention", { certattention: certAttention }):t("All clear"), tone:certAttention?"amber":"green" },
      { art:"files", label:t("File manager"), description:t("Browse, upload and organise"), keywords:"folders storage", app:"files", section:"files", status:t("Open vault"), tone:"yellow" },
      { art:"mover", label:t("Move & restore"), description:t("Export or migrate an account"), keywords:"backup import archive portability", section:"portability", status:"ZIP · TAR", tone:"orange" },
    ]},
    { title:t("Mail & automation"), note:t("The jobs and messages that keep the account moving"), tools:[
      { art:"mail", label:t("Mail"), description:t("Read and reply on this server"), keywords:"email inbox messages", app:"mail", section:"mail", status:t("Open inbox"), tone:"blue" },
      { art:"jobs", label:t("Scheduled jobs"), description:t("Cron commands with owner notes"), keywords:"automation task timer", section:"jobs", status:t("{count} enabled", { count: overview?.jobs?.enabled||0 }), tone:overview?.jobs?.failed?"amber":"purple" },
      { art:"settings", label:t("Server settings"), description:t("Panel and connection settings"), keywords:"configuration owner", app:"settings", section:"settings", status:t("Owner only"), tone:"coral" },
    ]},
    { title:t("Insight & control"), note:t("See what happened, what it cost and what needs you"), tools:[
      { art:"statistics", label:t("Web statistics"), description:t("Visits, pages and sources"), keywords:"analytics traffic metrics", section:"statistics", status:t("{count} views", { count: Number(stats?.totals?.pageviews||0).toLocaleString() }), tone:"blue" },
      { art:"usage", label:t("Usage feed"), description:t("Storage, service time and AI"), keywords:"billing consumption csv", section:"usage", status:panelFormatBytes(usage?.storage?.end_bytes), tone:"green" },
      { art:"activity", label:t("Approval desk"), description:t("Propose, approve, then execute"), keywords:"actions audit record", section:"activity", status:activeActions.length?t("{count} waiting", { count: activeActions.length }):t("Nothing waiting"), tone:activeActions.length?"amber":"green" },
      // Registration is the installation's, and there is one per box. Offering
      // it to a customer put a card in front of them that opens a screen they
      // do not have and calls an endpoint that refuses them.
      ...(operator ? [{ art:"registration", label:t("Registration"), description:t("Connect the assistant service"), keywords:"license key thinking", section:"license", status:license?.registered?(license.status||t("Registered")):t("Optional"), tone:license?.status==="banned"?"amber":"purple" }] : []),
    ]},
  ];
}

// Every section id the panel renders. A tool pointing at anything not in here
// would open a blank screen, which the test also checks for.
// ── Mail authentication ──────────────────────────────────────────
//
// Three records decide whether the world believes your mail, every failure is
// silent, and the tools that read them for you cost twenty-five to forty-five
// dollars a month for one domain. This screen is both halves: what is wrong,
// in sentences, and what is arriving, by sender.
//
// The shape is deliberate. Nobody wants a DMARC dashboard. They want to know
// why their mail goes to spam, so the answer comes first and the evidence sits
// under it.
function MailAuthentication({ ops }) {
  const domains = useServerRead(ops.api, "mail-domains", "", ops.can("mail.domains"));
  const sites = useServerRead(ops.api, "server-sites", "", ops.can("site.list"));
  const [domain, setDomain] = useState("");
  const choices = [
    ...((domains.data?.domains || []).map(d => d.domain || d)),
    ...((sites.data?.sites || []).map(s => s.domain)),
  ].filter((v, i, a) => v && a.indexOf(v) === i);
  const active = domain || choices[0] || "";
  const check = useServerRead(ops.api, "mail-auth", active ? `domain=${encodeURIComponent(active)}` : "", !!active);
  // Which zones this machine actually holds. Correlated with the check below,
  // because a record written into a zone nobody is told to ask about is the
  // same as no record, and being told "missing" when the file is right there
  // sends people looking in the wrong place.
  const zones = useServerRead(ops.api, "dns-zones", "", ops.can("dns.zones"));
  const reports = useServerRead(ops.api, "dmarc-reports", active ? `domain=${encodeURIComponent(active)}` : "", !!active && ops.can("dmarc.reports.read"));

  const data = check.data;
  const parts = [
    { key: "spf", label: "SPF", present: data?.spf?.present, blurb: t("Says which machines may send as you.") },
    { key: "dkim", label: "DKIM", present: data?.dkim?.present, blurb: t("Signs your mail so it cannot be altered or faked.") },
    { key: "dmarc", label: "DMARC", present: data?.dmarc?.present, blurb: t("Tells receivers what to do with mail that fails, and asks for reports.") },
  ];
  const level = f => (f === "problem" ? "#dc2626" : f === "warning" ? "#b45309" : "#475569");
  const r = reports.data;

  return (
    <div className="ap-stack">
      <div className="ap-card"><div className="ap-card-head">
        <strong>{t("Mail authentication")}</strong>
        <select className="ap-input" style={{ maxWidth: 260 }} value={active} onChange={e => setDomain(e.target.value)}>
          {choices.length === 0 && <option value="">{t("No domains on this server yet")}</option>}
          {choices.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div><div className="ap-card-body">
        {/* `data` is guarded as well as `loading`. The hook starts with whatever
            `enabled` was on the first render, so the frame where the domain
            list has just arrived and the effect has not run yet has neither a
            loading flag nor any data, and reading through it crashed the
            screen. */}
        {!active ? <p>{t("Add a domain to this server and its mail authentication will be checked here.")}</p> : check.error ? <p style={{ color: "#dc2626" }}>{check.error}</p> : (check.loading || !data) ? <p>{t("Reading what the internet says about {active}…", { active: active })}</p> : <>
          <p style={{ fontWeight: 600, marginTop: 0 }}>{data.summary}</p>
          {/* This screen reads the public resolver, which is what receiving
              servers see. A record can sit in a zone this machine holds and
              still be invisible, because the domain's name servers point
              somewhere else, and that difference is the whole problem. */}
          <p style={{ fontSize: 11.5, color: "rgba(var(--os-ink),.55)", marginTop: -4, marginBottom: 12 }}>{t("Read the way a receiving server reads it, by asking the internet rather than by looking at this machine's own files.")}</p>
          {(() => {
            // The warning that saves the support ticket. We hold the zone, the
            // records are in it, and the domain sends everybody somewhere else.
            const held = (zones.data?.zones || []).some(z => z.zone === active);
            const ns = data.nameservers || [];
            const oursByName = ns.some(n => n.endsWith(`.${active}`) || n === active);
            if (!held) return null;
            if (ns.length && oursByName) return null;
            return (
              <div style={{ border: "1px solid #b45309", background: "rgba(180,83,9,.06)", padding: "10px 12px", marginBottom: 14, fontSize: 12.5, lineHeight: 1.6 }}>
                <strong>{t("These records are on this server and nobody can see them.")}</strong>
                <div style={{ marginTop: 4 }}>{t("This server holds a zone for {active} and the records are in it, but {activevalue} tells the internet to ask {count} instead, so no receiving server ever reads what is written here. For any of this to work, {activevaluevalue} has to use this server for its DNS. Change its name servers where the domain is registered, then check again.", { active: active, activevalue: active, count: ns.length ? ns.join(" and ") : t("somewhere else"), activevaluevalue: active })}</div>
              </div>
            );
          })()}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginBottom: 14 }}>
            {parts.map(part => (
              <div key={part.key} style={{ border: "1px solid rgba(var(--os-ink),.12)", padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: part.present ? "#16a34a" : "#dc2626", flexShrink: 0 }} />
                  <strong style={{ fontSize: 13 }}>{part.label}</strong>
                  <span style={{ fontSize: 11, color: part.present ? "#16a34a" : "#dc2626" }}>{part.present ? t("published") : t("not published")}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "rgba(var(--os-ink),.6)", marginTop: 6, lineHeight: 1.5 }}>{part.blurb}</div>
              </div>
            ))}
          </div>

          {/* The written half. Every one of these is a failure that is silent
              otherwise, so each says what is wrong and what it costs. */}
          {(data.findings || []).length > 0 && (
            <div style={{ borderTop: "1px solid rgba(var(--os-ink),.1)", paddingTop: 10 }}>
              {data.findings.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 8, padding: "6px 0", fontSize: 12.5, lineHeight: 1.55 }}>
                  <span style={{ color: level(f.level), fontWeight: 700, textTransform: "uppercase", fontSize: 10, letterSpacing: ".06em", flexShrink: 0, width: 62, paddingTop: 2 }}>{f.level}</span>
                  <span>{f.sentence}{f.detail ? <em style={{ display: "block", color: "rgba(var(--os-ink),.5)", fontStyle: "normal", fontSize: 11.5, marginTop: 2 }}>{f.detail}</em> : null}</span>
                </div>
              ))}
            </div>
          )}

          {ops.can("mailauth.setup") && (
            <div className="ap-actions" style={{ marginTop: 12 }}>
              <button className="ap-btn primary" disabled={!!ops.busy} onClick={() => ops.propose("mailauth.setup", { domain: active, policy: "none" })}>{t("Set all three up for {active}", { active: active })}</button>
              <small style={{ marginLeft: 10, color: "rgba(var(--os-ink),.55)" }}>{t("Generates the signing key, points this server's mail at it and publishes the records.")}</small>
            </div>
          )}
        </>}
      </div></div>

      <div className="ap-card"><div className="ap-card-head"><strong>{t("Who is sending as {count}", { count: active || t("this domain") })}</strong></div><div className="ap-card-body">
        {!ops.can("dmarc.reports.read") ? <ServerGate reason={ops.why("dmarc.reports.read")}/> : reports.loading ? <p>{t("Reading the reports…")}</p> : reports.error ? <p style={{ color: "#dc2626" }}>{reports.error}</p> : !r ? null : <>
          <p style={{ fontWeight: 600, marginTop: 0 }}>{r.summary}</p>
          {r.mailbox && !r.mailbox_exists && <p style={{ fontSize: 12.5, color: "#b45309" }}>{r.note}</p>}

          {r.total > 0 && (
            <>
              {/* One bar, because the single number worth seeing is how much of
                  the mail claiming to be you is believed. */}
              <div style={{ height: 8, background: "rgba(var(--os-ink),.08)", overflow: "hidden", margin: "10px 0 4px" }}>
                <div style={{ width: `${r.pass_rate}%`, height: "100%", background: r.pass_rate === 100 ? "#16a34a" : r.pass_rate >= 90 ? "#b45309" : "#dc2626" }} />
              </div>
              <div style={{ display: "flex", fontSize: 11, color: "rgba(var(--os-ink),.6)", marginBottom: 14 }}>
                <span>{t("{passed} passed", { passed: r.passed })}</span>
                <span style={{ marginLeft: "auto" }}>{t("{failing} failed{count}{countvalue}", { failing: r.failing, count: r.quarantined ? t(", {quarantined} sent to spam", { quarantined: r.quarantined }) : "", countvalue: r.rejected ? t(", {rejected} thrown away", { rejected: r.rejected }) : "" })}</span>
              </div>

              <table className="ap-table"><thead><tr><th>{t("Sender")}</th><th>{t("Messages")}</th><th>{t("Passed")}</th><th>{t("What it means")}</th></tr></thead><tbody>
                {r.sources.map(source => (
                  <tr key={source.source_ip}>
                    <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{source.source_ip}</td>
                    <td>{source.count}</td>
                    <td style={{ color: source.pass_rate === 100 ? "#16a34a" : "#dc2626", fontWeight: 600 }}>{source.pass_rate}%</td>
                    <td style={{ fontSize: 12, lineHeight: 1.5 }}>{source.sentence}</td>
                  </tr>
                ))}
              </tbody></table>
            </>
          )}

          {(r.advice || []).map((line, i) => (
            <p key={i} style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 6 }}>{line}</p>
          ))}
          {r.reports_read > 0 && <small style={{ color: "rgba(var(--os-ink),.5)" }}>{(r.reports_read > 1 ? t("Read from {reportsread} reports in {mailbox}, sent by {countvalue}.", { reportsread: r.reports_read, mailbox: r.mailbox, countvalue: (r.reporters || []).join(", ") }) : t("Read from {reportsread} report in {mailbox}, sent by {countvalue}.", { reportsread: r.reports_read, mailbox: r.mailbox, countvalue: (r.reporters || []).join(", ") }))}</small>}
        </>}
      </div></div>
    </div>
  );
}

// Every section the panel draws, and the list the shells are checked against.
// It was short by five. `backuphealth`, `backups`, `sitefiles`, `reseller` and
// `twofactor` are all reachable from the panel's own navigation and none of
// them were named here, so a tool pointing at any of them would have been
// called dead by a test while working perfectly, and the render test that walks
// this list would have said it covered the panel while skipping five screens.
// The shell test now reads the sections the panel really draws and refuses any
// that this list does not name.
export const PANEL_SECTIONS = [
  "overview", "services", "logs", "databases", "mailadmin", "mailauth", "serversites", "filesadmin",
  "dnszone", "sitefiles", "integrations", "backupdestinations", "backuphealth", "backups", "security", "migration", "console", "sites", "jobs", "portability", "statistics", "usage",
  "license", "activity", "reseller", "twofactor", "connectai", "echo", "files", "mail", "settings",
  // Drawn only for the account that runs the box. The server refuses it to
  // anybody else regardless, so this decides what is shown, never what is
  // allowed.
  "admin",
];

// Moving in from another server. The half that is finished is the one most
// people actually need: they cannot get an archive out of the place they are
// leaving, they have a mailbox and a password, and that is enough.
//
// The order on the screen is the order of the fear. Look at the old server
// first and see the folders and the counts, because nobody hands their mail to
// a panel that has not proved it can read it. Then copy, into a mailbox that
// already exists here. Nothing on this screen changes DNS, and it says so twice,
// because "will my mail stop arriving" is the question that stops people moving.
function ServerMigration({ ops }) {
  const [source, setSource] = useState({ host:"", port:"", security:"tls", username:"", password:"", allowUntrusted:false });
  const [looked, setLooked] = useState(null);
  const [looking, setLooking] = useState(false);
  const [problem, setProblem] = useState(null);
  const [target, setTarget] = useState("");
  const [mirror, setMirror] = useState(false);
  const [plan, setPlan] = useState(null);
  const [preview, setPreview] = useState(null);
  const [archiveName, setArchiveName] = useState("");
  const [archiveProblem, setArchiveProblem] = useState(null);
  const [reading, setReading] = useState(false);
  const mailboxes = useServerRead(ops.api, "mailboxes", "", ops.can("mail.mailbox.list"));

  // Two calls on purpose. The first reads the archive, which needs no server
  // capability at all and is pure parsing. The second asks this machine what it
  // would do with the result, which is the part that knows whether there is a
  // database server here to put a database in.
  const readArchive = async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setReading(true); setArchiveProblem(null); setPlan(null); setPreview(null);
    try {
      const form = new FormData();
      form.append("archive", file);
      const read = await ops.api("/api/panel/server/migration/archive", { method:"POST", body:form });
      setPlan(read.plan); setArchiveName(read.archive || file.name);
      try {
        setPreview(await ops.api("/api/panel/server/read/migrate-preview", { method:"POST", body:JSON.stringify({ plan:read.plan }) }));
      } catch (error) {
        // The archive was read even if this machine could not be asked what it
        // would do with it, and saying so beats throwing the plan away.
        ops.notify(t("The archive was read, but this server could not be asked what it would build: {message}", { message: error.message }), true);
      }
    } catch (error) { setArchiveProblem(error.message); }
    finally { setReading(false); }
  };

  const field = (key, value) => setSource(v => ({ ...v, [key]: value }));
  const ready = source.host.trim() && source.username.trim() && source.password;

  const look = async () => {
    setLooking(true); setProblem(null); setLooked(null);
    try {
      // A POST, not a query string. This carries somebody's live mail password
      // and a URL is written into an access log on the way past.
      setLooked(await ops.api("/api/panel/server/read/migrate-imap-inspect", {
        method:"POST",
        body: JSON.stringify({ ...source, host: source.host.trim(), username: source.username.trim(), port: source.port || null }),
      }));
    } catch (error) { setProblem(error.message); }
    finally { setLooking(false); }
  };

  const copy = () => {
    const at = target.lastIndexOf("@");
    if (at < 1) return;
    ops.propose(mirror ? "migrate.imap.replace" : "migrate.imap.pull", {
      ...source, host: source.host.trim(), username: source.username.trim(), port: source.port || null,
      account: target.slice(0, at), domain: target.slice(at + 1),
    });
  };

  if (!ops.can("migrate.imap.inspect")) {
    return <>
      <div className="ap-section-head"><div><h2>{t("Move in from another server")}</h2></div></div>
      <ServerGate reason={ops.why("migrate.imap.inspect")}/>
    </>;
  }

  return <>
    <div className="ap-section-head"><div><h2>{t("Move in from another server")}</h2><p>{t("Read the account you are leaving, see exactly what is in it, and build it here without switching anything over.")}</p></div></div>
    <div className="ap-callout"><PanelIcon name="shield" size={20}/><div><strong>{t("Nothing is cut over by anything on this screen")}</strong><p>{t("Mail keeps arriving at the old server, and websites keep being served by it, until you change the DNS record yourself. Everything here builds alongside.")}</p></div></div>

    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("An account archive")}</strong><PanelBadge tone="info">{t("cPanel · coming soon")}</PanelBadge></div>
      <div className="ap-card-body">
        <div className="ap-callout warn" style={{margin:"0 0 12px"}}><PanelIcon name="alert" size={16}/><div><strong>{t("Not proved against a real cPanel archive yet")}</strong><p>{t("The reader works and every step after it has run on this machine, but the only archives it has been given were built to the same layout it expects, which proves it agrees with itself. Treat a real cpmove as an experiment until this notice goes.")}</p></div></div>
        <p style={{fontSize:11.5,color:"#5d6a79",lineHeight:1.55,margin:"0 0 13px"}}>{t("A cpmove or backup archive is read here and nothing is kept: it is parsed and the upload is removed before the answer comes back. Reading it changes nothing on this server. Plesk and DirectAdmin archives are not read at all.")}</p>
        <label className="ap-btn primary" style={{cursor:reading?"default":"pointer"}}>
          <PanelIcon name="upload" size={14}/>{reading?t("Reading the archive…"):t("Choose an archive to read")}
          <input type="file" accept=".zip,.tar,.gz,.tgz" hidden disabled={reading} onChange={readArchive}/>
        </label>
        {archiveProblem && <div className="ap-callout bad" style={{margin:"11px 0 0"}}><PanelIcon name="alert" size={16}/><div><strong>{t("That archive could not be read")}</strong><p>{archiveProblem}</p></div></div>}
      </div>
    </div>

    {plan && <div className="ap-card" style={{marginBottom:12}}>
      {/* A span rather than a badge: the badge style capitalises, and an
          account name is somebody's login, not a label. */}
      <div className="ap-card-head"><strong>{t("What is in {archivename}", { archivename: archiveName })}</strong><span className="ap-mono">{plan.account||t("account")}</span></div>
      <div className="ap-grid-4">
        <div className="ap-metric"><div className="ap-metric-top">{t("Websites")}</div><div className="ap-metric-value">{preview?preview.will_create.sites:plan.domains.length}</div><div className="ap-metric-note">{t("{count} in the archive", { count: plan.domains.length })}</div></div>
        <div className="ap-metric"><div className="ap-metric-top">{t("Databases")}</div><div className="ap-metric-value">{plan.databases.length}</div><div className="ap-metric-note">{t("created empty, dumps imported after")}</div></div>
        <div className="ap-metric"><div className="ap-metric-top">{t("Mailboxes")}</div><div className="ap-metric-value">{plan.mailboxes.length}</div><div className="ap-metric-note">{t("{count} forwarder(s) as well", { count: plan.forwarders.length })}</div></div>
        <div className="ap-metric"><div className="ap-metric-top">{t("Files")}</div><div className="ap-metric-value">{plan.files.length.toLocaleString()}</div><div className="ap-metric-note">{t("{count} month(s) of statistics", { count: plan.statistics.length })}</div></div>
      </div>
      <div className="ap-card-body">
        {/* Everything the machine will refuse, said before it is asked rather
            than discovered a third of the way through. */}
        {/* Three different kinds of thing, and they were all drawn the same
            grey box, which turned the honest part of this screen into a wall
            nobody reads. What this machine will refuse is the only one that
            stops a migration, so it is the only one that stays a callout. */}
        {(preview?.blocked||[]).map((entry, i) => <div className="ap-callout warn" style={{margin:"0 0 9px"}} key={`b${i}`}><PanelIcon name="alert" size={16}/><div><strong>{entry.what}</strong><p>{entry.why}</p></div></div>)}
        {(plan.warnings||[]).length>0 && <>
          <div className="ap-list-title" style={{marginTop:4}}>{t("Worth knowing before you build")}</div>
          <div className="ap-table-wrap" style={{marginBottom:12}}><table className="ap-table"><tbody>{plan.warnings.map((warning, i) => <tr key={`w${i}`}><td style={{whiteSpace:"normal"}}>{warning}</td></tr>)}</tbody></table></div>
        </>}
        {(plan.unsupported||[]).length>0 && <>
          <div className="ap-list-title">{t("Not carried by this pass")}</div>
          <div className="ap-table-wrap"><table className="ap-table"><tbody>{plan.unsupported.map((entry, i) => <tr key={`u${i}`}><td style={{whiteSpace:"normal"}}>{entry}</td></tr>)}</tbody></table></div>
        </>}
        <div className="ap-actions" style={{marginTop:13}}>
          <button className="ap-btn primary" disabled={!!ops.busy||!ops.can("migrate.apply")||!(plan.domains.length||plan.mailboxes.length||plan.databases.length)} onClick={()=>ops.propose("migrate.apply",{plan})}>{t("Propose building this here")}</button>
          <button className="ap-btn" onClick={()=>{ setPlan(null); setPreview(null); setArchiveName(""); }}>{t("Discard")}</button>
        </div>
        {!ops.can("migrate.apply") && <div style={{marginTop:11}}><ServerGate reason={ops.why("migrate.apply")}/></div>}
      </div>
    </div>}

    <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("A mailbox, when there is no archive")}</strong><span>{t("read only")}</span></div>
      <div className="ap-card-body">
        <div className="ap-form">
          <div className="ap-field"><label>{t("Mail server")}</label><input className="ap-input ap-mono" value={source.host} onChange={e=>field("host", e.target.value)} placeholder="mail.oldhost.example"/></div>
          <div className="ap-field"><label>{t("Encryption")}</label><select className="ap-input" value={source.security} onChange={e=>{ field("security", e.target.value); field("port", ""); }}>
            <option value="tls">{t("IMAPS on 993")}</option><option value="starttls">{t("STARTTLS on 143")}</option><option value="plain">{t("No encryption")}</option>
          </select></div>
          <div className="ap-field"><label>{t("Port")}</label><input className="ap-input ap-mono" value={source.port} onChange={e=>field("port", e.target.value)} placeholder={source.security==="tls"?"993":"143"}/></div>
          <div className="ap-field"><label>{t("Login")}</label><input className="ap-input ap-mono" value={source.username} onChange={e=>field("username", e.target.value)} placeholder="sales@example.com" autoComplete="off"/></div>
          <div className="ap-field"><label>{t("Password")}</label><input className="ap-input" type="password" value={source.password} onChange={e=>field("password", e.target.value)} autoComplete="new-password"/></div>
        </div>
        <label className="ap-check" style={{marginTop:11}}><input type="checkbox" checked={source.allowUntrusted} onChange={e=>field("allowUntrusted", e.target.checked)}/><span>{t("Accept a certificate this server signed itself. Older mail servers often have one, and the mail is still encrypted; what is not proved is that the far end is who it says it is.")}</span></label>
        {source.security==="plain" && <div className="ap-callout warn" style={{margin:"11px 0 0"}}><PanelIcon name="alert" size={16}/><div><p>{t("With no encryption the password and every message cross the internet in the clear. Use this only across a private network.")}</p></div></div>}
        <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn primary" disabled={looking||!ready} onClick={look}>{looking?t("Reading the mailbox…"):t("Look at this mailbox")}</button></div>
        {problem && <div className="ap-callout bad" style={{margin:"11px 0 0"}}><PanelIcon name="alert" size={16}/><div><strong>{t("That mailbox could not be read")}</strong><p>{problem}</p></div></div>}
      </div>
    </div>

    {looked && <div className="ap-card" style={{marginBottom:12}}>
      <div className="ap-card-head"><strong>{t("What is in that mailbox")}</strong><PanelBadge tone={looked.certificate_verified?"ok":"warn"}>{looked.certificate_verified?t("certificate verified"):t("certificate not verified")}</PanelBadge></div>
      <div className="ap-grid-4">
        <div className="ap-metric"><div className="ap-metric-top">{t("Folders")}</div><div className="ap-metric-value">{looked.folder_count}</div><div className="ap-metric-note">{t("as the server lists them")}</div></div>
        <div className="ap-metric"><div className="ap-metric-top">{t("Messages")}</div><div className="ap-metric-value">{(looked.message_count||0).toLocaleString()}</div><div className="ap-metric-note">{t("counted by the server itself")}</div></div>
        <div className="ap-metric"><div className="ap-metric-top">{t("Size")}</div><div className="ap-metric-value">{looked.bytes==null?t("not reported"):panelFormatBytes(looked.bytes)}</div><div className="ap-metric-note">{looked.bytes==null?t("this server predates the size extension"):t("total across every folder")}</div></div>
        <div className="ap-metric"><div className="ap-metric-top">{t("Unreadable")}</div><div className="ap-metric-value">{(looked.unreadable||[]).length}</div><div className="ap-metric-note">{t("folders that would not answer")}</div></div>
      </div>
      <div className="ap-table-wrap ap-scroll"><table className="ap-table">
        <thead><tr><th>{t("Folder")}</th><th>{t("Messages")}</th><th>{t("Size")}</th><th>{t("Note")}</th></tr></thead>
        <tbody>{looked.folders.map((folder, i) => <tr key={`${folder.name}-${i}`}>
          <td className="ap-mono">{folder.name}</td>
          <td>{folder.messages==null?"—":folder.messages.toLocaleString()}</td>
          <td>{folder.bytes==null?"—":panelFormatBytes(folder.bytes)}</td>
          <td className="secondary">{folder.note||(folder.selectable?"":t("a container rather than a folder"))}</td>
        </tr>)}</tbody>
      </table></div>
    </div>}

    <div className="ap-card">
      {/* The copy is the write, and it is the half that has never been run
          against a real mailbox on any machine. Reading one has. The rule the
          product holds itself to is that anything which has not met the
          verification bar says so where somebody would rely on it, so the
          disclosure sits on the card that writes rather than in a document. */}
      <div className="ap-card-head"><strong>{t("Copy it into a mailbox here")}</strong><PanelBadge tone="info">{t("preview")}</PanelBadge><span>{mirror?t("mirror"):t("one way")}</span></div>
      <div className="ap-card-body">
        {!ops.can("migrate.imap.pull") ? <ServerGate reason={ops.why("migrate.imap.pull")}/> : <>
          <div className="ap-callout warn" style={{margin:"0 0 12px"}}><PanelIcon name="alert" size={16}/><div><strong>{t("The copy has not been proved against a real mailbox yet")}</strong><p>{t("Reading a mailbox has been. Writing into one has been built and unit tested and never run against a live mail server, so treat the first copy as an experiment: try one mailbox that does not matter, and leave the old server receiving until you have read the result.")}</p></div></div>
          <p style={{fontSize:11.5,color:"#5d6a79",lineHeight:1.55,margin:"0 0 13px"}}>{t("The mailbox has to exist on this server first, because a copy fills a mailbox rather than creating one. Create it under Mailboxes, then copy into it. Nothing is written back to {count}.", { count: source.host.trim()||t("the other server") })}</p>
          <div className="ap-form">
            <div className="ap-field"><label>{t("Mailbox on this server")}</label>
              {mailboxes.data?.mailboxes?.length
                ? <select className="ap-input" value={target} onChange={e=>setTarget(e.target.value)}><option value="">{t("Choose a mailbox")}</option>{mailboxes.data.mailboxes.map(box => <option key={box.address} value={box.address}>{box.address}</option>)}</select>
                : <input className="ap-input ap-mono" value={target} onChange={e=>setTarget(e.target.value)} placeholder="sales@example.com"/>}
            </div>
          </div>
          <label className="ap-check" style={{marginTop:11}}><input type="checkbox" checked={mirror} onChange={e=>setMirror(e.target.checked)}/><span>{t("Mirror instead of copy. Anything in the mailbox here that is not on the other server is removed, so the two match exactly. This is the one to use for a second pass at cutover, and it asks you to type REPLACE.")}</span></label>
          <div className="ap-actions" style={{marginTop:12}}>
            <button className={`ap-btn ${mirror?"danger":"primary"}`} disabled={!!ops.busy||!ready||!target.includes("@")} onClick={copy}>{mirror?t("Propose the mirror"):t("Propose the copy")}</button>
          </div>
          <div className="ap-callout" style={{margin:"12px 0 0"}}><PanelIcon name="shield" size={18}/><div><p>{t("A copy that runs out of time has not lost anything. It carries on from where it stopped the next time it runs, because it transfers only what is not already here.")}</p></div></div>
        </>}
      </div>
    </div>

  </>;
}

function ServerConsole({ ops }) {
  const [command, setCommand] = useState("");
  if (!ops.can("console.run")) return <><div className="ap-section-head"><div><h2>{t("Command console")}</h2></div></div><ServerGate reason={ops.why("console.run")} title={t("The console is switched off")}/></>;
  return <>
    <div className="ap-section-head"><div><h2>{t("Command console")}</h2><p>{t("One command at a time. This is not an interactive shell and it never will be by accident.")}</p></div></div>
    <div className="ap-callout warn"><PanelIcon name="alert" size={19}/><div><strong>{t("Every command is proposed, typed-confirmed and recorded")}</strong><p>{t("It runs as the panel service owner, in a fixed folder, with a sixty second limit. Nothing it does can be undone from here.")}</p></div></div>
    <div className="ap-card"><div className="ap-card-body">
      <div className="ap-field"><label>{t("Command")}</label><input className="ap-input ap-mono" value={command} onChange={e=>setCommand(e.target.value)} placeholder={"nginx -t"}/></div>
      <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn danger" disabled={!!ops.busy||!command.trim()} onClick={()=>ops.propose("console.run",{command:command.trim()})}>{t("Propose this command")}</button></div>
    </div></div>
  </>;
}

// Sign-in security. A control panel login is the whole machine by another
// route, so the second factor lives beside the account rather than buried in a
// settings tab nobody opens.
//
// The QR image is drawn by this server from the same otpauth URI it just
// generated. No third-party chart service, because handing somebody else's
// server the secret it is a picture of would be giving away the second factor
// while setting it up.
// ── Passkeys ──────────────────────────────────────────────────────
//
// The browser half of WebAuthn, through `navigator.credentials` and nothing
// else: no library, which is what keeps the frontend's no-dependencies rule
// intact while the backend uses a real one for the cryptography.
//
// The awkward part is the wire format. WebAuthn hands back ArrayBuffers and the
// server needs base64url strings, and the conversion has to be exact in both
// directions or every ceremony fails with an error that says nothing useful.
const b64urlToBytes = value => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
};
const bytesToB64url = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// What the browser gives back, in the shape the server's verifier expects.
const registrationToJSON = credential => ({
  id: credential.id,
  rawId: bytesToB64url(credential.rawId),
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults(),
  response: {
    clientDataJSON: bytesToB64url(credential.response.clientDataJSON),
    attestationObject: bytesToB64url(credential.response.attestationObject),
    transports: credential.response.getTransports ? credential.response.getTransports() : [],
  },
});

const assertionToJSON = credential => ({
  id: credential.id,
  rawId: bytesToB64url(credential.rawId),
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults(),
  response: {
    clientDataJSON: bytesToB64url(credential.response.clientDataJSON),
    authenticatorData: bytesToB64url(credential.response.authenticatorData),
    signature: bytesToB64url(credential.response.signature),
    userHandle: credential.response.userHandle ? bytesToB64url(credential.response.userHandle) : null,
  },
});

export function PasskeySection({ api }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");

  const load = useCallback(() => api("/api/passkeys").then(setState).catch(e => setError(e.message)), [api]);
  useEffect(() => { load(); }, [load]);

  const supported = typeof window !== "undefined" && !!window.PublicKeyCredential;

  const add = async () => {
    setBusy("add"); setError(""); setNote("");
    try {
      const options = await api("/api/passkeys/register/options", { method: "POST" });
      const created = await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: b64urlToBytes(options.challenge),
          user: { ...options.user, id: b64urlToBytes(options.user.id) },
          excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: b64urlToBytes(c.id) })),
        },
      });
      if (!created) throw new Error(t("The browser did not return a passkey."));
      await api("/api/passkeys/register/verify", {
        method: "POST",
        body: JSON.stringify({ response: registrationToJSON(created), name: name.trim() }),
      });
      setName("");
      setNote(t("Passkey added. It can sign you in from now on."));
      load();
    } catch (e) {
      // A person who changes their mind at the browser prompt is not an error
      // worth showing in red.
      setError(e.name === "NotAllowedError" ? t("That was cancelled, or the device timed out.") : e.message);
    } finally { setBusy(""); }
  };

  const remove = async (credential) => {
    setBusy(credential.id); setError(""); setNote("");
    try {
      await api(`/api/passkeys/${credential.id}`, { method: "DELETE" });
      setNote(t("Removed {name}.", { name: credential.name }));
      load();
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };

  if (!state) return <><div className="ap-section-head"><div><h2>{t("Passkeys")}</h2></div></div>
    <div className="ap-card"><div className="ap-card-body">{error || t("Reading this account…")}</div></div></>;

  const only = state.credentials.length === 1 && !state.has_password;

  return <>
    <div className="ap-section-head">
      <div>
        <h2>{t("Passkeys")}</h2>
        <p>{t("Sign in with the fingerprint reader, face or screen lock on a device you already have, or with a security key.")}</p>
      </div>
      <PanelBadge tone={state.credentials.length ? "ok" : "warn"}>
        {state.credentials.length ? t("{count} registered", { count: state.credentials.length }) : t("none yet")}
      </PanelBadge>
    </div>

    {!state.available && <div className="ap-callout warn">
      <PanelIcon name="alert" size={18}/>
      <div>
        <strong>{t("Not available on this server yet")}</strong>
        <p>{state.unavailable_reason}</p>
      </div>
    </div>}

    {state.available && !supported && <div className="ap-callout warn">
      <PanelIcon name="alert" size={18}/>
      <div><strong>{t("This browser cannot make passkeys")}</strong><p>{t("Try a current version of Safari, Chrome, Edge or Firefox.")}</p></div>
    </div>}

    {!!state.credentials.length && <div className="ap-card">
      <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Name")}</th><th>{t("Added")}</th><th>{t("Last used")}</th><th></th></tr></thead>
        <tbody>{state.credentials.map(c => <tr key={c.id}>
          <td>{c.name}{c.backed_up && <span className="secondary">{t(" · synced")}</span>}</td>
          <td>{panelDate(c.created_at)}</td>
          <td>{c.last_used_at ? panelDate(c.last_used_at, true) : <span className="secondary">{t("never")}</span>}</td>
          <td style={{textAlign:"right"}}>
            <button className="ap-btn danger small" disabled={busy === c.id || only}
              title={only ? t("This is the only way into this account") : ""}
              onClick={() => remove(c)}>{t("Remove")}</button>
          </td>
        </tr>)}</tbody>
      </table></div>
      {only && <div className="ap-card-body secondary">{t("This is the only way into this account, so it cannot be removed. Add a second passkey first.")}</div>}
    </div>}

    {state.available && supported && <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Add a passkey")}</strong><span>{t("this device, or a security key")}</span></div>
      <div className="ap-card-body">
        <div className="ap-field">
          <label>{t("What is it, so you recognise it later")}</label>
          <input className="ap-input" value={name} onChange={e => setName(e.target.value)} placeholder={t("Work laptop")}/>
        </div>
        <button className="ap-btn primary" style={{marginTop:12}} disabled={busy === "add"} onClick={add}>
          <PanelIcon name="shield" size={14}/>{busy === "add" ? t("Waiting for the device…") : t("Add a passkey")}
        </button>
        <p className="secondary" style={{marginTop:10}}>{t("A security key on a keyring works here too. It is the same standard and there is nothing extra to set up.")}</p>
      </div>
    </div>}

    {error && <div className="ap-callout bad" role="alert"><PanelIcon name="alert" size={18}/><div>{error}</div></div>}
    {note && <div className="ap-callout good" role="status"><PanelIcon name="check" size={18}/><div>{note}</div></div>}
  </>;
}

// ── Account recovery codes ────────────────────────────────────────
//
// Distinct from the two-factor codes below, and the screen says so, because a
// person holding both sets needs to know which one is the last way in. These
// are shown exactly once: what the server keeps is a hash, so a screen offering
// to show them again would be lying.
export function RecoveryCodesSection({ api }) {
  const [state, setState] = useState(null);
  const [codes, setCodes] = useState(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => api("/api/recovery-codes").then(setState).catch(e => setError(e.message)), [api]);
  useEffect(() => { load(); }, [load]);

  const generate = async () => {
    setBusy(true); setError("");
    try {
      const out = await api("/api/recovery-codes", { method: "POST", body: JSON.stringify({ password }) });
      setCodes(out.deliver_once.codes);
      setPassword("");
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const asText = () => (codes || []).map((c, i) => `${String(i + 1).padStart(2, " ")}. ${c}`).join("\n");
  const copy = () => { navigator.clipboard.writeText(asText()); };
  const download = () => {
    const blob = new Blob([t("JotPanel recovery codes {host} {count} Each code works once. Keep these somewhere that is not this machine.", { host: window.location.host, count: asText() })], { type: "text/plain" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href; link.download = "jotpanel-recovery-codes.txt"; link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  if (!state) return null;

  return <>
    <div className="ap-section-head">
      <div>
        <h2>{t("Account recovery codes")}</h2>
        <p>{t("The way back in if you lose every passkey and every device. Not the same as the two-factor codes below: those recover your phone, these recover your account.")}</p>
      </div>
      <PanelBadge tone={state.codes_left > 2 ? "ok" : state.generated ? "warn" : "warn"}>
        {state.generated ? t("{codesleft} unused", { codesleft: state.codes_left }) : t("none yet")}
      </PanelBadge>
    </div>

    {codes && <div className="ap-card" style={{borderColor:"#c8922a"}}>
      <div className="ap-card-head"><strong>{t("Written down now or not at all")}</strong><PanelBadge tone="warn">{t("shown once")}</PanelBadge></div>
      <div className="ap-card-body">
        <p style={{fontSize:11.5,color:"#5d6a79",lineHeight:1.55,margin:"0 0 12px"}}>{t("These are in no record and nothing can show them again. Each one works once. Keep them somewhere that is not this machine and not the device you sign in with.")}</p>
        <div className="ap-mono" style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:8,padding:"12px",background:"#f7f9fb",border:"1px solid #cbd4dd"}}>
          {codes.map((code, i) => <div key={code}><span style={{color:"#8a96a3"}}>{String(i + 1).padStart(2, "0")}</span> {code}</div>)}
        </div>
        <div className="ap-actions" style={{marginTop:12}}>
          <button className="ap-btn small" onClick={copy}>{t("Copy")}</button>
          <button className="ap-btn small" onClick={download}>{t("Download")}</button>
          <button className="ap-btn small" onClick={() => window.print()}>{t("Print")}</button>
          <button className="ap-btn small" onClick={() => setCodes(null)}>{t("I have saved them")}</button>
        </div>
      </div>
    </div>}

    {!codes && <div className="ap-card">
      <div className="ap-card-body">
        {state.generated
          ? <p style={{fontSize:12,color:"#5d6a79",margin:"0 0 12px"}}>{t("You have {codesleft} unused codes, generated {count}. Generating a new set immediately cancels every code in the old one, used or not.", { codesleft: state.codes_left, count: panelDate(state.generated_at) })}</p>
          : <p style={{fontSize:12,color:"#5d6a79",margin:"0 0 12px"}}>{t("You have none. Without them, losing every passkey means asking your hosting provider to approve a recovery, and they cannot do that unless you can prove who you are.")}</p>}
        <div className="ap-field">
          <label>{t("Confirm your password")}</label>
          <input className="ap-input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/>
        </div>
        <button className="ap-btn primary" style={{marginTop:12}} disabled={busy || !password} onClick={generate}>
          {busy ? t("Generating…") : state.generated ? t("Replace my recovery codes") : t("Generate recovery codes")}
        </button>
      </div>
    </div>}

    {error && <div className="ap-callout bad" role="alert"><PanelIcon name="alert" size={18}/><div>{error}</div></div>}
  </>;
}

// Ask Echo: the conversation door into the same approval desk the screens and
// MCP use. Echo answers with the person's own AI key, kept on this server. A
// request for a change comes back as a proposal, which waits in Activity like
// any other; nothing here runs anything.
function AskEchoSection({ goTo, onProposal, ops }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  // "idle" | "recording" | "transcribing". The recording handle is held so the
  // second press stops the take the first one started.
  const [rec, setRec] = useState("idle");
  const recRef = useRef(null);
  // The browser must be able to record and this box must have the speech
  // service installed; either one missing means no microphone is offered.
  const [serverHears, setServerHears] = useState(false);
  useEffect(() => { let live = true; serverCanListen().then(v => { if (live) setServerHears(v); }); return () => { live = false; }; }, []);
  const canTalk = voiceInputSupported() && serverHears;
  // Leaving the screen mid-recording must not leave the microphone live.
  useEffect(() => () => recRef.current?.stop(), []);
  const talk = async () => {
    if (rec === "transcribing") return;
    if (rec === "recording") { recRef.current?.stop(); return; }
    setProblem(null);
    let session;
    try { session = startRecording(); }
    catch { setProblem({ kind:"other", msg:t("This browser would not start the microphone.") }); return; }
    recRef.current = session;
    setRec("recording");
    try {
      const heard = await session.done;
      setRec("transcribing");
      // The words land in the box rather than sending themselves: a domain or a
      // mailbox misheard is worth one glance before Echo acts on it.
      if (heard) setInput(v => (v.trim() ? v.trim() + " " : "") + heard);
    } catch (error) {
      const msg = String(error?.message || "");
      setProblem({ kind:"other", msg: /denied|not allowed|NotAllowed/i.test(msg)
        ? t("The browser did not give this page the microphone.")
        : msg || t("Echo listening is not available") });
    } finally { recRef.current = null; setRec("idle"); }
  };
  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history = [...messages, { role:"user", content:text }];
    setMessages(history); setInput(""); setBusy(true); setProblem(null);
    let proposal = null;
    try {
      const reply = await callAI(null, history.map(m => ({ role:m.role, content:m.content })), { mode:"echo", onAction: a => { proposal = a; } });
      setMessages(v => [...v, { role:"assistant", content:reply || "", proposal }]);
      if (proposal && onProposal) onProposal();
    } catch (error) {
      const msg = String(error.message || "");
      const kind = /regist/i.test(msg) ? "register" : /No AI provider|API key|key/i.test(msg) ? "key" : "other";
      setProblem({ kind, msg });
      setMessages(v => v.slice(0, -1)); setInput(text);
    } finally { setBusy(false); }
  };
  return <>
    <div className="ap-section-head"><div>
      <h2>{t("Ask Echo")}</h2>
      <p>{t("Say what you want in plain words. Echo answers with your own AI key. A change comes back as a proposal and waits for you in Activity.")}</p>
    </div></div>
    <div className="ap-card"><div className="ap-card-body">
      {!messages.length && <p style={{fontSize:12,lineHeight:1.6}}>{t("Say what you want in plain words. Echo answers with your own AI key, which stays on this server. A change comes back as a VACP™ proposal and waits for you in Activity; nothing changes until you approve it.")}<br/><span style={{color:"var(--ap-muted)"}}>{t("For example: \"create a mailbox for sales@example.com\" or \"why is my site slow?\"")}</span></p>}
      {/* Somebody meeting the panel for the first time has no idea what Echo is,
          and the word is on a menu item, a button and a proposal card before
          anything explains it. */}
      <details style={{marginTop:8,fontSize:12}}>
        <summary style={{cursor:"pointer",color:"var(--ap-muted)"}}>{t("What is Echo?")}</summary>
        <div style={{marginTop:6,lineHeight:1.6}}>
          <p>{t("Echo is the assistant built into this panel. You tell it what you want in ordinary words instead of finding the right screen.")}</p>
          <p style={{marginTop:6}}>{t("It cannot change anything by itself. It writes down what it thinks you asked for, you read it and approve it, the panel makes the change and then checks the server to prove it happened.")}</p>
          <p style={{marginTop:6}}>{t("It answers using an AI key you add in Settings. The key stays on this server and the panel does not send your words to us.")}</p>
          <p style={{marginTop:6}}>{t("It can also listen, if you install speech on this server. That is optional, and speech is turned into text here rather than by another company.")}</p>
        </div>
      </details>
      {messages.map((m, i) => <div key={i} style={{margin:"8px 0",display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
        <div style={{maxWidth:"80%",padding:"8px 12px",borderRadius:8,fontSize:13,lineHeight:1.5,whiteSpace:"pre-wrap",background:m.role==="user"?"rgba(74,124,247,.14)":"rgba(var(--os-ink),.05)"}}>
          {m.content}
          {m.proposal && <div className="ap-callout" style={{marginTop:8}}><div>
            <p><strong>{t("Proposed:")}</strong> {m.proposal.label}</p>
            <p>{t("Nothing has changed yet. It waits for your approval.")}</p>
            <button className="ap-btn small primary" onClick={()=>goTo("activity")}>{t("Review in Activity")}</button>
          </div></div>}
        </div>
      </div>)}
      {busy && <p style={{fontSize:12,color:OS.txt3}}>{t("Echo is thinking…")}</p>}
      {problem && <div className="ap-callout warn" style={{marginTop:8}}><div>
        {problem.kind === "register" ? <>
          <p>{t("Echo needs this panel registered. Registration is free.")}</p>
          <button className="ap-btn small" onClick={()=>goTo("license")}>{t("Register")}</button>
        </> : problem.kind === "key" ? <>
          <p>{t("Connect an AI provider in Settings. Your key stays on this server.")}</p>
          <button className="ap-btn small" onClick={()=>goTo("settings")}>{t("Open Settings")}</button>
        </> : <p>{problem.msg}</p>}
      </div></div>}
      <div style={{display:"flex",gap:8,marginTop:12}}>
        <input className="ap-input" style={{flex:1}} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{ if (e.key==="Enter") send(); }} placeholder={t("Ask Echo…")} disabled={busy}/>
        {!canTalk && serverHears === false && voiceInputSupported() && <button className="ap-btn" type="button" disabled={!!ops?.busy}
          title={t("Speech is turned into text on this server and never sent to another company.")}
          onClick={()=>{ if (ops?.propose) { ops.propose("stack.install.voice", {}); } }}>{t("Let Echo listen…")}</button>}
        {canTalk && <button className={`ap-btn${rec==="recording"?" primary":""}`} type="button" disabled={busy || rec==="transcribing"}
          title={t("Your voice is turned into text on this server. The recording is not sent anywhere else.")}
          onClick={talk}>{rec==="recording" ? t("Stop") : rec==="transcribing" ? t("Listening…") : t("Speak")}</button>}
        <button className="ap-btn primary" disabled={busy || !input.trim()} onClick={send}>{t("Send")}</button>
      </div>
    </div></div>
  </>;
}

// Connect your own AI through the MCP gateway. A key made here can read and
// propose within the areas ticked, and nothing else. Approval is never on the
// list: a person approves in Activity, which is the point of the whole panel.
// The firewall, the console, SSH keys, accounts and "everything" are left off
// too, because a key for an AI should not be able to lock the owner out.
const AI_KEY_AREAS = [
  { id:"sites", label:"Websites and files", scopes:["site.*","file.*","certificate.*","runtime.*","application.*","sftp.*"] },
  { id:"mail", label:"Email", scopes:["mail.*","mailauth.*"] },
  { id:"databases", label:"Databases", scopes:["database.*"] },
  { id:"dns", label:"DNS", scopes:["dns.*"] },
  { id:"backups", label:"Backups", scopes:["backup.*"] },
  { id:"machine", label:"Read services and logs", scopes:["service.*","log.*","process.*","system.*"] },
];
function ConnectAISection({ api }) {
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState("");
  const [areas, setAreas] = useState(["sites"]);
  const [issued, setIssued] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api("/api/keys").then(r => setKeys(r.keys || [])).catch(e => setNote(e.message)), [api]);
  useEffect(() => { load(); }, [load]);
  const create = async () => {
    setBusy(true); setNote(""); setIssued(null);
    try {
      const scopes = [...new Set(AI_KEY_AREAS.filter(a => areas.includes(a.id)).flatMap(a => a.scopes))];
      const out = await api("/api/keys", { method:"POST", body:JSON.stringify({ name:name.trim() || "My AI", capabilities:scopes }) });
      setIssued(out.deliver_once?.token || null); setName(""); await load();
    } catch (e) { setNote(e.message); } finally { setBusy(false); }
  };
  const revoke = async key => {
    setBusy(true); setNote("");
    try { await api(`/api/keys/${key.id}`, { method:"DELETE" }); setNote(t("Revoked. That key stops working now.")); await load(); }
    catch (e) { setNote(e.message); } finally { setBusy(false); }
  };
  const live = (keys || []).filter(k => !k.revokedAt);
  const origin = typeof window !== "undefined" ? window.location.origin : "https://panel.example.com";
  return <>
    <div className="ap-section-head"><div>
      <h2>{t("Connect your AI")}</h2>
      <p>{t("Already using Claude Code, Cursor or Codex? Give it a key and it can read this server and ask for changes. VACP™ holds every change for you in Activity: your AI can ask, only you approve.")}</p>
    </div></div>
    <div className="ap-grid-even">
      <div className="ap-card"><div className="ap-card-head"><strong>{t("New key")}</strong></div><div className="ap-card-body">
        <p style={{fontSize:12,lineHeight:1.6,marginBottom:10}}>{t("Already using Claude Code, Cursor or Codex? Give it a key and it can read this server and ask for changes. VACP™ holds every change for you in Activity: your AI can ask, only you approve.")}</p>
        <div className="ap-form">
          <div className="ap-field"><label>{t("Name")}</label><input className="ap-input" value={name} onChange={e=>setName(e.target.value)} placeholder={t("Claude on my laptop")}/></div>
          <div className="ap-field"><label>{t("What it may read and ask for")}</label>
            {AI_KEY_AREAS.map(a => <label key={a.id} style={{display:"flex",gap:8,alignItems:"center",fontSize:12,margin:"4px 0"}}>
              <input type="checkbox" checked={areas.includes(a.id)} onChange={e=>setAreas(v => e.target.checked ? [...v, a.id] : v.filter(x => x !== a.id))}/>{t(a.label)}
            </label>)}
          </div>
        </div>
        <div className="ap-actions" style={{marginTop:10}}><button className="ap-btn primary" disabled={busy || !areas.length} onClick={create}>{t("Create key")}</button></div>
        {issued && <div className="ap-callout warn" style={{marginTop:12}}><div>
          <p><strong>{t("Copy this key now. It is shown once and this panel cannot show it again.")}</strong></p>
          <p className="ap-mono" style={{wordBreak:"break-all",userSelect:"all"}}>{issued}</p>
          <p style={{marginTop:8}}>{t("Then, on your own computer, with the gateway installed from the JotPanel repository:")}</p>
          <p className="ap-mono" style={{wordBreak:"break-all",userSelect:"all"}}>{`claude mcp add --transport stdio --env JOTPANEL_URL=${origin} --env JOTPANEL_API_KEY=${issued} jotpanel -- jotpanel-mcp`}</p>
        </div></div>}
        {note && <p style={{marginTop:10,fontSize:12}}>{note}</p>}
      </div></div>
      <div className="ap-card"><div className="ap-card-head"><strong>{t("Keys")}</strong><span>{live.length}</span></div><div className="ap-card-body">
        {!keys ? <p>{t("Loading…")}</p> : !live.length ? <p>{t("No keys yet.")}</p> :
          <table className="ap-table"><tbody>{live.map(k => <tr key={k.id}>
            <td><strong>{k.name}</strong><div className="ap-mono" style={{fontSize:10.5}}>{k.prefix}</div></td>
            <td style={{fontSize:11}}>{(k.capabilities||[]).join(" ")}</td>
            <td style={{fontSize:11}}>{k.lastUsedAt ? t("used {when}", { when:new Date(k.lastUsedAt).toLocaleString() }) : t("not used yet")}</td>
            <td><button className="ap-btn danger small" disabled={busy} onClick={()=>revoke(k)}>{t("Revoke")}</button></td>
          </tr>)}</tbody></table>}
      </div></div>
    </div>
  </>;
}

function TwoFactorSection({ api }) {
  const [state, setState] = useState(null);
  const [setup, setSetup] = useState(null);      // secret + QR, held only while enrolling
  const [codes, setCodes] = useState(null);      // recovery codes, shown once
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => api("/api/2fa").then(setState).catch(e => setError(e.message)), [api]);
  useEffect(() => { load(); }, [load]);

  const run = async (name, fn) => {
    setBusy(name); setError(""); setNote("");
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(""); }
  };

  const begin = () => run("setup", async () => { setCodes(null); setSetup(await api("/api/2fa/setup", { method: "POST" })); });
  const confirm = () => run("confirm", async () => {
    const result = await api("/api/2fa/confirm", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
    setCodes(result.recovery_codes); setSetup(null); setCode(""); await load();
  });
  const turnOff = () => run("disable", async () => {
    await api("/api/2fa/disable", { method: "POST", body: JSON.stringify({ password, code: code.trim() }) });
    setPassword(""); setCode(""); setCodes(null); setNote(t("Two-factor authentication is off for this account.")); await load();
  });
  const replaceCodes = () => run("codes", async () => {
    const result = await api("/api/2fa/recovery-codes", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
    setCodes(result.recovery_codes); setCode(""); await load();
  });

  const on = !!state?.enabled;
  return <>
    <div className="ap-section-head">
      <div>
        <h2>{t("Sign-in security")}</h2>
        <p>{t("A second code from your phone, on top of the password, for the account that can change this machine.")}</p>
      </div>
    </div>

    {error && <div className="ap-card"><div className="secondary" role="alert">{error}</div></div>}
    {note && <div className="ap-card"><div className="secondary">{note}</div></div>}

    <div className="ap-card">
      <div className="ap-card-head">
        <strong>{t("Two-factor authentication")}</strong>
        <span><PanelBadge tone={on ? "ok" : (state?.expected ? "warn" : "muted")}>{on ? t("On") : t("Off")}</PanelBadge></span>
      </div>
      <div className="ap-table-wrap"><table className="ap-table"><tbody>
        <tr><th>{t("This account")}</th><td>{state?.role ? state.role.replace(/_/g, " ") : t("unknown")}</td></tr>
        <tr><th>{t("Expected here")}</th><td>{state?.expected
          ? t("Yes. This account can change the server, so a stolen password is a stolen server.")
          : t("Not required for this account, and it still works if you turn it on.")}</td></tr>
        {on && <tr><th>{t("Recovery codes left")}</th><td>{state.recovery_codes_left}</td></tr>}
      </tbody></table></div>
    </div>

    {/* Enrolling. Nothing is switched on until a code from this secret has
        been typed back, so closing the page here changes nothing. */}
    {!on && !setup && <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Turn it on")}</strong></div>
      <div className="secondary">{t("You will scan a code with an authenticator app, then type the six digits it shows to prove it worked. Nothing changes until you do.")}</div>
      <div className="ap-actions"><button className="ap-btn primary" disabled={busy === "setup"} onClick={begin}>{busy === "setup" ? t("Preparing…") : t("Start")}</button></div>
    </div>}

    {!on && setup && <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Scan this, then type the code")}</strong></div>
      <div style={{ background: "#fff", padding: 10, borderRadius: 10, width: 240, lineHeight: 0 }}
           dangerouslySetInnerHTML={{ __html: setup.qr_svg }}/>
      <div className="secondary" style={{ marginTop: 10 }}>{t("If the camera will not read it, type this into the app by hand: ")}<code>{setup.secret}</code>
      </div>
      <div className="ap-actions" style={{ marginTop: 10 }}>
        <input value={code} onChange={e => setCode(e.target.value)} placeholder="000000" inputMode="numeric" aria-label={t("Code from your authenticator app")}/>
        <button className="ap-btn primary" disabled={busy === "confirm" || !code.trim()} onClick={confirm}>{busy === "confirm" ? t("Checking…") : t("Confirm")}</button>
        <button className="ap-btn" onClick={() => { setSetup(null); setCode(""); }}>{t("Cancel")}</button>
      </div>
    </div>}

    {/* Shown once and never again, because they are hashed on the way in and
        there is nothing left to show a second time. */}
    {codes && <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Your recovery codes")}</strong><span>{t("shown once")}</span></div>
      <div className="secondary">{t("Write these down or put them in a password manager now. Each one signs you in once if you lose the phone. This page is the only time they are readable.")}</div>
      <pre style={{ marginTop: 10, fontSize: 13, lineHeight: 1.9 }}>{codes.join("\n")}</pre>
    </div>}

    {on && <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Replace your recovery codes")}</strong></div>
      <div className="secondary">{t("The old ones stop working the moment new ones are made. Prove it is you with a code from the app or one of the codes you still have.")}</div>
      <div className="ap-actions" style={{ marginTop: 10 }}>
        <input value={code} onChange={e => setCode(e.target.value)} placeholder={t("Code or recovery code")} aria-label={t("Code or recovery code")}/>
        <button className="ap-btn" disabled={busy === "codes" || !code.trim()} onClick={replaceCodes}>{busy === "codes" ? t("Working…") : t("Make new codes")}</button>
      </div>
    </div>}

    {/* Turning it off asks for the password and the second factor together.
        Somebody who has walked up to a session left open has one and not the
        other, which is the entire point of it. */}
    {on && <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Turn it off")}</strong></div>
      <div className="secondary">{t("Needs your password and a live code, or a recovery code.")}</div>
      <div className="ap-actions" style={{ marginTop: 10 }}>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={t("Your password")} autoComplete="current-password" aria-label={t("Your password")}/>
        <input value={code} onChange={e => setCode(e.target.value)} placeholder={t("Code or recovery code")} aria-label={t("Code or recovery code")}/>
        <button className="ap-btn" disabled={busy === "disable" || !password || !code.trim()} onClick={turnOff}>{busy === "disable" ? t("Working…") : t("Turn off")}</button>
      </div>
    </div>}
  </>;
}

// Accounts and packages: the reseller surface.
//
// Every button here proposes. Nothing on this screen changes anything by
// itself, because changing what a customer is allowed to have goes through the
// same propose, approve, execute path as restarting a service, and lands in the
// same record. So the buttons say so, and the card appears under Activity and
// approval like every other one.
function ResellerSection({ api }) {
  const [data, setData] = useState(null);
  const [limits, setLimits] = useState({});     // org_id -> its usage report
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [proposed, setProposed] = useState(null);
  const [draft, setDraft] = useState({ org: "", metric: "sites_count", maximum: "", unlimited: false, reason: "" });
  const [newAccount, setNewAccount] = useState({ email: "", name: "", packageId: "" });

  const load = useCallback(async () => {
    try { setData(await api("/api/organizations")); }
    catch (e) { setError(e.message); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const openAccount = async orgId => {
    if (limits[orgId]) { setLimits(prev => ({ ...prev, [orgId]: null })); return; }
    try {
      const report = await api(`/api/organizations/${orgId}/entitlements`);
      setLimits(prev => ({ ...prev, [orgId]: report }));
    } catch (e) { setError(e.message); }
  };

  const propose = async (name, path, options) => {
    setBusy(name); setError(""); setProposed(null);
    try {
      const result = await api(path, options);
      setProposed(result.action || null);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  };

  // Everything below goes through the one propose route, so the reseller screen
  // asks the same engine the API and the assistant would.
  const proposeOperation = (name, operation, input) => propose(name, "/api/panel/server/propose", {
    method: "POST", body: JSON.stringify({ operation, input }),
  });

  // Generated here rather than asked for. A provider setting a password for
  // somebody else means the provider knows it, and the panel shows it once on
  // the approval card instead.
  const invent = () => {
    const bytes = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return `Aa1-${btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`;
  };

  const proposeTakeOn = () => proposeOperation("take-on", "account.create", {
    email: newAccount.email.trim(),
    name: newAccount.name.trim() || undefined,
    password: invent(),
    packageId: newAccount.packageId || undefined,
  });

  const proposeOverride = () => propose("override", `/api/organizations/${draft.org}/overrides/${draft.metric}`, {
    method: "PUT",
    body: JSON.stringify({
      unlimited: draft.unlimited,
      maximum: draft.unlimited ? undefined : Number(draft.maximum),
      reason: draft.reason || undefined,
    }),
  });

  const accounts = data?.accounts || [];
  const fmt = metric => metric.replace(/_/g, " ").replace(/ count$/, "").replace(/ microunits month$/, " per month");
  const shown = value => (value?.unlimited ? "unlimited" : value?.value ?? "—");

  return <>
    <div className="ap-section-head">
      <div>
        <h2>{t("Accounts and packages")}</h2>
        <p>{t("The accounts you provide for, what they are on, and what they may use. Every change here is proposed and waits for approval.")}</p>
      </div>
    </div>

    {error && <div className="ap-card"><div className="secondary" role="alert">{error}</div></div>}
    {proposed && <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Proposed")}</strong><span>{t("waiting for approval")}</span></div>
      <div className="secondary">{t("{label}. It is on the Activity and approval screen, and nothing has changed yet.", { label: proposed.label })}</div>
    </div>}

    <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Your accounts")}</strong><span>{accounts.length}</span></div>
      {!accounts.length && <div className="secondary">{t("No accounts sit under yours yet. An account becomes yours when you take it on, which is also a proposal.")}</div>}
      {!!accounts.length && <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Account")}</th><th>{t("Package")}</th><th>{t("Held directly")}</th><th>{t("State")}</th><th className="ap-row-action">{t("Actions")}</th></tr></thead>
        <tbody>{accounts.map(account => <Fragment key={account.org_id}>
          <tr>
            <td>
              <strong>{account.people[0]?.email || account.org_id}</strong>
              {account.people.length > 1 && <div className="secondary">{(account.people.length > 2 ? t("and {count} other sign-ins", { count: account.people.length - 1 }) : t("and {count} other sign-in", { count: account.people.length - 1 }))}</div>}
            </td>
            <td>{account.package ? account.package.name : <PanelBadge tone="warn">{t("none")}</PanelBadge>}</td>
            <td>{account.direct ? t("yes") : t("through another account")}</td>
            <td>{account.suspended ? <PanelBadge tone="warn">{t("suspended")}</PanelBadge> : <PanelBadge tone="ok">{t("active")}</PanelBadge>}</td>
            <td className="ap-row-action">
              <button className="ap-btn small" onClick={() => openAccount(account.org_id)}>{limits[account.org_id] ? t("Hide") : t("Show")}</button>
              <button className="ap-btn small" disabled={!!busy}
                onClick={() => proposeOperation("suspend", account.suspended ? "account.unsuspend" : "account.suspend", { targetOrgId: account.org_id })}>
                {account.suspended ? t("Restore") : t("Suspend")}
              </button>
            </td>
          </tr>
          {limits[account.org_id] && <tr><td colSpan={5}>
            <table className="ap-table">
              <thead><tr><th>{t("Limit")}</th><th>{t("Allowed")}</th><th>{t("Used")}</th><th>{t("Where it comes from")}</th></tr></thead>
              <tbody>{(limits[account.org_id].metrics || []).map(metric => <tr key={metric.metric}>
                <td>{fmt(metric.metric)}</td>
                <td>{shown(metric.maximum_allowed)}</td>
                <td>{metric.actually_used?.subtree ?? "—"}</td>
                <td>{metric.maximum_allowed?.source}</td>
              </tr>)}</tbody>
            </table>
          </td></tr>}
        </Fragment>)}</tbody>
      </table></div>}
    </div>

    {/* Taking somebody on. One action rather than three, because an account
        that exists, belongs to nobody and is on no package is not a customer. */}
    <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Take on a customer")}</strong></div>
      <div className="secondary" style={{ marginBottom: 10 }}>{t("They get an account of their own, underneath yours, on the package you choose. Their password is generated and shown once on the approval card, never stored anywhere you can read it again.")}</div>
      <div className="ap-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        <input value={newAccount.email} onChange={e => setNewAccount({ ...newAccount, email: e.target.value })}
               placeholder={t("Their email")} type="email" aria-label={t("Customer email")}/>
        <input value={newAccount.name} onChange={e => setNewAccount({ ...newAccount, name: e.target.value })}
               placeholder={t("Their name (optional)")} aria-label={t("Customer name")}/>
        <select value={newAccount.packageId} onChange={e => setNewAccount({ ...newAccount, packageId: e.target.value })} aria-label={t("Package")}>
          <option value="">{t("No package yet")}</option>
          {(data?.packages || []).filter(p => p.status === "active").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="ap-btn primary" disabled={!!busy || !newAccount.email.trim()} onClick={proposeTakeOn}>
          {busy === "take-on" ? t("Proposing…") : t("Propose")}
        </button>
      </div>
      {!(data?.packages || []).some(p => p.status === "active") && <div className="secondary" style={{ marginTop: 8 }}>{t("You have no package to put them on yet. An account with no package cannot create anything, so make one first.")}</div>}
    </div>

    {/* One limit, one account. The commonest thing a hoster actually does, and
        the reason overrides exist rather than a new package per request. */}
    <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Move one limit for one account")}</strong></div>
      <div className="ap-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        <select value={draft.org} onChange={e => setDraft({ ...draft, org: e.target.value })} aria-label={t("Account")}>
          <option value="">{t("Choose an account")}</option>
          {accounts.map(a => <option key={a.org_id} value={a.org_id}>{a.people[0]?.email || a.org_id}</option>)}
        </select>
        <select value={draft.metric} onChange={e => setDraft({ ...draft, metric: e.target.value })} aria-label={t("Limit")}>
          {(data?.metrics || []).map(m => <option key={m.metric} value={m.metric}>{fmt(m.metric)}</option>)}
        </select>
        <input value={draft.maximum} disabled={draft.unlimited} onChange={e => setDraft({ ...draft, maximum: e.target.value })}
               placeholder={t("New limit")} inputMode="numeric" aria-label={t("New limit")}/>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={draft.unlimited} onChange={e => setDraft({ ...draft, unlimited: e.target.checked })}/>{t("unlimited")}</label>
        <input value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })} placeholder={t("Why (goes on the record)")} aria-label={t("Reason")}/>
        <button className="ap-btn primary" disabled={busy === "override" || !draft.org || (!draft.unlimited && !draft.maximum)} onClick={proposeOverride}>
          {busy === "override" ? t("Proposing…") : t("Propose")}
        </button>
      </div>
      <div className="secondary" style={{ marginTop: 8 }}>{t("Unlimited only holds while whoever provides for this account is unlimited too. Clearing an override puts the package value back, which can reduce what they may add.")}</div>
    </div>

    <div className="ap-card">
      <div className="ap-card-head"><strong>{t("Your packages")}</strong><span>{(data?.packages || []).length}</span></div>
      {!(data?.packages || []).length && <div className="secondary">{t("You have no packages yet. A package cannot be edited once it exists, so changing what one offers means making another.")}</div>}
      {!!(data?.packages || []).length && <div className="ap-table-wrap"><table className="ap-table">
        <thead><tr><th>{t("Package")}</th><th>{t("State")}</th><th className="ap-row-action">{t("Actions")}</th></tr></thead>
        <tbody>{data.packages.map(pkg => <tr key={pkg.id}>
          <td><strong>{pkg.name}</strong><div className="secondary ap-mono">{pkg.id}</div></td>
          <td><PanelBadge tone={pkg.status === "active" ? "ok" : "muted"}>{pkg.status}</PanelBadge></td>
          <td className="ap-row-action">{pkg.status === "active" && <button className="ap-btn small" disabled={busy === `archive-${pkg.id}`}
            onClick={() => propose(`archive-${pkg.id}`, `/api/entitlements/packages/${pkg.id}/archive`, { method: "POST", body: "{}" })}>
            {busy === `archive-${pkg.id}` ? t("Proposing…") : t("Stop offering")}
          </button>}</td>
        </tr>)}</tbody>
      </table></div>}
    </div>
  </>;
}

export function ControlPanelApp({ user, onOpenApp, onSignOut, standalone = false, initialSection = "overview" }) {
  const [section, setSection] = useState(initialSection);
  // Changing language re-renders the panel rather than reloading it. The
  // dictionary is module state, so something has to tell React the words have
  // changed, and a counter is the smallest thing that does.
  const [, setLanguageTick] = useState(0);
  const [navQuery, setNavQuery] = useState("");
  const [toolQuery, setToolQuery] = useState("");
  const contentRef = useRef(null);
  const [overview, setOverview] = useState(null);
  const [sites, setSites] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState(null);
  const [usage, setUsage] = useState(null);
  const [license, setLicense] = useState(null);
  const [serverCaps, setServerCaps] = useState(null);
  const [serverSites, setServerSites] = useState([]);
  const [machine, setMachine] = useState(null);
  const [actions, setActions] = useState([]);
  const [actionQuery, setActionQuery] = useState("");
  const [actionStatus, setActionStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);
  const [jobForm, setJobForm] = useState({ id:null, name:"", note:"", schedule:"0 3 * * *", command:"", enabled:true });
  const [jobHistory, setJobHistory] = useState({ job:null, runs:[], loading:false });
  const [registration, setRegistration] = useState({ email:user?.email || "", newsletter_opt_in:false });
  const [inspection, setInspection] = useState(null);
  // Passwords a migration had to generate, handed back by the run that made
  // them and held here until the screen is left. They are in no record and
  // cannot be asked for again, which is the whole reason this exists.
  const [credentials, setCredentials] = useState(null);

  const api = useCallback(async (path, opts = {}) => {
    const srv = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
    const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
    const res = await fetch(`${srv}${path}`, { ...opts, headers:{ Authorization:`Bearer ${readPanelStorage("jwt") || ""}`, ...(!isForm && opts.body ? {"Content-Type":"application/json"} : {}), ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    // A gateway status is the web server saying it stopped waiting, not the
    // panel saying the work failed. It arrives as nginx's own HTML, so there is
    // no message in it to show, and printing the number at a person tells them
    // nothing they can act on — least of all that the job they started is very
    // probably still running.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(t("The panel took too long to answer, so the connection was closed. Anything you started is still running on the machine — open Activity to see how it ends rather than starting it again."));
    }
    if (!res.ok) throw new Error(data.error || t("Request failed ({status})", { status: res.status }));
    return data;
  }, []);

  // Who is signed in decides which screens exist and which reads are even
  // asked for. The panel used to draw every operator screen for everybody and
  // let the backend sort it out, which it did not; now both halves agree.
  //
  // Asked of the server rather than read off whatever the caller passed. The
  // desktop opens this window with no user object at all, and the sign-in
  // response does not carry the rank, so a prop on its own would demote the
  // box's own operator to a customer on their own panel.
  const [operatorHere, setOperatorHere] = useState(user?.is_operator === true);
  useEffect(() => {
    let live = true;
    api("/api/me").then(me => { if (live) setOperatorHere(me?.is_operator === true); }).catch(() => {});
    return () => { live = false; };
  }, [api]);

  const refresh = useCallback(async (quiet = false, refreshCapabilities = false) => {
    if (!quiet) setLoading(true);
    const requests = [
      ["overview", "/api/panel/overview"], ["sites", "/api/panel/sites"], ["jobs", "/api/panel/jobs"],
      ["stats", "/api/panel/statistics"], ["usage", "/api/usage"], ["actions", "/api/control/actions"],
      ["serverCaps", `/api/panel/server/capabilities${refreshCapabilities ? "?refresh=1" : ""}`],
      // The websites this account has on the machine, which for the operator is
      // every one of them. The top bar was reporting the account's and a
      // control panel's first number saying zero while its Websites screen
      // lists one is the kind of thing that makes an operator distrust every
      // other number on the page.
      ["serverSites", "/api/panel/server/read/server-sites"],
      // The load, memory and disk of the box belong to the account that runs
      // the box, and the backend now says so. Asking for it as a customer
      // would only collect a 403 and print it as a failed check.
      ...(operatorHere ? [["machine", "/api/panel/server/read/system-metrics"]] : []),
      // Same rule, same reason: asking as a customer would only collect a 403
      // and print it as a failed check on a screen they cannot open anyway.
      ...(operatorHere ? [["license", "/api/license"]] : []),
    ];
    const results = await Promise.allSettled(requests.map(([, path]) => api(path)));
    const failures = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") { failures.push(`${requests[i][0]}: ${result.reason.message}`); return; }
      const [key] = requests[i], value = result.value;
      if (key === "overview") setOverview(value);
      if (key === "sites") setSites(value.sites || []);
      if (key === "jobs") setJobs(value.jobs || []);
      if (key === "stats") setStats(value);
      if (key === "usage") setUsage(value);
      if (key === "license") setLicense(value);
      if (key === "serverCaps") setServerCaps(value);
      if (key === "serverSites") setServerSites(value.sites || []);
      if (key === "machine") setMachine(value);
      if (key === "actions") setActions(value.actions || []);
    });
    if (failures.length) setNotice({ error:true, text:t("Some checks did not finish — {count}", { count: failures.join("; ") }) });
    setLoading(false);
  }, [api, operatorHere]);

  useEffect(() => { refresh(); }, [refresh]);
  // A request from your own AI arrives while you are looking at the panel, so
  // the approval list asks again every fifteen seconds while the page is in
  // view. Only the list is fetched; nothing else on the page reloads.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      api("/api/control/actions").then(value => setActions(value.actions || [])).catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [api]);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [section]);

  const run = async (key, work, success, refreshCapabilities = false) => {
    setBusy(key); setNotice(null);
    try { const result = await work(); setNotice({ text:success || t("Proposal recorded. Nothing has run yet.") }); await refresh(true, refreshCapabilities); return result; }
    // A failure changes the record too: an execution that did not work is now
    // a failed action, not an approved one still waiting. Without this refresh
    // the row keeps offering Execute for something that has already run and
    // failed, which is the opposite of keeping failures visible.
    catch (error) { setNotice({ error:true, text:error.message }); await refresh(true, refreshCapabilities); throw error; }
    finally { setBusy(""); }
  };
  // The failure is already on screen and on the record by the time run rejects.
  // Callers that only fire the work use this so a handled failure does not also
  // land in the browser console as an unhandled rejection.
  const runQuiet = (...args) => run(...args).catch(() => undefined);

  // A destructive action is confirmed by typing the word into the record
  // itself. This used to be a browser prompt, which some browsers suppress
  // outright, and a confirmation that can be silently swallowed is not one.
  const [confirming, setConfirming] = useState({ id:null, text:"" });
  const approveAction = async (action, confirmText) => {
    if (action.requiresConfirmText && confirmText !== action.requiresConfirmText) {
      setConfirming({ id:action.id, text:"" });
      return;
    }
    setConfirming({ id:null, text:"" });
    await runQuiet(`approve-${action.id}`, () => api(`/api/control/actions/${action.id}/approve`, { method:"POST", body:JSON.stringify({ confirmText }) }), t("Approved. It still has not run; use Execute when you are ready."));
  };

  const rejectAction = action => runQuiet(`reject-${action.id}`, () => api(`/api/control/actions/${action.id}/reject`, { method:"POST", body:JSON.stringify({ reason:t("Rejected by owner in Control Panel") }) }), t("Rejected and recorded. Nothing changed."));

  const executeAction = async action => {
    const srv = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
    if (action.kind === "portability.export") {
      const passphrase = window.prompt(t("Choose an export passphrase (at least 12 characters). You will need it to restore credentials."));
      if (!passphrase) return;
      setBusy(`execute-${action.id}`); setNotice(null);
      try {
        const res = await fetch(`${srv}/api/portability/export/${action.id}/execute`, { method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${readPanelStorage("jwt") || ""}`}, body:JSON.stringify({passphrase}) });
        if (!res.ok) { const d = await res.json().catch(()=>({})); throw new Error(d.error || t("Export failed ({status})", { status: res.status })); }
        const blob = await res.blob();
        const disposition = res.headers.get("Content-Disposition") || "";
        const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "jotpanel-account.zip";
        const href = URL.createObjectURL(blob); const link = document.createElement("a"); link.href=href; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(href),1000);
        setNotice({text:t("Export verified and downloaded as {filename}.", { filename: filename })}); await refresh(true);
      } catch (error) { setNotice({error:true,text:error.message}); }
      finally { setBusy(""); }
      return;
    }
    let path = `/api/control/actions/${action.id}/execute`, body = {};
    if (action.kind === "portability.restore") {
      path = `/api/portability/import/${action.id}/execute`;
      const nativePackage = ["jotpanel", "arca"].includes(action.metadata?.source);
      const passphrase = nativePackage ? window.prompt(t("Enter the package passphrase.")) : "";
      if (nativePackage && !passphrase) return;
      body = { passphrase };
    } else if (["create_email_account","create_ftp_account","add_dns_record","fetch_account_stats"].includes(action.kind)) {
      path = `/api/provisioning/actions/${action.id}/execute`;
    }
    // Stack installs change which tools exist. Force the permission probes
    // after every execution so the newly installed surface appears without a
    // second, unexplained click on Refresh. The same forced check also removes
    // a tool immediately if an execution changed or removed its prerequisite.
    const done = await runQuiet(`execute-${action.id}`, () => api(path, { method:"POST", body:JSON.stringify(body) }), t("Execution finished and the result was verified. The record is below."), true);
    // 202: the panel stopped watching at the screen and the machine carried on.
    // The default message above says the result was verified, and saying that
    // about work still in progress is the same lie as a cross over work that
    // succeeded. The record stays Working until the machine reports how it
    // ended, and this says exactly that.
    if (done?.stillRunning) setNotice({ text: done.message || t("This is still running on the machine. The result will appear here by itself when it finishes; do not start it again.") });
    if (done?.deliver_once?.length) setCredentials({ label:action.label, rows:done.deliver_once });
  };

  const proposeJob = async operation => {
    const problem = scheduledJobFormProblem(jobForm);
    if (problem) { setNotice({ error:true, text:problem }); return; }
    const payload = operation === "create" || operation === "update" ? { operation, id:jobForm.id, job:{ name:jobForm.name, note:jobForm.note, schedule:jobForm.schedule, command:jobForm.command, enabled:jobForm.enabled } } : { operation, id:jobForm.id };
    const proposed = await run("job-save", () => api("/api/panel/jobs/propose", { method:"POST", body:JSON.stringify(payload) }), t("{count} proposed. Review it in Activity before anything runs.", { count: operation === "create" ? t("Creation") : t("Update") })).catch(() => null);
    if (!proposed) return;
    setJobForm({ id:null, name:"", note:"", schedule:"0 3 * * *", command:"", enabled:true }); setSection("activity");
  };

  const proposeExistingJob = async (job, operation) => {
    const proposed = await run(`job-${operation}-${job.id}`, () => api("/api/panel/jobs/propose", { method:"POST", body:JSON.stringify({ operation, id:job.id }) }), t("{count} proposed. Review it in Activity.", { count: operation === "run" ? t("Manual run") : t("Deletion") })).catch(() => null);
    if (!proposed) return;
    setSection("activity");
  };

  const editJob = job => {
    setJobForm({ id:job.id, name:job.name, note:job.note||"", schedule:job.schedule, command:job.command, enabled:job.enabled });
    contentRef.current?.scrollTo({ top:0, behavior:"smooth" });
  };

  const viewJobHistory = async job => {
    if (jobHistory.job?.id === job.id) { setJobHistory({ job:null, runs:[], loading:false }); return; }
    setJobHistory({ job, runs:[], loading:true });
    try {
      const result = await api(`/api/panel/jobs/${job.id}/history?limit=50`);
      setJobHistory({ job, runs:result.runs || [], loading:false });
    } catch (error) {
      setJobHistory({ job, runs:[], loading:false });
      setNotice({ error:true, text:error.message });
    }
  };

  const inspectArchive = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    const form = new FormData(); form.append("archive", file);
    const result = await runQuiet("inspect", () => api("/api/portability/import/inspect", { method:"POST", body:form }), t("Archive inspected. Review the exact contents and approve the restore in Activity."));
    if (result) { setInspection(result.inspection); setSection("portability"); }
    event.target.value = "";
  };

  const registerPanel = async () => {
    await runQuiet("register", () => api("/api/license/register", { method:"POST", body:JSON.stringify({ ...registration, consent_text:t("We will email you about software updates and news.") }) }), t("Registration completed. The panel remains local; the assistant connection is now available."));
  };

  const downloadUsage = async () => {
    setBusy("usage-download");
    try {
      const srv = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
      const res = await fetch(`${srv}/api/usage?format=csv`, { headers:{Authorization:`Bearer ${readPanelStorage("jwt") || ""}`} });
      if (!res.ok) throw new Error(t("Usage download failed ({status})", { status: res.status }));
      const blob = await res.blob(), href=URL.createObjectURL(blob), link=document.createElement("a"); link.href=href; link.download="jotpanel-usage.csv"; link.click(); setTimeout(()=>URL.revokeObjectURL(href),1000);
      setNotice({text:t("Usage CSV downloaded.")});
    } catch (error) { setNotice({error:true,text:error.message}); }
    finally { setBusy(""); }
  };

  // Server operations. Every screen asks this object what the machine can do
  // rather than assuming, so a control is drawn only where the engine
  // underneath really provides it.
  const capabilityIndex = (() => {
    const index = new Map();
    for (const sectionState of serverCaps?.sections || []) {
      for (const capability of sectionState.capabilities) index.set(capability.id, capability);
    }
    return index;
  })();
  const downloadFile = async (path, filename, opts = {}) => {
    setBusy(`download-${path}`); setNotice(null);
    try {
      const srv = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
      const res = await fetch(`${srv}${path}`, { ...opts, headers:{ Authorization:`Bearer ${readPanelStorage("jwt") || ""}`, ...(opts.body ? {"Content-Type":"application/json"} : {}) } });
      if (!res.ok) { const detail = await res.json().catch(()=>({})); throw new Error(detail.error || t("Download failed ({status})", { status: res.status })); }
      const blob = await res.blob(), href = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = href; link.download = filename; link.click(); setTimeout(()=>URL.revokeObjectURL(href), 1000);
      setNotice({ text:t("{filename} downloaded{count}.", { filename: filename, count: res.headers.get("X-JotPanel-Log-Truncated")==="tail-only"?t(", showing only the most recent part of a large file"):"" }) });
    } catch (error) { setNotice({ error:true, text:error.message }); }
    finally { setBusy(""); }
  };
  const ops = {
    api,
    busy,
    scope: overview?.scope,
    // Two screens a customer legitimately uses carry one card each that reads
    // the machine rather than the account. The card is absent for them rather
    // than printing a refusal, which is the same rule the sidebar follows.
    isOperator: operatorHere,
    can: id => !!capabilityIndex.get(id)?.available,
    why: id => capabilityIndex.get(id)?.reason || t("This panel has not been told whether the server can do that."),
    setup: sectionId => (serverCaps?.sections || []).find(item => item.id === sectionId)?.setup || null,
    connect: kind => { setSection(kind === "mail" ? "mail" : "settings"); setNotice({ text:t("Open the {count} settings and enter the service you already use.", { count: kind === "mail" ? t("mail account") : "connection" }) }); },
    notify: (text, error) => setNotice({ text, error: !!error }),
    download: downloadFile,
    propose: (operation, input, options = {}) =>
      run(`op-${operation}`, () => api("/api/panel/server/propose", { method:"POST", body: JSON.stringify({ operation, input, ...options }) }),
          t("Proposed. Nothing has run yet. Approve and execute it in Activity."))
        .then(() => setSection("activity")).catch(()=>{}),
  };

  // The screens whose readings are the machine's own state. They are the
  // operator's on the backend, so they are not drawn for anybody else: a tile
  // that can only answer 403 is worse than no tile.
  // Registration is the installation's, not an account's: there is one
  // registration on a box and it is the operator's. It used to be offered to
  // everybody, which put a screen in front of a customer that could re-register
  // the whole machine under their address.
  const OPERATOR_ONLY = ["services", "logs", "integrations", "backupdestinations", "backuphealth", "security", "migration", "console", "admin", "license"];
  const forMe = rows => rows.filter(row => operatorHere || !OPERATOR_ONLY.includes(row[0]));

  const nav = forMe([
    ["overview","overview",t("Overview")], ["services","server",t("Services & processes")], ["logs","document",t("Logs")],
    ["databases","storage",t("Databases")], ["mailadmin","mail",t("Mail administration")], ["serversites","globe",t("Websites on this server")],
    ["filesadmin","folder",t("Files & upload accounts")], ["dnszone","globe",t("DNS zone")], ["integrations","globe",t("Integrations")], ["backupdestinations","files",t("Backup destinations")], ["backuphealth","shield",t("Backup health")], ["backups","archive",t("Backups & restore")], ["security","shield",t("Firewall, updates & keys")],
    ["admin","license",t("Hoster admin")],
    ["migration","portability",t("Move in from another server")], ["console","panel",t("Command console")],
    ["sites","globe",t("Websites")], ["jobs","jobs",t("Scheduled jobs")],
    ["portability","portability",t("Move & restore")], ["statistics","statistics",t("Web statistics")], ["usage","usage",t("Usage feed")],
    ["license","license",t("Registration")], ["activity","activity",t("Activity & approval")],
    ["files","folder",t("File manager")], ["mail","mail",t("Mail")], ["settings","settings",t("Settings")],
  ]);
  // What somebody actually types. A person with a mail problem searches for
  // "spam" or "dmarc", not for the name of the screen we happened to pick, so
  // each screen carries the words that lead to it.
  const SEARCH_WORDS = {
    overview: "dashboard home machine cpu memory disk load",
    services: "restart stop start systemd process kill daemon nginx postfix",
    logs: "error journal tail access mail log debug",
    databases: "mysql mariadb postgres sql dump import table user grant",
    mailadmin: "mailbox email account quota forwarder autoreply catchall alias password",
    mailauth: "spf dkim dmarc spam junk deliverability signing reports forged authentication",
    serversites: "website domain php document root vhost alias subdomain",
    sitefiles: "upload edit files html public",
    filesadmin: "sftp upload account folder permissions ftp",
    dnszone: "dns zone record a cname mx txt ns nameserver bind glue",
    integrations: "integration provider vendor api key connect spam filter cdn storage payments monitoring affiliate",
    backupdestinations: "backup destination offsite sftp s3 r2 backblaze b2 wasabi minio bucket object storage remote copy disaster recovery",
    backuphealth: "backup health failed overdue never verified recovery point account operator grid",
    backups: "backup restore archive schedule retention recovery download",
    admin: "hoster admin console tenants accounts customers audit trail fleet billing who is on this box",
    security: "firewall port block allow ufw ban updates patch ssh key fail2ban",
    migration: "move import cpanel transfer imap copy",
    console: "command shell terminal run",
    jobs: "cron schedule task timer",
    portability: "backup restore snapshot archive download export version",
    activity: "approve pending queue history audit action",
    statistics: "visitors traffic analytics stats",
    usage: "billing invoice metered spend cost",
    license: "registration key licence activate",
    files: "file manager folder",
    mail: "mail client inbox imap",
    settings: "preferences configuration domain certificate branding",
    echo: "assistant ai chat ask talk",
  };

  const operatorNav = [
    { label:t("Server"), rows:forMe([["echo",t("Ask Echo")],["overview",t("Overview")],["services",t("Services")],["logs",t("Logs")],["serversites",t("Websites")],["sitefiles",t("Site files")],["databases",t("Databases")],["mailadmin",t("Mailboxes")],["mailauth",t("Mail authentication")],["filesadmin",t("Files & uploads")],["dnszone","DNS"],["integrations",t("Integrations")],["backupdestinations",t("Backup destinations")],["admin",t("Hoster admin")],["security",t("Firewall & updates")],["migration",t("Move in")]]) },
    { label:t("Operations"), rows:forMe([["backuphealth",t("Backup health")],["jobs",t("Scheduled jobs")],["backups",t("Backups & restore")],["activity",t("Activity & approval")]]) },
    { label:t("Customers"), rows:[["reseller",t("Accounts and packages")]] },
    { label:t("Account"), rows:[["statistics",t("Web statistics")],["usage",t("Usage")],["twofactor",t("Sign-in security")],["connectai",t("Connect your AI")],...(operatorHere ? [["license",t("Registration")]] : []),["files",t("File manager")],["mail",t("Mail client")],["settings",t("Settings")]] },
  ].filter(group => group.rows.length);
  const navQueryWords = navQuery.trim().toLowerCase();
  const navMatches = !navQueryWords
    ? operatorNav.flatMap(g => g.rows.map(([id]) => id))
    : operatorNav.flatMap(g => g.rows)
        .filter(([id, label]) => `${label} ${SEARCH_WORDS[id] || ""}`.toLowerCase().includes(navQueryWords))
        .map(([id]) => id);

  const title = nav.find(([id]) => id === section)?.[2] || t("Control Panel");
  const activeActions = actions.filter(a => ["pending","approved"].includes(a.status));
  const certAttention = sites.filter(s => !["healthy","not_configured"].includes(s.certificate?.status)).length;
  const panelAvailable = license?.panel_available !== false;
  // The same tool opens a desktop window inside Arca and a full-width section
  // in the standalone panel, which is the whole difference between the two
  // shells. Nothing else in this component knows which one it is running in.
  const openTool = tool => {
    if (tool.app && onOpenApp) onOpenApp(tool.app);
    else { setSection(tool.section); setToolQuery(""); }
  };
  // The rule that stops the two shells drifting apart. One tool list serves
  // both, so a tool is only drawn where this shell can actually open it: a
  // window target needs a desktop to open it in, a section target works
  // anywhere. A tool with neither is absent rather than disabled, which is the
  // same rule the capability layer already applies to the machine's own gaps.
  const canOpen = tool => !!(tool.section || (tool.app && onOpenApp));
  const dropped = [];
  const openableIn = tools => tools.filter(tool => (canOpen(tool) ? true : (dropped.push(tool.label), false)));
  // The server tools are built from what the machine reported, never from a
  // list held here. A section the engine cannot serve produces no button.
  const SERVER_TOOL_ART = { services:"services", logs:"logs", databases:"databases", mailadmin:"mail", mailauth:"mail", serversites:"websites", filesadmin:"files", dnszone:"websites", integrations:"globe", backupdestinations:"files", admin:"license", security:"security", migration:"files", console:"console" };
  const SERVER_TOOL_LABEL = { services:t("Services"), logs:t("Logs"), databases:t("Databases"), mailadmin:t("Mail admin"), serversites:t("Server sites"), filesadmin:t("File access"), dnszone:t("DNS zone"), integrations:t("Integrations"), backupdestinations:t("Backup destinations"), admin:t("Hoster admin"), security:t("Firewall & keys"), migration:t("Move in"), console:t("Console") };
  const SERVER_TOOL_TONE = { services:"blue", logs:"yellow", databases:"green", mailadmin:"blue", serversites:"purple", filesadmin:"yellow", dnszone:"purple", security:"coral", migration:"green", console:"orange" };
  const visibleSections = (serverCaps?.sections || []).filter(s => operatorHere || !OPERATOR_ONLY.includes(s.id));
  const serverTools = visibleSections.filter(s => s.available).map(s => ({
    art: SERVER_TOOL_ART[s.id] || "services",
    label: SERVER_TOOL_LABEL[s.id] || s.title,
    description: s.blurb,
    keywords: `${s.title} ${s.capabilities.map(c => c.id).join(" ")}`,
    section: s.id,
    status: s.capabilities.some(c => !c.available) ? t("Partly available") : t("Ready"),
    tone: SERVER_TOOL_TONE[s.id] || "blue",
  }));
  const serverBlocked = visibleSections.filter(s => !s.available);

  const toolGroups = [
    { title:t("Server operations"), note:t("Run the machine itself"), tools:serverTools, blocked:serverBlocked },
    ...panelToolGroups({ sites, certAttention, overview, stats, usage, license, activeActions, operator: operatorHere }),
  ];
  const query = toolQuery.trim().toLowerCase();
  const visibleToolGroups = toolGroups
    .map(group => ({
      ...group,
      tools: openableIn(group.tools).filter(tool => !query || `${tool.label} ${tool.description} ${tool.keywords || ""}`.toLowerCase().includes(query)),
      // Kept while searching too, because "why can I not find databases" is
      // exactly the question the blocked list answers.
      blocked: (group.blocked || []).filter(entry => !query || `${entry.title} ${entry.blurb}`.toLowerCase().includes(query)),
    }))
    .filter(group => group.tools.length || group.blocked.length);

  const SitesTable = ({ limit }) => {
    const rows = limit ? sites.slice(0, limit) : sites;
    if (!rows.length) return <div className="ap-empty"><PanelIcon name="globe" size={28}/><strong>{t("No websites in this account")}</strong><span>{t("Create a site and its certificate check will appear here.")}</span>{onOpenApp && <button className="ap-btn primary" onClick={()=>onOpenApp("sites")}>{t("Open Sites")}</button>}</div>;
    return <div className="ap-table-wrap"><table className="ap-table"><thead><tr><th>{t("Website")}</th><th>{t("State")}</th><th>{t("Certificate health")}</th><th>{t("Last checked")}</th></tr></thead><tbody>{rows.map(site => <tr key={site.id}><td><strong>{site.name}</strong><div className="secondary">{site.domain || t("Domain not assigned")}</div></td><td><PanelBadge tone={site.status === "published" ? "ok" : "neutral"}>{site.status || t("draft")}</PanelBadge></td><td><PanelBadge tone={certificateTone(site.certificate?.status)}>{String(site.certificate?.status || "unknown").replace(/_/g," ")}</PanelBadge><div className="secondary">{site.certificate?.reason || (site.certificate?.days_remaining != null ? t("{daysremaining} days remaining", { daysremaining: site.certificate.days_remaining }) : t("No certificate detail"))}</div></td><td>{panelDate(site.certificate?.checked_at, true)}</td></tr>)}</tbody></table></div>;
  };

  const ActionList = ({ rows = actions, emptyTitle = t("No actions to review"), emptyText = t("Every proposed, rejected, completed, and failed action will be kept here.") }) => rows.length ? <div>{rows.map(action => <div className="ap-list-row" key={action.id}>
    <div className="ap-list-icon"><PanelIcon name={action.status === "failed" || action.status === "interrupted" ? "alert" : action.status === "executed" ? "check" : "activity"} size={15}/></div>
    <div style={{minWidth:0,flex:1}}>
      <div className="ap-list-title">{action.label}</div>
      <div className="ap-list-note">{action.summary || action.error || action.kind} · {panelDate(action.createdAt, true)}</div>
      {action.error && <div className="ap-list-note" style={{color:"#923a33"}}>{t("Not completed: {error}", { error: action.error })}</div>}
      {action.executionResult?.verified === false && action.executionResult?.unverified_reason && <div className="ap-list-note" style={{color:"#875610"}}>{t("Not verified: {unverifiedreason}", { unverifiedreason: action.executionResult.unverified_reason })}</div>}
      {action.status === "interrupted" && action.interruptionReason && <div className="ap-list-note" style={{color:"#875610"}}>{t("Outcome not observed: {interruptionreason}", { interruptionreason: action.interruptionReason })}</div>}
      {action.status === "executing" && <div className="ap-list-note" style={{color:"#24577e"}}>{t("Running since ")}{panelDate(action.startedAt, true)}{t(". Nothing else needs doing; the record finishes itself.")}</div>}
      {action.executionResult?.reconciled && <div className="ap-list-note" style={{color:"#5f6b79"}}>{t("Recorded after the panel restarted, from {reconciledfrom}.", { reconciledfrom: action.executionResult.reconciled_from })}</div>}
      {/* A restore that had to put the site back says so, and anything it could
          not put back is named here rather than left to be discovered. */}
      {!!action.executionResult?.rebuilt?.length && <div className="ap-list-note" style={{color:"#5f6b79"}}>{t("Rebuilt on the way: ")}{action.executionResult.rebuilt.join(", ")}.</div>}
      {action.executionResult?.serving === true && <div className="ap-list-note" style={{color:"#167362"}}>{t("The site answers on this server, checked after the restore.")}</div>}
      {action.executionResult?.complete === false && <div className="ap-list-note" style={{color:"#875610",fontWeight:700}}>{t("Partial restore, not a complete one.")}</div>}
      {/* An unattended run is marked as one wherever it appears. It ran with
          nobody present and nobody approved it, and a reader must never have to
          infer that from the absence of an approver. */}
      {action.executionResult?.executionBasis === "unattended_schedule" && <div className="ap-list-note" style={{color:"#5f6b79"}}>{t("Ran unattended under a stored schedule. No person approved this run.")}</div>}
      {(action.executionResult?.outstanding || []).map((note, i) => <div className="ap-list-note" style={{color:"#875610"}} key={i}>{t("Still missing: {note}", { note: note })}</div>)}
      {confirming.id === action.id && <form className="ap-actions" style={{marginTop:7}} onSubmit={e=>{ e.preventDefault(); approveAction(action, confirming.text); }}>
        <span style={{fontSize:10.5,color:"#923a33",fontWeight:700}}>{t("Type {requiresconfirmtext} to approve", { requiresconfirmtext: action.requiresConfirmText })}</span>
        <input className="ap-input ap-mono" autoFocus style={{width:130,padding:"5px 8px"}} value={confirming.text} onChange={e=>setConfirming({ id:action.id, text:e.target.value })}/>
        <button className="ap-btn danger small" type="submit" disabled={confirming.text !== action.requiresConfirmText}>{t("Confirm approval")}</button>
        <button className="ap-btn small" type="button" onClick={()=>setConfirming({ id:null, text:"" })}>{t("Cancel")}</button>
      </form>}
    </div>
    <PanelBadge tone={actionTone(action.status)}>{action.status}</PanelBadge>
    <div className="ap-actions">
      {action.status === "pending" && confirming.id !== action.id && <><button className="ap-btn small" disabled={!!busy} onClick={()=>rejectAction(action)}>{t("Reject")}</button><button className={`ap-btn small ${action.requiresConfirmText?"danger":"primary"}`} disabled={!!busy} onClick={()=>approveAction(action)}>{t("Approve")}</button></>}
      {action.status === "approved" && <button className="ap-btn green small" disabled={!!busy} onClick={()=>executeAction(action)}>{busy===`execute-${action.id}` ? t("Working…") : t("Execute")}</button>}
    </div>
  </div>)}</div> : <div className="ap-empty"><PanelIcon name="check" size={25}/><strong>{emptyTitle}</strong><span>{emptyText}</span></div>;

  const jobFormProblem = scheduledJobFormProblem(jobForm);
  const visibleActions = filterControlActions(actions, { query:actionQuery, status:actionStatus });
  const actionStates = [...new Set(actions.map(action=>action.status).filter(Boolean))].sort();

  return <div className={`ap-shell ${standalone?"standalone":""}`}>
    <style>{PANEL_CSS}</style>
    {standalone&&<aside className="ap-sidebar">
      <div className="ap-sidebar-title">{"JotPanel"}</div>
      {/* Twenty screens is more than anybody holds in their head, and the name
          of a screen is rarely the word somebody arrives with. Typing narrows
          the whole sidebar, and Enter opens the first thing left. */}
      <div style={{padding:"8px 8px 4px"}}>
        <input
          className="ap-sidebar-search"
          value={navQuery}
          onChange={e=>setNavQuery(e.target.value)}
          onKeyDown={e=>{
            if(e.key==="Enter"&&navMatches[0]){setSection(navMatches[0]);setNavQuery("");}
            if(e.key==="Escape")setNavQuery("");
          }}
          placeholder={t("Search the panel")}
          aria-label={t("Search the panel")}
        />
      </div>
      {operatorNav.map(group=>{
        const rows=group.rows.filter(([id])=>navMatches.includes(id));
        if(!rows.length)return null;
        return <div key={group.label}><div className="ap-sidebar-group">{group.label}</div>{rows.map(([id,label])=><button key={id} className={section===id?"active":""} onClick={()=>{setSection(id);setNavQuery("");}}>{label}</button>)}</div>;
      })}
      {navQuery&&navMatches.length===0&&<div style={{padding:"10px 12px",fontSize:11,color:"#7f8d99",lineHeight:1.5}}>{t("Nothing here matches “{navquery}”.", { navquery: navQuery })}</div>}
      <div className="ap-sidebar-foot">{onSignOut&&<button onClick={onSignOut}>{t("Sign out")}</button>}</div>
    </aside>}
    <div className="ap-workspace">
    <header className="ap-topbar">
      {standalone ? <>
        {/* The machine's own numbers are the operator's. A customer gets their
            own account in that space instead of three permanent dashes. */}
        <div className="ap-machine-name">{operatorHere ? (machine?.hostname||t("Checking server")) : (user?.email||t("Signed in"))}<span className="ap-machine-platform">{operatorHere ? (machine?.platform||"") : t("your account")}</span></div>
        {operatorHere && <>
        <div className="ap-machine-metric"><span>{t("Load")}</span><strong>{machine?.load?.[0]??"—"} / {machine?.processors||"—"} CPU</strong></div>
        <div className="ap-machine-metric"><span>{t("Memory")}</span><strong>{machine?`${machine.memory.used_percent}% · ${panelFormatBytes(machine.memory.used_bytes)}`:"—"}</strong></div>
        <div className="ap-machine-metric"><span>{t("Disk")}</span><strong>{machine?t("{usedpercent}% · {count} free", { usedpercent: machine.disk.used_percent, count: panelFormatBytes(machine.disk.free_bytes) }):"—"}</strong></div>
        </>}
        <div className="ap-top-status"><span className={`ap-live-dot ${panelAvailable?"":"attention"}`}/><span>{panelAvailable?t("Ready"):t("Attention")}</span>{activeActions.length>0&&<button className="ap-review-pill" onClick={()=>setSection("activity")}>{t("{count} pending", { count: activeActions.length })}</button>}<button className="ap-refresh" disabled={loading} onClick={()=>refresh(false, true)} title={t("Refresh")}><PanelIcon name="refresh" size={13}/></button></div>
      </> : <>
      <button className="ap-home-brand" onClick={()=>setSection("overview")} aria-label={t("Open all hosting tools")}>
        <span className="ap-home-mark"><PanelIcon name="panel" color="#fff" size={20}/></span>
        <span><strong>{"JotPanel"}</strong><small>{t("This server")}</small></span>
      </button>
      {section === "overview" ? <label className="ap-tool-search"><PanelIcon name="search" size={16}/><input value={toolQuery} onChange={e=>setToolQuery(e.target.value)} placeholder={t("Find a hosting tool…")} aria-label={t("Find a hosting tool")}/>{toolQuery&&<button onClick={()=>setToolQuery("")} aria-label={t("Clear search")}>×</button>}</label> : <div className="ap-crumb"><button onClick={()=>setSection("overview")}><PanelIcon name="overview" size={14}/>{t("All tools")}</button><span>/</span><strong>{title}</strong></div>}
      <div className="ap-top-status"><span className={`ap-live-dot ${panelAvailable?"":"attention"}`}/><span>{panelAvailable?t("Server ready"):t("Needs attention")}</span>{activeActions.length>0&&<button className="ap-review-pill" onClick={()=>setSection("activity")}>{t("{count} waiting for you", { count: activeActions.length })}</button>}<button className="ap-refresh" disabled={loading} onClick={()=>refresh(false, true)} title={t("Check server now")}><PanelIcon name="refresh" size={14}/></button>{standalone && onSignOut && <button className="ap-signout" onClick={onSignOut}>{t("Sign out")}</button>}</div>
      </>}
    </header>
    <main className="ap-main">
      <div className="ap-content" ref={contentRef}><div className="ap-content-inner">
        {/* The standalone panel used to open on two tables while the grouped
            icon tiles were reserved for the desktop, which is backwards: the
            free panel is the one competing with DirectAdmin, and DirectAdmin
            opens on grouped tiles. Both shells get the same landing now, with
            the operator's snapshot first because a hosting operator wants the
            state of the machine before anything else. */}
        {section === "overview" && (false ? <>
          <div className="ap-card ap-operator-table"><div className="ap-card-head"><strong>{t("Server capabilities")}</strong><span>{serverCaps?t("{availablecount} available", { availablecount: serverCaps.available_count }):t("checking")}</span></div><div className="ap-table-wrap"><table className="ap-table"><thead><tr><th>{t("Area")}</th><th className="ap-state">{t("State")}</th><th>{t("Engine")}</th><th className="ap-row-action">{t("Actions")}</th></tr></thead><tbody>{(serverCaps?.sections||[]).filter(item=>item.id!=="console").map(item=><tr key={item.id}><td><strong>{item.title}</strong></td><td><PanelBadge tone={item.available?"ok":"warn"}>{item.available?t("available"):t("setup required")}</PanelBadge></td><td className="ap-mono">{item.capabilities.filter(cap=>cap.available).map(cap=>cap.backend).filter((value,index,list)=>list.indexOf(value)===index).join(" + ")||"—"}</td><td className="ap-row-action"><button className="ap-btn small" onClick={()=>setSection(item.id)}>{t("Open")}</button></td></tr>)}</tbody></table></div></div>
          <div className="ap-card ap-operator-table"><div className="ap-card-head"><strong>{t("Recent actions")}</strong><span>{actions.length}</span></div><div className="ap-table-wrap"><table className="ap-table"><thead><tr><th>{t("Action")}</th><th>{t("State")}</th><th>{t("Time")}</th><th className="ap-row-action">{t("Actions")}</th></tr></thead><tbody>{actions.slice(0,8).map(action=><tr key={action.id}><td><strong>{action.label}</strong></td><td><PanelBadge tone={actionTone(action.status)}>{action.status}</PanelBadge></td><td>{panelDate(action.createdAt,true)}</td><td className="ap-row-action"><button className="ap-btn small" onClick={()=>setSection("activity")}>{t("Review")}</button></td></tr>)}{!actions.length&&<tr><td colSpan="4" className="secondary">{t("No recorded actions")}</td></tr>}</tbody></table></div></div>
        </> : <>
          {/* Server facts first, the way every panel opens. A hosting operator
              wants the state of the machine before anything else, and a page
              that greets them with a headline reads as a brochure. */}
          <div className="ap-snapshot ap-snapshot-top">
            <div><span>{t("Account")}</span><strong>{user?.email || overview?.owner?.email || t("Owner")}</strong></div>
            <div><span>{t("Storage")}</span><strong>{panelFormatBytes(usage?.storage?.end_bytes)} <small>{t("of ")}{panelFormatBytes(usage?.storage?.quota_bytes)}</small></strong></div>
            <div><span>{t("Sites")}</span><strong>{(standalone ? serverSites.length : sites.length) || 0} <small>{certAttention?(certAttention===1 ? t("· {certattention} cert to check", { certattention: certAttention }) : t("· {certattention} certs to check", { certattention: certAttention })):t("· certificates clear")}</small></strong></div>
            <div><span>{t("Jobs")}</span><strong>{jobs.filter(j=>j.enabled).length}<small>{t(" of {count} enabled", { count: jobs.length })}</small></strong></div>
            <div><span>{t("Engine")}</span><strong>{(serverCaps?.engines||[]).map(e=>e.backend).join(" + ")||t("checking")}<small>{serverCaps?.engines?.[0]?.state?.platform?` · ${serverCaps.engines[0].state.platform}`:""}</small></strong></div>
            <div><span>{t("Server tools")}</span><strong>{serverCaps?t("{availablecount} of {count}", { availablecount: serverCaps.available_count, count: serverCaps.sections.length }):"—"}<small>{t(" available")}</small></strong></div>
            {/* Whether this box is registered is a fact about the installation,
                not about the account reading it. A customer was being told
                "Unregistered" about somebody else's machine, and would have gone
                on being told it however the box was really registered, because
                they are not allowed to read the answer. */}
            {operatorHere && <div><span>{t("Panel")}</span><strong>{license === undefined || license === null ? "—" : license.registered ? t("Registered · {count}", { count: license.status||"active" }) : t("Unregistered")}</strong></div>}
            <div className={`ap-snapshot-state ${certAttention || overview?.health?.failed_actions ? "warn" : "good"}`}>
              <span>{t("Status")}</span>
              <strong><PanelIcon name={certAttention || overview?.health?.failed_actions ? "alert" : "shield"} size={12}/> {certAttention || overview?.health?.failed_actions ? t("Needs attention") : t("All clear")}<small>{t(" · checked ")}{panelDate(overview?.checked_at, true)}</small></strong>
            </div>
          </div>
          {operatorHere && <div className="ap-card" style={{marginBottom:12}}>
            <div className="ap-card-head"><strong>{t("This machine")}</strong><span>{machine?.hostname||""}</span></div>
            <div className="ap-card-body">
              <PanelMeter label={t("Processor")} value={machine?.load?.[0]} of={machine?.processors} unit="load" tone={meterTone(machine?.load?.[0], machine?.processors)}/>
              <PanelMeter label={t("Memory")} percent={machine?.memory?.used_percent} note={machine?`${panelFormatBytes(machine.memory.used_bytes)} of ${panelFormatBytes(machine.memory.total_bytes)}`:""} tone={meterTone(machine?.memory?.used_percent,100)}/>
              <PanelMeter label={t("Disk")} percent={machine?.disk?.used_percent} note={machine?`${panelFormatBytes(machine.disk.free_bytes)} free`:""} tone={meterTone(machine?.disk?.used_percent,100)}/>
            </div>
          </div>}
          {visibleToolGroups.map(group=><section className="ap-tool-group" key={group.title}><div className="ap-group-heading"><div><h2>{group.title}</h2></div><span>{group.tools.length} {group.tools.length===1?t("tool"):t("tools")}</span></div>
            {!!group.tools.length&&<div className="ap-tool-grid">{group.tools.map(tool=><ControlToolButton key={tool.label} tool={tool} onOpen={openTool}/>)}</div>}
            {/* Not a disabled button. A tool the engine cannot serve is absent,
                and this says which piece is missing so it can be fixed. */}
            {!!group.blocked?.length&&<div className="ap-offlist"><h3>{t("Not on this server")}</h3>{group.blocked.map(entry=><div key={entry.id}><b>{entry.title}</b> — {serverUnavailableMessage(entry.id)}<ServerReason reason={entry.reason}/></div>)}</div>}
          </section>)}
          {!visibleToolGroups.length&&<div className="ap-no-tools"><ControlToolArt name="files" size={58}/><strong>{t("No tool matches “{toolquery}”", { toolquery: toolQuery })}</strong><span>{t("Try websites, mail, backup, statistics, usage or approval.")}</span><button className="ap-btn" onClick={()=>setToolQuery("")}>{t("Show all tools")}</button></div>}
        </>)}

        {section === "sites" && <><div className="ap-section-head"><div><h2>{t("Websites and certificates")}</h2><p>{t("A live TLS check is shown beside every site. “Healthy” is only shown after JotPanel verifies it.")}</p></div>{onOpenApp && <div className="ap-actions"><button className="ap-btn primary" onClick={()=>onOpenApp("sites")}><PanelIcon name="plus" size={14}/>{t("Manage sites")}</button></div>}</div><div className="ap-card"><SitesTable/></div></>}

        {section === "jobs" && <>
          <div className="ap-section-head"><div><h2>{t("Scheduled jobs")}</h2><p>{t("The note and command stay beside every schedule, with the full run history below.")}</p></div></div>
          <div className="ap-grid-2">
            <div className="ap-card">
              <div className="ap-card-head"><strong>{jobForm.id ? t("Propose changes") : t("Propose a scheduled job")}</strong><span>{t("approval required")}</span></div>
              <form className="ap-card-body" onSubmit={event=>{ event.preventDefault(); proposeJob(jobForm.id?"update":"create"); }}>
                <div className="ap-form">
                  <div className="ap-field"><label>{t("Name")}</label><input className="ap-input" value={jobForm.name} maxLength={120} onChange={e=>setJobForm(v=>({...v,name:e.target.value}))} placeholder={t("Nightly account backup")}/></div>
                  <div className="ap-field"><label>{t("Schedule")}</label><input className="ap-input ap-mono" value={jobForm.schedule} onChange={e=>setJobForm(v=>({...v,schedule:e.target.value}))} placeholder="0 3 * * *"/><small>{t("Five cron fields: minute, hour, day, month, weekday")}</small></div>
                  <div className="ap-field full"><label>{t("Note")}</label><input className="ap-input" value={jobForm.note} onChange={e=>setJobForm(v=>({...v,note:e.target.value}))} placeholder={t("Why this runs and who relies on it")} maxLength={500}/></div>
                  <div className="ap-field full"><label>{t("Command")}</label><input className="ap-input ap-mono" value={jobForm.command} maxLength={4000} onChange={e=>setJobForm(v=>({...v,command:e.target.value}))} placeholder="/usr/local/bin/backup-account"/><small>{t("Runs as the JotPanel service owner, inside the fixed jobs directory, with a 60-second limit.")}</small></div>
                  <label className="ap-check full"><input type="checkbox" checked={jobForm.enabled} onChange={e=>setJobForm(v=>({...v,enabled:e.target.checked}))}/>{t("Enable the schedule after the approved change is executed.")}</label>
                </div>
                <div className="ap-actions" style={{marginTop:13}}>
                  <button className="ap-btn primary" type="submit" disabled={!!busy||!!jobFormProblem}>{jobForm.id?t("Propose update"):t("Propose job")}</button>
                  {jobForm.id&&<button className="ap-btn" type="button" onClick={()=>setJobForm({id:null,name:"",note:"",schedule:"0 3 * * *",command:"",enabled:true})}>{t("Cancel")}</button>}
                  {jobFormProblem&&<span style={{fontSize:10.5,color:"#875610"}}>{jobFormProblem}</span>}
                </div>
              </form>
            </div>
            <div className="ap-card">
              <div className="ap-card-head"><strong>{t("What happens next")}</strong><span>{t("three visible steps")}</span></div>
              <div className="ap-card-body">
                <div className="ap-step"><span className="ap-step-num">1</span><div><strong>{t("Proposal")}</strong><p>{t("The name, note, schedule, and exact command are written to Activity.")}</p></div></div>
                <div className="ap-step"><span className="ap-step-num">2</span><div><strong>{t("Approval")}</strong><p>{t("You review and approve. Nothing has run at this point.")}</p></div></div>
                <div className="ap-step"><span className="ap-step-num">3</span><div><strong>{t("Verified execution")}</strong><p>{t("JotPanel reads the saved row back or records the run exit state. Failures stay visible.")}</p></div></div>
              </div>
            </div>
          </div>
          <div className="ap-card">
            <div className="ap-card-head"><strong>{t("Saved jobs")}</strong><span>{t("{count} total · {countvalue} enabled", { count: jobs.length, countvalue: jobs.filter(job=>job.enabled).length })}</span></div>
            {jobs.length?<div className="ap-table-wrap"><table className="ap-table"><thead><tr><th>{t("Job, note, and command")}</th><th>{t("Schedule")}</th><th>{t("Last run")}</th><th>{t("Actions")}</th></tr></thead><tbody>{jobs.map(job=>{
              const runStatus = job.running ? "running" : job.lastRun?.status;
              return <tr key={job.id}><td><strong>{job.name}</strong><div className="secondary">{job.note||t("No note has been added")}</div><div className="secondary ap-mono" title={job.command}>{job.command}</div></td><td><code>{job.schedule}</code><div className="secondary"><PanelBadge tone={job.enabled?"ok":"neutral"}>{job.enabled?t("enabled"):t("paused")}</PanelBadge></div></td><td><PanelBadge tone={scheduledJobRunTone(runStatus)}>{runStatus||t("never run")}</PanelBadge><div className="secondary">{job.running?t("Running now"):panelDate(job.lastRun?.finished_at,true)}</div></td><td><div className="ap-actions"><button className="ap-btn small" onClick={()=>editJob(job)}>{t("Edit")}</button><button className="ap-btn small" onClick={()=>viewJobHistory(job)}>{jobHistory.job?.id===job.id?t("Hide history"):t("History")}</button><button className="ap-btn small" disabled={!!busy||job.running} onClick={()=>proposeExistingJob(job,"run")}><PanelIcon name="play" size={11}/>{t("Run")}</button><button className="ap-btn danger small" disabled={!!busy||job.running} onClick={()=>proposeExistingJob(job,"delete")}>{t("Delete")}</button></div></td></tr>;
            })}</tbody></table></div>:<div className="ap-empty"><PanelIcon name="jobs" size={27}/><strong>{t("No scheduled jobs")}</strong><span>{t("Add the first one above. It will still require approval and execution.")}</span></div>}
          </div>
          {jobHistory.job&&<div className="ap-card" style={{marginTop:12}}>
            <div className="ap-card-head"><strong>{t("Run history: {name}", { name: jobHistory.job.name })}</strong><span>{t("most recent 50")}</span></div>
            {jobHistory.loading?<div className="ap-empty"><strong>{t("Reading run history")}</strong></div>:jobHistory.runs.length?<div className="ap-table-wrap"><table className="ap-table"><thead><tr><th>{t("Started")}</th><th>{t("Trigger")}</th><th>{t("State")}</th><th>{t("Finished")}</th><th>{t("Result")}</th></tr></thead><tbody>{jobHistory.runs.map(run=><tr key={run.id}><td>{panelDate(run.started_at,true)}</td><td>{run.trigger}</td><td><PanelBadge tone={scheduledJobRunTone(run.status)}>{run.status}</PanelBadge></td><td>{panelDate(run.finished_at,true)}</td><td><div className="secondary">{run.error||(t("Exit {count}", { count: run.exit_code ?? t("not recorded") }))}</div>{run.output&&<pre className="ap-logpane" style={{margin:"6px 0 0",maxHeight:150}}>{run.output}</pre>}</td></tr>)}</tbody></table></div>:<div className="ap-empty"><PanelIcon name="jobs" size={24}/><strong>{t("No runs recorded")}</strong><span>{t("This job has not finished a scheduled or manual run yet.")}</span></div>}
          </div>}
        </>}

        {/* Server operations. Mailboxes, upload accounts and DNS records used
            to live in a single "Accounts and records" form that proposed work
            the native engine could not carry out, so the proposal was accepted
            and the execution failed. They are now part of the screens below,
            each drawn only where the engine reports the capability. */}
        {section === "services" && <ServerServices ops={ops}/>}
        {section === "logs" && <ServerLogs ops={ops}/>}
        {section === "databases" && <ServerDatabases ops={ops}/>}
        {section === "backuphealth" && <ServerBackupHealth ops={ops}/>}
        {section === "backups" && <ServerBackups ops={ops}/>}
        {section === "mailadmin" && <ServerMailAdmin ops={ops}/>}
        {section === "mailauth" && <MailAuthentication ops={ops}/>}
        {section === "serversites" && <ServerSites ops={ops}/>}
        {section === "sitefiles" && <SiteFileManagerScreen ops={ops}/>}
        {section === "filesadmin" && <ServerFiles ops={ops}/>}
        {section === "dnszone" && <ServerDns ops={ops}/>}
        {section === "integrations" && <ServerIntegrations ops={ops}/>}
        {section === "backupdestinations" && <ServerBackupDestinations ops={ops}/>}
        {section === "admin" && <HosterAdminHandoff/>}
        {section === "security" && <ServerSecurity ops={ops}/>}
        {section === "migration" && <ServerMigration ops={ops}/>}
        {section === "console" && <ServerConsole ops={ops}/>}

        {/* Standalone only. Inside Arca these three are desktop windows, and
            openTool sends them there instead of here. A control panel that
            could not manage files, read mail or change its own settings would
            not be a control panel, so they are sections rather than absent. */}
        {section === "files" && <div className="ap-embed"><FilesApp/></div>}
        {section === "mail" && <div className="ap-embed"><MailApp/></div>}
        {section === "reseller" && <ResellerSection api={api}/>}
        {section === "twofactor" && <><PasskeySection api={api}/><RecoveryCodesSection api={api}/><TwoFactorSection api={api}/></>}
        {section === "connectai" && <ConnectAISection api={api}/>}
        {section === "echo" && <AskEchoSection goTo={setSection} onProposal={()=>refresh(true)} ops={ops}/>}
        {section === "settings" && <><PanelDomain ops={ops}/><LanguageChoice onChange={() => setLanguageTick(n => n + 1)} /><div className="ap-embed"><SettingsApp standalone installed={new Set()} onInstall={()=>{}} onUninstall={()=>{}}/></div></>}

        {section === "portability" && <><div className="ap-section-head"><div><h2>{t("Move and restore an account")}</h2><p>{t("The entire owner account travels as one ZIP. The package lists its contents; the restore lists exactly what came back.")}</p></div></div><div className="ap-callout good"><PanelIcon name="shield" size={20} color="#167362"/><div><strong>{t("Credentials stay protected in transit")}</strong><p>{t("You choose a passphrase when the approved export runs. Credentials are encrypted inside the package and never shown in Activity.")}</p></div></div><div className="ap-grid-even"><div className="ap-card"><div className="ap-card-head"><strong>{t("Download this account")}</strong><span>{t("JotNotes account ZIP")}</span></div><div className="ap-card-body"><div className="ap-step"><span className="ap-step-num">1</span><div><strong>{t("Propose")}</strong><p>{t("JotPanel records the request; no package is built yet.")}</p></div></div><div className="ap-step"><span className="ap-step-num">2</span><div><strong>{t("Approve and execute")}</strong><p>{t("Choose the passphrase. JotPanel verifies every listed entry before download.")}</p></div></div><button className="ap-btn primary" style={{marginTop:12}} disabled={!!busy} onClick={()=>run("export-propose",()=>api("/api/portability/export/propose",{method:"POST",body:"{}"}),t("Export proposed. Approve and execute it in Activity to build the ZIP.")).then(()=>setSection("activity")).catch(()=>{})}><PanelIcon name="download" size={14}/>{t("Propose account export")}</button></div></div><div className="ap-card"><div className="ap-card-head"><strong>{t("Restore or migrate in")}</strong><span>{t("ZIP, TAR, TAR.GZ")}</span></div><div className="ap-card-body"><p style={{fontSize:11.5,color:"#5d6a79",lineHeight:1.55,margin:"0 0 13px"}}>{t("Upload a JotNotes package, or a cPanel account archive. cPanel is not yet proved against a real cpmove file, and Plesk and DirectAdmin archives are not read at all. Inspection does not change this account.")}</p><label className="ap-btn primary" style={{cursor:busy?"default":"pointer"}}><PanelIcon name="upload" size={14}/>{busy==="inspect"?t("Inspecting…"):t("Choose archive to inspect")}<input type="file" accept=".zip,.tar,.gz,.tgz" hidden disabled={!!busy} onChange={inspectArchive}/></label></div></div></div>{inspection&&<div className="ap-card"><div className="ap-card-head"><strong>{t("Inspection report")}</strong><PanelBadge tone={["jotpanel","arca"].includes(inspection.source)?"ok":"info"}>{inspection.source==="arca"?t("Legacy JotNotes package"):inspection.source}</PanelBadge></div><div className="ap-card-body"><div className="ap-grid-even" style={{margin:0}}><div><div className="ap-list-title">{t("Detected package")}</div><div className="ap-list-note">{t("{count} · {countvalue} listed entries", { count: inspection.format==="arca-account"?t("Legacy JotNotes package"):(inspection.format||inspection.source), countvalue: inspection.entry_count||inspection.entries?.length||0 })}</div></div><div><div className="ap-list-title">{t("Before restore")}</div><div className="ap-list-note">{t("Review warnings below, then approve and execute the proposal in Activity.")}</div></div></div>{(inspection.warnings||[]).map((warning,i)=><div className="ap-callout warn" style={{margin:"10px 0 0"}} key={i}><PanelIcon name="alert" size={16}/><div><p>{warning}</p></div></div>)}</div></div>}</>}

        {section === "statistics" && <><div className="ap-section-head"><div><h2>{t("Web statistics")}</h2><p>{t("A clean view of verified visits, with no raw IP addresses retained.")}</p></div>{onOpenApp&&<div className="ap-actions"><button className="ap-btn" onClick={()=>onOpenApp("statistics")}>{t("Open as an app")}</button></div>}</div><StatisticsCoverage ops={ops}/><PanelStatistics data={stats}/></>}

        {section === "usage" && <><div className="ap-section-head"><div><h2>{t("Usage feed")}</h2><p>{t("One stable account-and-period record that any billing system can consume.")}</p></div><div className="ap-actions"><button className="ap-btn primary" disabled={busy==="usage-download"} onClick={downloadUsage}><PanelIcon name="download" size={14}/>{t("Download CSV")}</button></div></div><div className="ap-grid-4"><div className="ap-metric"><div className="ap-metric-top">{t("Storage now")}</div><div className="ap-metric-value">{panelFormatBytes(usage?.storage?.end_bytes)}</div><div className="ap-metric-note">{t("exact at ")}{panelDate(usage?.storage?.measured_at,true)}</div></div><div className="ap-metric"><div className="ap-metric-top">{t("Platform AI calls")}</div><div className="ap-metric-value">{usage?.assistant?.platform?.calls||0}</div><div className="ap-metric-note">{(usage?.assistant?.platform?.tokens||0).toLocaleString()}{t(" tokens")}</div></div><div className="ap-metric"><div className="ap-metric-top">{t("Customer-key calls")}</div><div className="ap-metric-value">{usage?.assistant?.customer_key?.calls||0}</div><div className="ap-metric-note">{t("not billable by JotNotes")}</div></div><div className="ap-metric"><div className="ap-metric-top">{t("Live service time")}</div><div className="ap-metric-value">{Math.floor((usage?.account_state?.live_seconds||0)/86400)}{t("d")}</div><div className="ap-metric-note">{t("inside this reporting period")}</div></div></div><div className="ap-card"><div className="ap-card-head"><strong>{t("Current reporting record")}</strong><span>{usage?.schema||"jotpanel-usage/v1"}</span></div><div className="ap-table-wrap"><table className="ap-table"><tbody><tr><th>{t("Period")}</th><td>{panelDate(usage?.period?.from)}{t(" to ")}{panelDate(usage?.period?.to)}</td></tr><tr><th>{t("Storage integration")}</th><td>{usage?.storage?.byte_hours==null?t("Waiting for a second hourly sample"):t("{count} byte-hours", { count: Number(usage.storage.byte_hours).toLocaleString() })}<div className="secondary">{usage?.storage?.note}</div></td></tr><tr><th>{t("Account state")}</th><td>{(usage?.account_state?.live_seconds||0).toLocaleString()}{t(" live seconds · ")}{(usage?.account_state?.suspended_seconds||0).toLocaleString()}{t(" suspended · ")}{(usage?.account_state?.closed_seconds||0).toLocaleString()}{t(" closed")}</td></tr><tr><th>{t("Customer AI key")}</th><td><PanelBadge tone="ok">{t("Separated")}</PanelBadge><div className="secondary">{t("Their provider key pays for their words; the feed never mixes that cost into JotNotes billing.")}</div></td></tr></tbody></table></div></div></>}

        {section === "license" && <><div className="ap-section-head"><div><h2>{t("Registration")}</h2><p>{t("The panel is complete without registration, and so is Echo when you bring your own AI key. Registration is free and connects this machine to the hosted assistant service.")}</p></div></div>{license?.registered?<div className={`ap-callout ${license.status==="active"?"good":license.status==="banned"?"bad":"warn"}`}><PanelIcon name={license.status==="active"?"shield":"alert"} size={20}/><div><strong>{license.status==="active"?t("Registered and active"):t("Registration {status}", { status: license.status })}</strong><p>{license.reason||license.message||t("The panel continues to work. Only Echo is affected.")}</p></div><PanelBadge tone={license.status==="active"?"ok":"bad"}>{license.status}</PanelBadge></div>:<div className="ap-grid-2"><div className="ap-card"><div className="ap-card-head"><strong>{t("Free, instant registration")}</strong><span>{t("machine-bound key")}</span></div><div className="ap-card-body"><div className="ap-field"><label>{t("Email address")}</label><input className="ap-input" type="email" value={registration.email} onChange={e=>setRegistration(v=>({...v,email:e.target.value}))} placeholder="you@example.com"/></div><label className="ap-check" style={{marginTop:13}}><input type="checkbox" checked={registration.newsletter_opt_in} onChange={e=>setRegistration(v=>({...v,newsletter_opt_in:e.target.checked}))}/><span>{t("We will email you about software updates and news.")}</span></label><button className="ap-btn primary" style={{marginTop:15}} disabled={!!busy||!registration.email} onClick={registerPanel}><PanelIcon name="license" size={14}/>{t("Register this panel")}</button></div></div><div className="ap-card"><div className="ap-card-head"><strong>{t("What registration changes")}</strong></div><div className="ap-card-body"><div className="ap-step"><span className="ap-step-num"><PanelIcon name="check" size={11}/></span><div><strong>{t("The hosted assistant is connected")}</strong><p>{t("Echo already answers with the AI key you add in Settings, registered or not. The key stays on this server.")}</p></div></div><div className="ap-step"><span className="ap-step-num"><PanelIcon name="check" size={11}/></span><div><strong>{t("Your panel keeps working")}</strong><p>{t("Suspension, revocation, or a service outage never disables websites, files, mail, jobs, or this panel.")}</p></div></div><div className="ap-step"><span className="ap-step-num"><PanelIcon name="check" size={11}/></span><div><strong>{t("No automatic marketing consent")}</strong><p>{t("The updates checkbox starts clear and is independent of registration.")}</p></div></div></div></div></div>}</>}

        {section === "activity" && credentials && <div className="ap-card" style={{marginBottom:12,borderColor:"#c8922a"}}>
          <div className="ap-card-head"><strong>{t("Written down now or not at all")}</strong><PanelBadge tone="warn">{t("shown once")}</PanelBadge></div>
          <div className="ap-card-body">
            <p style={{fontSize:11.5,color:"#5d6a79",lineHeight:1.55,margin:"0 0 12px"}}>{t("{label} generated these, because the archive it read carries password hashes this machine cannot reuse. They are in no record and nothing can show them again. Copy them somewhere before you leave this screen.", { label: credentials.label })}</p>
            <div className="ap-table-wrap"><table className="ap-table"><thead><tr><th>{t("What")}</th><th>{t("Login")}</th><th>{t("Password")}</th></tr></thead><tbody>
              {credentials.rows.map((row, i) => <tr key={i}><td>{row.what}</td><td className="ap-mono">{row.username}</td><td className="ap-mono" style={{userSelect:"all"}}>{row.password}</td></tr>)}
            </tbody></table></div>
            <div className="ap-actions" style={{marginTop:12}}><button className="ap-btn" onClick={()=>setCredentials(null)}>{t("I have written them down")}</button></div>
          </div>
        </div>}
        {section === "activity" && <>
          <div className="ap-section-head"><div><h2>{t("Activity and approval")}</h2><p>{t("Proposal, approval, execution, rejection, and failure are separate recorded states.")}</p></div></div>
          <div className="ap-callout"><PanelIcon name="shield" size={20}/><div><strong>{t("Approval does not execute")}</strong><p>{t("VACP™: approve after reading the proposal. Execute is a second deliberate step, and success appears only after JotPanel reads the result back.")}</p></div></div>
          <div className="ap-card">
            <div className="ap-card-head"><strong>{t("Account action record")}</strong><span>{t("{count} of {countvalue}", { count: visibleActions.length, countvalue: actions.length })}</span></div>
            <div className="ap-toolbar">
              <label htmlFor="activity-search">{t("Find")}</label>
              <input id="activity-search" className="ap-input" type="search" value={actionQuery} onChange={event=>setActionQuery(event.target.value)} placeholder={t("Action, resource, error, or ID")}/>
              <label htmlFor="activity-state">{t("State")}</label>
              <select id="activity-state" className="ap-input" value={actionStatus} onChange={event=>setActionStatus(event.target.value)}>
                <option value="all">{t("All states")}</option>
                {actionStates.map(state=><option key={state} value={state}>{state}</option>)}
              </select>
              {(actionQuery||actionStatus!=="all")&&<button className="ap-btn small spacer" onClick={()=>{setActionQuery("");setActionStatus("all");}}>{t("Clear filters")}</button>}
            </div>
            <ActionList rows={visibleActions} emptyTitle={actions.length?t("No matching actions"):t("No actions to review")} emptyText={actions.length?t("Clear or change the filters to see the rest of the record."):t("Every proposed, rejected, completed, and failed action will be kept here.")}/>
          </div>
        </>}
        {notice&&<div className={`ap-notice ${notice.error?"error":""}`}>{notice.text}</div>}
      </div></div>
    </main>
    </div>
  </div>;
}


// ── Small helpers ─────────────────────────────────────────────────────────────
export const btnS = dBtn; // alias — old code still works

// ── Admin + Reseller Interface ─────────────────────────────────────────────────
// ── The hoster console overview ────────────────────────────────────────
// The screen that answers "what do I see" for whoever runs the box. Two
// sources, both real: /admin/ops for the machine and /admin/tenants for the
// business on it. Nothing here is illustrative. Where a capability does not
// exist yet, the tile says so in the same voice it would report a number,
// because a console that implies licensing it does not have is the one thing
// a hoster will catch in the first five minutes.
// The console is reached by being signed in as the account that runs the box.
// It used to be reached by pasting a shared key into local storage, which is a
// password rather than an identity: it protects everything equally for anybody
// holding it, it cannot be revoked for one person, and the audit log could not
// say who used it. The second argument is kept so existing call sites read the
// same, and is ignored.
async function adminApiRequest(path, _unusedKey, opts = {}) {
  const response = await fetch((readPanelStorage("server") || "") + path, {
    ...opts,
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${readPanelStorage("jwt")||""}`, ...(opts.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || t("Admin request failed ({status})", { status: response.status }));
    error.status = response.status;
    throw error;
  }
  return data;
}

export const ADMIN_CSS = `
  .jotpanel-admin{height:100%;display:flex;min-width:0;background:var(--os-win);color:var(--os-txt);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .jotpanel-admin *{box-sizing:border-box;border-radius:0!important}
  .ad-sidebar{width:190px;flex:0 0 190px;display:flex;flex-direction:column;background:#17212b;color:#d9e0e7;border-right:1px solid #0c151d;overflow:auto}
  .ad-brand{min-height:52px;padding:10px 12px;border-bottom:1px solid #2a3742;display:flex;align-items:center;gap:9px}
  .ad-brand-mark{width:26px;height:26px;border:1px solid #52728a;display:flex;align-items:center;justify-content:center;color:#8ab5d0;flex:0 0 26px}
  .ad-brand strong{display:block;color:#fff;font-size:12px;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ad-brand span{display:block;color:#82919e;font-size:8.5px;text-transform:uppercase;letter-spacing:.1em;margin-top:2px}
  .ad-nav-group{padding:11px 10px 4px;color:#7f8d99;font-size:8.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
  .ad-nav{appearance:none;width:100%;border:0;border-left:3px solid transparent;background:transparent;color:#b9c4ce;padding:8px 11px;display:flex;align-items:center;gap:8px;text-align:left;font:650 11px/1.2 inherit;cursor:pointer}.ad-nav:hover{background:#202d38;color:#fff}.ad-nav.active{background:#263744;border-left-color:#64a0c4;color:#fff}
  .ad-sidebar-foot{margin-top:auto;padding:8px;border-top:1px solid #2a3742}
  .ad-workspace{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--os-win)}
  .ad-topbar{height:52px;flex:0 0 52px;padding:0 14px;border-bottom:1px solid var(--os-border);background:var(--os-bar);display:flex;align-items:center;gap:12px}
  .ad-title small{display:block;color:var(--os-txt3);font-size:8.5px;text-transform:uppercase;letter-spacing:.09em;font-weight:800}.ad-title strong{display:block;color:var(--os-txt);font-size:13px;margin-top:2px}
  .ad-state{margin-left:auto;display:flex;align-items:center;gap:7px;color:var(--os-txt2);font-size:10.5px}.ad-state-dot{width:7px;height:7px!important;border-radius:50%!important;background:#34a77b}.ad-state-dot.bad{background:#d05f55}
  .ad-body{flex:1;min-height:0;overflow:auto;padding:14px}
  @media(max-width:700px){
    .jotpanel-admin{flex-direction:column}.ad-sidebar{width:auto;flex:0 0 auto;overflow-x:auto;overflow-y:hidden;display:block;white-space:nowrap;border-right:0;border-bottom:1px solid #0c151d}.ad-brand,.ad-nav-group,.ad-sidebar-foot{display:none}.ad-sidebar>nav{display:flex}.ad-nav{width:auto;display:inline-flex;border-left:0;border-bottom:2px solid transparent;padding:10px 12px}.ad-nav.active{border-left:0;border-bottom-color:#64a0c4}.ad-topbar{height:46px;flex-basis:46px}.ad-body{padding:10px}
  }
`;

function AdminOverview({ aApi }) {
  const [ops, setOps]     = useState(null);
  const [biz, setBiz]     = useState(null);
  const [err, setErr]     = useState("");
  const [busy, setBusy]   = useState(true);
  const [sort, setSort]   = useState("spend");

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const [o, b] = await Promise.all([aApi("/admin/ops"), aApi("/admin/tenants")]);
      if (o && o.error) throw new Error(o.error);
      if (b && b.error) throw new Error(b.error);
      setOps(o); setBiz(b);
    } catch (e) { setErr(e.message || t("Could not read the console")); }
    setBusy(false);
  }, [aApi]);

  useEffect(() => { load(); }, [load]);

  const SEV = { critical: "#f87171", warn: "#f59e0b", info: "#60a5fa" };
  const VERDICT = { "attention needed": "#f87171", watch: "#f59e0b", healthy: "#34d399" };
  const money = n => "$" + (Number(n) || 0).toFixed(n >= 100 ? 0 : 2);
  const ago = ts => {
    if (!ts) return t("never");
    const h = (Date.now() - Date.parse(ts.replace(" ", "T") + (ts.endsWith("Z") ? "" : "Z"))) / 3600000;
    if (!isFinite(h)) return t("unknown");
    if (h < 1) return t("just now");
    if (h < 48) return t("{hours}h ago", { hours: Math.round(h) });
    return t("{days}d ago", { days: Math.round(h / 24) });
  };

  const C = {
    wrap:  { display: "flex", flexDirection: "column", gap: 14 },
    row:   { display: "grid", gap: 10 },
    card:  { background: OS.panel, border: `1px solid ${OS.border}`, borderRadius: 10, padding: "12px 14px" },
    label: { fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: OS.txt3, marginBottom: 6 },
    big:   { fontSize: 22, fontWeight: 600, color: OS.txt, lineHeight: 1.1, fontFamily: "monospace" },
    sub:   { fontSize: 11, color: OS.txt3, marginTop: 4 },
    h:     { fontSize: 12, fontWeight: 600, color: OS.txt, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 },
    th:    { fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em", color: OS.txt3, padding: "0 8px 6px", textAlign: "left" },
    td:    { fontSize: 11.5, color: OS.txt2, padding: "7px 8px", borderTop: `1px solid ${OS.border}` },
    pill:  (c) => ({ padding: "2px 7px", borderRadius: 8, fontSize: 10, fontWeight: 600, background: c + "18", color: c, border: `1px solid ${c}33`, whiteSpace: "nowrap" }),
    none:  { fontSize: 11.5, color: OS.txt3, fontStyle: "italic" },
  };

  if (busy && !ops) return <div style={{ padding: 24, fontSize: 12, color: OS.txt3 }}>{t("Reading the box…")}</div>;
  if (err) return <div style={{ padding: 24, fontSize: 12, color: "#f87171" }}>{err}</div>;

  const f = (biz && biz.fleet) || {};
  const c = (biz && biz.commerce) || {};
  const tenants = ((biz && biz.tenants) || []).slice().sort((a, b) =>
    sort === "spend" ? b.ai_month.cost_usd - a.ai_month.cost_usd
    : sort === "storage" ? b.storage.used_mb - a.storage.used_mb
    : String(b.last_seen || "").localeCompare(String(a.last_seen || "")));

  return (
    <div style={C.wrap}>
      {/* Verdict banner — the one line a hoster reads before anything else. */}
      <div style={{ ...C.card, display: "flex", alignItems: "center", gap: 12,
                    borderColor: (VERDICT[ops?.verdict] || OS.border) + "55" }}>
        <div style={{ width: 8, height: 8, borderRadius: 8, background: VERDICT[ops?.verdict] || OS.txt3, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: VERDICT[ops?.verdict] || OS.txt }}>
            {ops?.verdict === "healthy" ? t("Everything is answering") : ops?.verdict === "watch" ? t("Watch this") : t("Attention needed")}
          </div>
          <div style={{ fontSize: 11, color: OS.txt3 }}>{t("{uptimedays}d uptime \u00b7 load {load} on {cores} cores \u00b7{count}{memusedpct}% memory \u00b7 {diskusedpct}% disk \u00b7{countvalue}TLS {countvaluevalue}", { uptimedays: ops?.host?.uptime_days, load: ops?.host?.load1, cores: ops?.host?.cores, count: " ", memusedpct: ops?.host?.mem_used_pct, diskusedpct: ops?.host?.disk_used_pct, countvalue: " ", countvaluevalue: ops?.tls?.days_remaining == null ? t("unreadable") : ops.tls.days_remaining + "d" })}</div>
        </div>
        <button onClick={load} style={{ ...dBtn(false), fontSize: 11 }}>{t("Recheck")}</button>
      </div>

      {/* The five numbers the business runs on. */}
      <div style={{ ...C.row, gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
        <div style={C.card}>
          <div style={C.label}>{t("Accounts")}</div>
          <div style={C.big}>{f.accounts ?? "—"}</div>
          <div style={C.sub}>{t("{count} active in 30d · {countvalue} suspended", { count: f.active_30d ?? 0, countvalue: f.suspended ?? 0 })}</div>
        </div>
        <div style={C.card}>
          <div style={C.label}>{t("AI cost this month")}</div>
          <div style={{ ...C.big, color: "#34d399" }}>{money(f.ai_month_cost_usd)}</div>
          <div style={C.sub}>{(f.ai_month_tokens || 0).toLocaleString()}{t(" tokens on the platform key")}</div>
        </div>
        <div style={C.card}>
          <div style={C.label}>{t("Billed at {count}", { count: c.markup_pct == null ? t("no markup set") : c.markup_pct + "% markup" })}</div>
          <div style={{ ...C.big, color: "#c9a84c" }}>{money(c.billed_amount_usd)}</div>
          <div style={C.sub}>{t("margin ")}{money((c.billed_amount_usd || 0) - (f.ai_month_cost_usd || 0))}</div>
        </div>
        <div style={C.card}>
          <div style={C.label}>{t("Storage")}</div>
          <div style={C.big}>{Math.round(f.storage_used_mb || 0)}<span style={{ fontSize: 12, color: OS.txt3 }}>MB</span></div>
          <div style={C.sub}>{t("{count} sites · {countvalue} db · {countvaluevalue} mail · {countvaluevaluevalue} backups · panel db {dbmb}MB", { count: f.sites ?? 0, countvalue: f.databases ?? 0, countvaluevalue: f.mailboxes ?? 0, countvaluevaluevalue: f.backups ?? 0, dbmb: ops?.data?.db_mb })}</div>
        </div>
        <div style={C.card}>
          <div style={C.label}>{t("Local model")}</div>
          <div style={{ ...C.big, fontSize: 15 }}>
            {ops?.resident?.available ? (ops.resident.accel || "cpu").toUpperCase() : "DOWN"}
          </div>
          <div style={C.sub}>{t("{count} \u00b7 {countvalue} calls 24h{countvaluevalue}", { count: ops?.resident?.model || t("no model"), countvalue: ops?.ai?.calls_24h ?? 0, countvaluevalue: ops?.ai?.degradation_ratio ? t(" · {degradationratio}x under load", { degradationratio: ops.ai.degradation_ratio }) : "" })}</div>
        </div>
      </div>

      {/* Concerns, in the words the ops endpoint already writes them in. */}
      {!!(ops?.concerns || []).length && (
        <div style={C.card}>
          <div style={C.h}>{t("What wants attention")}</div>
          {ops.concerns.map((x, i) => (
            <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "6px 0",
                                  borderTop: i ? `1px solid ${OS.border}` : "none" }}>
              <span style={C.pill(SEV[x.severity] || OS.txt3)}>{x.severity}</span>
              <div>
                <div style={{ fontSize: 12, color: OS.txt }}>{x.what}</div>
                <div style={{ fontSize: 11, color: OS.txt3, marginTop: 2 }}>{x.why}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tenants, sorted by whatever the host is worried about today. */}
      <div style={C.card}>
        <div style={C.h}>{t("Accounts")}<div style={{ flex: 1 }} />
          {[["spend", t("by spend")], ["storage", t("by storage")], ["seen", t("by last seen")]].map(([k, l]) => (
            <span key={k} onClick={() => setSort(k)}
              style={{ fontSize: 10.5, cursor: "pointer", color: sort === k ? "#c9a84c" : OS.txt3 }}>{l}</span>
          ))}
        </div>
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {[t("Account"), t("Plan"), t("Last seen"), t("Sites"), t("Storage"), t("AI month"), t("State")].map(h => (
                <th key={h} style={C.th}>{h}</th>))}
            </tr></thead>
            <tbody>
              {tenants.slice(0, 60).map(tabId => (
                <tr key={tabId.id}>
                  <td style={C.td}>
                    <div style={{ color: OS.txt }}>{tabId.name}</div>
                    <div style={{ fontSize: 10, color: OS.txt3 }}>{tabId.email}</div>
                  </td>
                  <td style={C.td}>{tabId.plan}</td>
                  <td style={C.td}>{ago(tabId.last_seen)}</td>
                  <td style={C.td}>
                    <div>{tabId.sites}</div>
                    <div style={{ fontSize: 10, color: OS.txt3 }}>{t("{databases} db · {mailboxes} mail · {backups} bkp", { databases: tabId.databases, mailboxes: tabId.mailboxes, backups: tabId.backups })}</div>
                  </td>
                  <td style={C.td}>{tabId.storage.used_mb}MB <span style={{ color: OS.txt3 }}>/ {tabId.storage.quota_gb}GB</span>
                    {!!tabId.storage.unmeasured?.length && <span title={t("Could not be measured: {count}", { count: tabId.storage.unmeasured.join(', ') })} style={{ color: "#f59e0b", marginLeft: 4 }}>*</span>}
                  </td>
                  <td style={{ ...C.td, fontFamily: "monospace" }}>
                    {money(tabId.ai_month.cost_usd)}
                    {!!tabId.ai_month.byok_calls && <span style={{ color: OS.txt3, fontSize: 10 }}>{t(" +{byokcalls} byok", { byokcalls: tabId.ai_month.byok_calls })}</span>}
                  </td>
                  <td style={C.td}>
                    {tabId.suspended ? <span style={C.pill("#f87171")}>{t("suspended")}</span>
                     : tabId.ai_month.over_cap ? <span style={C.pill("#f59e0b")}>{t("over cap")}</span>
                     : <span style={C.pill("#34d399")}>{t("live")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!tenants.length && <div style={C.none}>{t("No accounts yet.")}</div>}
        </div>
      </div>

      {/* Provisioning and licensing, including the parts that do not exist. */}
      <div style={{ ...C.row, gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
        <div style={C.card}>
          <div style={C.h}>{t("Provisioning queue")}</div>
          <div style={{ fontSize: 11.5, color: OS.txt2, marginBottom: 6 }}>{t("Adapter ")}<span style={{ color: "#c9a84c" }}>{biz?.provisioning?.adapter}</span>
            {" · "}{Object.entries(biz?.provisioning?.counts || {}).map(([k, v]) => `${v} ${k}`).join(", ") || t("nothing queued")}
          </div>
          {(biz?.provisioning?.recent || []).map(a => (
            <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", fontSize: 11 }}>
              <span style={C.pill(a.status === "executed" ? "#34d399" : a.status === "pending" ? "#f59e0b" : OS.txt3)}>{a.status}</span>
              <span style={{ color: OS.txt2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.label}</span>
            </div>
          ))}
          <div style={{ ...C.sub, marginTop: 8 }}>{biz?.provisioning?.note}</div>
        </div>
        <div style={C.card}>
          <div style={C.h}>{t("Licensing")}</div>
          <div style={{ ...C.big, fontSize: 15, color: OS.txt3 }}>{t("None issued")}</div>
          <div style={{ ...C.sub, marginTop: 6 }}>{biz?.licensing?.note}</div>
        </div>
        <div style={C.card}>
          <div style={C.h}>{t("Who is knocking")}</div>
          <div style={{ fontSize: 11.5, color: OS.txt2 }}>
            {ops?.noise?.scanner_hits === "unreadable" ? t("Scanner log unreadable") : t("{scannerhits} scanner hits", { scannerhits: ops?.noise?.scanner_hits })}
            {" · "}
            {ops?.noise?.ssh_failures_24h === "unreadable" ? t("ssh journal unreadable") : t("{sshfailuresh} failed ssh in 24h", { sshfailuresh: ops?.noise?.ssh_failures_24h })}
          </div>
          <div style={{ ...C.sub, marginTop: 6 }}>{t("Backups: {count}", { count: ops?.data?.newest_backup_hours == null ? t("none have ever been taken") : t("newest is {newestbackuphours}h old", { newestbackuphours: ops.data.newest_backup_hours }) })}</div>
        </div>
      </div>

      {/* The audit tail, because every number above came from an action. */}
      <div style={C.card}>
        <div style={C.h}>{t("Latest activity")}</div>
        {(biz?.audit_recent || []).map((a, i) => (
          <div key={i} style={{ display: "flex", gap: 10, fontSize: 11, padding: "4px 0", color: OS.txt2 }}>
            <span style={{ color: OS.txt3, fontFamily: "monospace", flexShrink: 0 }}>{ago(a.ts)}</span>
            <span style={{ color: "#c9a84c", flexShrink: 0 }}>{a.action}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.details || ""}</span>
          </div>
        ))}
        {!(biz?.audit_recent || []).length && <div style={C.none}>{t("Nothing recorded yet.")}</div>}
      </div>
    </div>
  );
}

// Host administration moved out of this panel and onto its own address.
//
// It used to be drawn here, inside the screens a customer uses, which made
// "may this account see the machine's business" look like a question about
// which window is open. It is a question about who signed in, so it is asked
// somewhere that has nothing else on it. This is the way out, not a copy: a
// second copy would be a second thing to keep true.
function HosterAdminHandoff() {
  const [me, setMe] = useState(null);
  useEffect(() => {
    let live = true;
    adminApiRequest('/api/me').then(who => { if (live) setMe(who); }).catch(() => { if (live) setMe(false); });
    return () => { live = false; };
  }, []);
  return (
    <div style={{padding:22,maxWidth:560}}>
      <h2 style={{fontSize:15,margin:"0 0 6px"}}>{t("Host administration has its own surface")}</h2>
      <p style={{fontSize:12.5,color:"#5d6a79",lineHeight:1.6,margin:"0 0 16px"}}>{t("Accounts on this server, backup health across all of them, the audit record, this installation's licence and the platform settings are administered at their own address rather than inside the panel a customer uses.")}</p>
      {me === null && <div style={{fontSize:12,color:"#5d6a79"}}>{t("Checking your account…")}</div>}
      {me === false && <div style={{fontSize:12,color:"#5d6a79"}}>{t("Your account could not be read just now.")}</div>}
      {me && !me.is_operator && (
        <div role="alert" style={{fontSize:12,color:"#5d6a79",lineHeight:1.6}}>{t("It belongs to the account that runs this server, and this one is not it.")}</div>
      )}
      {me && me.is_operator && (
        <a className="ap-btn primary" href="/hoster" style={{display:"inline-flex",alignItems:"center",gap:7,textDecoration:"none"}}>
          <PanelIcon name="server" size={14}/>{t("Open host administration")}</a>
      )}
    </div>
  );
}

export function AdminApp() {
  const [tab, setTab]           = useState("overview");
  const [users, setUsers]       = useState([]);
  const [audit, setAudit]       = useState([]);
  const [auditQuery, setAuditQuery] = useState("");
  const [auditAction, setAuditAction] = useState("all");
  const [platform, setPlatform] = useState({ label:"", platformKeySet:false, markup:20, byok:true });
  // No key, and nothing stored. Access is a question about the signed-in
  // account, asked of the server on every load, so it cannot go stale in a
  // browser and there is nothing here worth stealing.
  const [adminKey, setAdminKey] = useState("");
  const [authed, setAuthed]     = useState(null);   // null while the answer is still unknown
  const [status, setStatus]     = useState("");
  const [statusError, setStatusError] = useState(false);
  const [loading, setLoading]   = useState(false);

  const aApi = useCallback((path, opts={}) => adminApiRequest(path, adminKey, opts), [adminKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await adminApiRequest("/api/me");
        if (cancelled) return;
        setAuthed(!!me.is_operator);
        if (!me.is_operator) setStatus(t("Signed in as {email}, which is not the account that runs this box.", { email: me.email }));
      } catch (error) {
        if (cancelled) return;
        setAuthed(false);
        setStatus(error.status === 401 ? t("Sign in to reach this.") : error.message);
        setStatusError(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loseAdminSession = useCallback(message => {
    setAuthed(false); setStatus(message); setStatusError(true);
  }, []);

  const loadTab = useCallback(async tabId => {
    setLoading(true); setStatus(""); setStatusError(false);
    try {
      if (tabId==="users") { const data=await aApi("/admin/api/accounts"); if(!Array.isArray(data))throw new Error(t("The accounts response was not a list.")); setUsers(data); }
      if (tabId==="audit") { const data=await aApi("/admin/api/audit?limit=500"); if(!Array.isArray(data))throw new Error(t("The audit response was not a list.")); setAudit(data); }
      if (tabId==="platform") {
        const data=await aApi("/api/platform/config");
        setPlatform({ label:data.label||"", platformKeySet:!!data.platformKey, markup:Number(data.markup)||0, byok:data.byok!==false });
      }
    } catch (error) {
      if (error.status === 403) loseAdminSession(t("Admin access expired or the key changed."));
      else { setStatus(error.message); setStatusError(true); }
    } finally { setLoading(false); }
  }, [aApi, loseAdminSession]);

  useEffect(()=>{ if (authed) loadTab(tab); },[authed,tab,loadTab]);

  const visibleAudit = useMemo(() => filterAuditRows(audit, { query:auditQuery, action:auditAction }), [audit, auditQuery, auditAction]);
  const auditActions = useMemo(() => [...new Set(audit.map(row=>row.action).filter(Boolean))].sort(), [audit]);
  const downloadAudit = () => {
    const blob = new Blob(["\ufeff", auditRowsToCsv(visibleAudit)], { type:"text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href=href; link.download=`jotpanel-audit-${new Date().toISOString().slice(0,10)}.csv`; link.click();
    setTimeout(()=>URL.revokeObjectURL(href),1000);
    setStatus((visibleAudit.length===1 ? t("Downloaded {count} audit row.", { count: visibleAudit.length }) : t("Downloaded {count} audit rows.", { count: visibleAudit.length }))); setStatusError(false);
  };

  const S = {
    tr:   { display:"flex", alignItems:"center", gap:10, padding:"7px 10px", background:OS.panel, border:`1px solid ${OS.border}`, marginBottom:4, fontSize:12 },
    badge:(c)=>({ padding:"2px 7px", fontSize:10, fontWeight:600, background:c+"18", color:c, border:`1px solid ${c}33` }),
    inp:  { background:OS.inpBg, border:`1px solid ${OS.border}`, color:OS.txt, fontSize:12, padding:"5px 10px", outline:"none", width:"100%" },
  };
  const ADMIN_NAV = [
    { label:t("Monitor"), rows:[["overview","overview",t("Overview")],["users","user",t("Accounts")],["audit","activity",t("Audit record")]] },
    { label:t("Configure"), rows:[["platform","settings",t("Platform")]] },
  ];
  const ADMIN_TITLES = { overview:t("Overview"), users:t("Accounts"), audit:t("Audit record"), platform:t("Platform") };

  if (authed === null) return (
    <div className="jotpanel-admin" style={{alignItems:"center",justifyContent:"center"}}><style>{ADMIN_CSS}</style>
      <div style={{fontSize:12,color:OS.txt3}}>{t("Checking access…")}</div></div>
  );

  // Refused, and it says which account was refused rather than offering a box
  // to type something into. There is nothing to type: the answer is who you are.
  if (!authed) return (
    <div className="jotpanel-admin" style={{alignItems:"center",justifyContent:"center"}}><style>{ADMIN_CSS}</style><div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,width:280,border:`1px solid ${OS.border}`,padding:22,background:OS.panel}}>
      <PanelIcon name="license" size={24} color={OS.txt3}/>
      <div style={{fontSize:13,color:OS.txt2}}>{t("Admin access")}</div>
      <div style={{fontSize:11,color:OS.txt3,textAlign:"center",lineHeight:1.6}}>{t("This is the hoster console. It belongs to the account that runs this server.")}</div>
      {status && <div role={statusError?"alert":"status"} style={{fontSize:11,color:statusError?"#f87171":OS.txt3,textAlign:"center"}}>{status}</div>}
    </div></div>
  );

  return (
    <div className="jotpanel-admin">
      <style>{ADMIN_CSS}</style>
      <aside className="ad-sidebar" aria-label={t("Host administration")}>
        <div className="ad-brand"><div className="ad-brand-mark"><PanelIcon name="server" size={15}/></div><div style={{minWidth:0}}><strong>{platform.label||"JotNotes"}</strong><span>{t("Host admin")}</span></div></div>
        <nav>
          {ADMIN_NAV.map(group=><div key={group.label}>
            <div className="ad-nav-group">{group.label}</div>
            {group.rows.map(([id,icon,label])=><button key={id} className={`ad-nav ${tab===id?"active":""}`} onClick={()=>setTab(id)} aria-current={tab===id?"page":undefined}><PanelIcon name={icon} size={14}/>{label}</button>)}
          </div>)}
        </nav>
        <div className="ad-sidebar-foot"><button className="ad-nav" onClick={()=>{setAuthed(false);setAdminKey("");setStatus("");setStatusError(false);}}><PanelIcon name="close" size={14}/>{t("Sign out")}</button></div>
      </aside>
      <main className="ad-workspace">
        <header className="ad-topbar">
          <div className="ad-title"><small>{t("Host administration")}</small><strong>{ADMIN_TITLES[tab]}</strong></div>
          <div className="ad-state" role={statusError?"alert":"status"}><span className={`ad-state-dot ${statusError?"bad":""}`}/><span>{status||t("Admin key active")}</span></div>
        </header>
        <div className="ad-body">
        {loading && tab!=="overview" && <div style={{color:OS.txt3,fontSize:12,textAlign:"center",paddingTop:20}}>{t("Loading…")}</div>}

        {tab==="overview" && <AdminOverview aApi={aApi} />}

        {tab==="users" && !loading && (
          <div>
            <div style={{fontSize:11.5,color:OS.txt2,background:OS.panel,border:`1px solid ${OS.border}`,borderLeft:"4px solid #c8922a",padding:"9px 11px",marginBottom:10,lineHeight:1.5}}><strong style={{display:"block",color:OS.txt,marginBottom:2}}>{t("Account changes are not offered from this screen")}</strong>{t("Suspend, restore, sign-in handoff, and delete return when those host actions use proposal, approval, execution, and the durable record. The current backend routes write directly, so this view stays read-only.")}</div>
            <div style={{marginBottom:12,fontSize:12,color:OS.txt2}}>{(users.length!==1 ? t("{count} accounts", { count: users.length }) : t("{count} account", { count: users.length }))}</div>
            {users.map(u=>(
              <div key={u.id} style={S.tr}>
                <div style={{width:28,height:28,borderRadius:"50%",background:"#2a5bd722",border:"1px solid #2a5bd755",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#93c5fd",fontWeight:700,flexShrink:0}}>
                  {(u.name||u.email||"?").slice(0,2).toUpperCase()}
                </div>
                <div style={{flex:1,overflow:"hidden"}}>
                  <div style={{color:OS.txt,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.name||t("Unnamed account")}</div>
                  <div style={{color:OS.txt3,fontSize:10}}>{u.email}</div>
                </div>
                <span style={S.badge(u.plan==="pro"?"#c9a84c":"#6b7280")}>{u.plan}</span>
                {u.suspended ? <span style={S.badge("#f87171")}>{t("suspended")}</span> : <span style={S.badge("#4ade80")}>{t("active")}</span>}
              </div>
            ))}
          </div>
        )}

        {tab==="audit" && !loading && (
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",padding:"9px 10px",background:OS.panel,border:`1px solid ${OS.border}`,marginBottom:10}}>
              <input type="search" aria-label={t("Search audit rows")} value={auditQuery} onChange={event=>setAuditQuery(event.target.value)} placeholder={t("Account, action, detail, or IP")} style={{...S.inp,flex:"1 1 220px",width:"auto"}}/>
              <select aria-label={t("Filter audit action")} value={auditAction} onChange={event=>setAuditAction(event.target.value)} style={{...S.inp,width:"auto",maxWidth:220}}>
                <option value="all">{t("All actions")}</option>
                {auditActions.map(action=><option key={action} value={action}>{action}</option>)}
              </select>
              {(auditQuery||auditAction!=="all")&&<button onClick={()=>{setAuditQuery("");setAuditAction("all");}} style={{...dBtn(),fontSize:10}}>{t("Clear")}</button>}
              <button onClick={()=>loadTab("audit")} style={{...dBtn(),fontSize:10}}>{t("Reload")}</button>
              <button onClick={downloadAudit} disabled={!visibleAudit.length} style={{...dBtn(true),fontSize:10}}>{t("Download CSV")}</button>
              <span style={{fontSize:10.5,color:OS.txt3}}>{t("{count} of {countvalue} rows", { count: visibleAudit.length, countvalue: audit.length })}</span>
            </div>
            {visibleAudit.length?<div style={{overflowX:"auto",border:`1px solid ${OS.border}`}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead><tr>{[t("Time"),t("Action"),t("Account"),t("Detail"),t("IP address")].map(label=><th key={label} style={{textAlign:"left",fontSize:9.5,textTransform:"uppercase",letterSpacing:".06em",color:OS.txt3,padding:"7px 9px",borderBottom:`1px solid ${OS.border}`,whiteSpace:"nowrap"}}>{label}</th>)}</tr></thead>
              <tbody>{visibleAudit.map((row,index)=><tr key={row.id||`${row.ts}-${index}`} style={{background:index%2?OS.panel:"transparent"}}>
                <td style={{padding:"7px 9px",color:OS.txt3,whiteSpace:"nowrap",verticalAlign:"top",fontFamily:"monospace"}}>{row.ts||t("Not recorded")}</td>
                <td style={{padding:"7px 9px",color:"#c9a84c",whiteSpace:"nowrap",verticalAlign:"top",fontFamily:"monospace"}}>{row.action||t("unknown")}</td>
                <td style={{padding:"7px 9px",color:OS.txt2,whiteSpace:"nowrap",verticalAlign:"top",fontFamily:"monospace"}}>{row.user_id||t("system")}</td>
                <td style={{padding:"7px 9px",color:OS.txt2,minWidth:240,verticalAlign:"top",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{row.details||t("No detail recorded")}</td>
                <td style={{padding:"7px 9px",color:OS.txt3,whiteSpace:"nowrap",verticalAlign:"top",fontFamily:"monospace"}}>{row.ip||t("Not recorded")}</td>
              </tr>)}</tbody>
            </table></div>:<div style={{padding:24,textAlign:"center",fontSize:11.5,color:OS.txt3,border:`1px solid ${OS.border}`,background:OS.panel}}>{audit.length?t("No audit rows match these filters."):t("No audit activity has been recorded yet.")}</div>}
          </div>
        )}

        {tab==="platform" && !loading && (
          <div style={{maxWidth:620,display:"flex",flexDirection:"column",gap:12}}>
            <div style={{fontSize:11.5,color:OS.txt2,background:OS.panel,border:`1px solid ${OS.border}`,borderLeft:"4px solid #c8922a",padding:"9px 11px",lineHeight:1.5}}><strong style={{display:"block",color:OS.txt,marginBottom:2}}>{t("Platform configuration is read-only here")}</strong>{t("Editing returns when branding, provider keys, markup, and BYOK use proposal, approval, execution, and the durable record. The current PATCH route writes directly, so this screen reports the effective values without offering a Save button.")}</div>
            <div style={{overflowX:"auto",border:`1px solid ${OS.border}`}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11.5}}><tbody>
              {[
                [t("Platform label"),platform.label||t("Hosted AI")],
                [t("Platform AI key"),platform.platformKeySet?t("Configured"):t("Not configured")],
                [t("AI markup"),`${platform.markup||0}%`],
                [t("Customer provider keys"),platform.byok?t("Allowed"):t("Not allowed")],
              ].map(([label,value])=><tr key={label}><th style={{textAlign:"left",padding:"9px 10px",color:OS.txt3,borderBottom:`1px solid ${OS.border}`,width:190,fontSize:9.5,textTransform:"uppercase",letterSpacing:".06em"}}>{label}</th><td style={{padding:"9px 10px",color:OS.txt,borderBottom:`1px solid ${OS.border}`}}>{value}</td></tr>)}
            </tbody></table></div>
          </div>
        )}
        </div>
      </main>
    </div>
  );
}



// ── API PROVIDER MANAGER ─────────────────────────────────────────────────────
// À la carte: everything is off until someone adds a key, and nobody has to
// take the whole plate. `region` says where the inference happens so a tenant
// can screen on jurisdiction; REGIONS holds the label. New entries carry no
// `base` because the server owns every endpoint now (see PROVIDERS_META).
const REGIONS = {
  US:    { get label() { return t("United States"); }, short: "US" },
  EU:    { get label() { return t("European Union"); }, short: "EU" },
  CN:    { get label() { return t("China"); },          short: "CN" },
  local: { get label() { return t("Your machine"); },   short: "Local" },
};
// Transport only. What models exist, what they cost and what they can do now
// comes from the catalogue and from the customer's own key — see
// `useModelCatalogue`. These entries used to carry a `models` array each, and
// those arrays were the reason the panel went on offering gpt-4o and
// gemini-1.5-pro for two generations after they were superseded.
export const PROVIDERS = [
  { id: "anthropic", name: "Claude (Anthropic)", icon: "🟣", region: "US", base: "https://api.anthropic.com/v1/messages", headerKey: "x-api-key" },
  { id: "openai",    name: "ChatGPT (OpenAI)",   icon: "🟢", region: "US", base: "https://api.openai.com/v1/chat/completions", headerKey: "Authorization", headerPrefix: "Bearer " },
  { id: "groq",      name: "Groq",               icon: "⚡", region: "US", base: "https://api.groq.com/openai/v1/chat/completions", headerKey: "Authorization", headerPrefix: "Bearer " },
  { id: "gemini",    name: "Gemini (Google)",    icon: "🔵", region: "US", base: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", headerKey: "Authorization", headerPrefix: "Bearer " },
  { id: "mistral",   name: "Mistral",            icon: "🌊", region: "EU", base: "https://api.mistral.ai/v1/chat/completions", headerKey: "Authorization", headerPrefix: "Bearer " },
  { id: "deepseek",  name: "DeepSeek",           icon: "🐋", region: "CN", headerKey: "Authorization", headerPrefix: "Bearer " },
  { id: "moonshot",  name: "Kimi (Moonshot)",    icon: "🌙", region: "CN", headerKey: "Authorization", headerPrefix: "Bearer " },
  { id: "zhipu",     name: "GLM (Z.ai)",         icon: "🔷", region: "CN", headerKey: "Authorization", headerPrefix: "Bearer " },
  { id: "xai",       name: "Grok (xAI)",         icon: "🛰️", region: "US", base: "https://api.x.ai/v1/chat/completions", headerKey: "Authorization", headerPrefix: "Bearer " },
  { id: "ollama",    name: "Ollama (Local)",      icon: "🏠", region: "local", base: "http://localhost:11434/v1/chat/completions", headerKey: "Authorization", headerPrefix: "Bearer ", get localNote() { return t("No key needed — runs on your machine"); } },
  { id: "elevenlabs",name: "ElevenLabs (Voice)",  icon: "🎙️", region: "US", base: "https://api.elevenlabs.io/v1", headerKey: "xi-api-key", voiceOnly: true, get localNote() { return t("For Echo voice only — not used for chat"); } },
];

const LS_APIS = "aos_api_keys";

// ── Multi-model task router ───────────────────────────────────────────────────
// Task types: code | build | reason | chat | creative | summarize
// Each maps to an ordered list of [providerId, modelId] preferences.
// The router picks the first pair where the user has a valid API key.

const TASK_ROUTE_KEY = "aos_task_routes";

// Default routing — shipped with the app, overridden by the server table, and
// filtered at use to models the customer's key reaches and this panel has
// actually called. A preference naming a model that no longer exists is simply
// skipped, which is why these were quietly routing to gpt-4o and
// gemini-2.0-flash long after both were superseded: nothing failed loudly, the
// entry just never matched. Refreshed 2026-09-25 from the same provider
// documentation as control/modelCatalogue.json.
export const DEFAULT_ROUTES = {
  code:      [["openai","gpt-6-luna"],          ["groq","llama-3.3-70b-versatile"], ["anthropic","claude-haiku-4-5"],  ["ollama","codellama"]],
  build:     [["openai","gpt-6-sol"],           ["anthropic","claude-sonnet-5"],    ["groq","llama-3.3-70b-versatile"],["gemini","gemini-3.8-flash"]],
  reason:    [["anthropic","claude-sonnet-5"],  ["openai","gpt-6-astra"],           ["anthropic","claude-opus-5"],     ["xai","grok-4.7"]],
  chat:      [["groq","llama-3.3-70b-versatile"],["gemini","gemini-3.5-flash-lite"],["openai","gpt-6-luna"],           ["anthropic","claude-haiku-4-5"]],
  creative:  [["anthropic","claude-sonnet-5"],  ["openai","gpt-6-astra"],           ["xai","grok-4.7"],                ["gemini","gemini-3.8-flash"]],
  summarize: [["gemini","gemini-3.5-flash-lite"],["groq","llama-3.3-70b-versatile"],["anthropic","claude-haiku-4-5"],  ["openai","gpt-6-luna"]],
};

// Live routing table — fetched from server on load, falls back to DEFAULT_ROUTES
// Admin edits via PATCH /api/routing — all users get updates on next load
let _liveRoutes = null;
async function fetchLiveRoutes() {
  const jwt = readPanelStorage("jwt") || "";
  const srv = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
  try {
    const res = await fetch(`${srv}/api/routing`, { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} });
    if (res.ok) { _liveRoutes = await res.json(); }
  } catch {}
}
// Call on boot — non-blocking
fetchLiveRoutes();

export function getEffectiveRoutes() {
  return _liveRoutes || DEFAULT_ROUTES;
}

const TASK_LABELS = () => ({
  code:      { icon: "💻", label: t("Code generation"),    desc: t("Writing, editing, debugging code") },
  build:     { icon: "🔨", label: t("Website building"),   desc: t("Building pages, layouts, content") },
  reason:    { icon: "🧠", label: t("Reasoning"),          desc: t("Complex analysis, planning, decisions") },
  chat:      { icon: "💬", label: t("Conversation"),       desc: t("Echo chat, general questions") },
  creative:  { icon: "✍️", label: t("Creative writing"),   desc: t("Copy, stories, descriptions") },
  summarize: { icon: "📋", label: t("Summarise"),          desc: t("Condensing, extracting, quick answers") },
});

export function loadTaskRoutes() {
  try { return JSON.parse(localStorage.getItem(TASK_ROUTE_KEY) || "{}"); } catch { return {}; }
}
function saveTaskRoutes(r) { localStorage.setItem(TASK_ROUTE_KEY, JSON.stringify(r)); }



// ── Model pricing — $ per million tokens [input, output] ─────────────────────
const MODEL_PRICING = {
  // Anthropic
  "claude-opus-5":            [5,     25   ],
  "claude-opus-4-8":          [5,     25   ],
  "claude-opus-4-6":          [5,     25   ],
  "claude-opus-4-5":          [5,     25   ],
  "claude-sonnet-5":          [3,     15   ],
  "claude-sonnet-4-6":        [3,     15   ],
  "claude-sonnet-4-5":        [3,     15   ],
  "claude-haiku-4-5-20251001":[1,     5    ],
  "claude-haiku-4-5":         [1,     5    ],
  // OpenAI
  "gpt-4o":                   [2.5,   10   ],
  "gpt-4o-mini":              [0.15,  0.6  ],
  "gpt-4-turbo":              [10,    30   ],
  "o1-mini":                  [1.1,   4.4  ],
  // Groq (very cheap)
  "llama-3.3-70b-versatile":  [0.59,  0.79 ],
  "llama-3.1-70b-versatile":  [0.59,  0.79 ],
  "mixtral-8x7b-32768":       [0.24,  0.24 ],
  "gemma2-9b-it":             [0.2,   0.2  ],
  // Gemini
  "gemini-2.0-flash":         [0.1,   0.4  ],
  "gemini-1.5-pro":           [1.25,  5    ],
  "gemini-1.5-flash":         [0.075, 0.3  ],
  // Mistral
  "mistral-large-latest":     [2,     6    ],
  "mistral-medium-latest":    [0.4,   2    ],
  "open-mixtral-8x22b":       [2,     6    ],
  // Ollama — local, free
  "llama3.2":                 [0,     0    ],
  "mistral":                  [0,     0    ],
  "codellama":                [0,     0    ],
  "phi3":                     [0,     0    ],
};

// ── The model catalogue, as the panel sees it ─────────────────────────────────
//
// Three facts arrive together and are never flattened into one list:
//
//   documented — what the provider publishes about a model.
//   available  — what this customer's key actually reaches.
//   tested     — what this panel has actually called and got an answer from.
//
// The panel used to carry its own hard-coded arrays, which is why it offered
// gpt-4o and gemini-1.5-pro long after both were superseded: a literal in a
// bundle cannot go stale visibly, it just quietly stops being true.
let CATALOGUE_CACHE = null;

function useModelCatalogue() {
  const [state, setState] = useState(CATALOGUE_CACHE || { loading: true, providers: {}, asOf: null, error: null });
  const reload = useCallback(async () => {
    try {
      const data = await residentApiRequest("/api/ai/catalogue");
      const next = { loading: false, providers: data.providers || {}, asOf: data.as_of || null, error: null };
      CATALOGUE_CACHE = next;
      setState(next);
    } catch (error) {
      setState(s => ({ ...s, loading: false, error: error.message }));
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

// What the panel may put in front of somebody as a model they can pick.
// Availability comes from their key; being proved comes from a call that
// returned. A model nobody has proved is shown, and is not selectable until
// somebody presses Test on it — documented is not the same as working.
function offeredModels(catalogue, providerId) {
  const entry = catalogue.providers?.[providerId];
  if (!entry) return { models: [], state: "not-checked", reason: null, hasKey: false };
  return { models: entry.models || [], state: entry.state, reason: entry.reason || null, hasKey: !!entry.has_key };
}

// Cost tier for display (0–4 dots)
function modelTier(model) {
  const p = MODEL_PRICING[model];
  if (!p) return 2;
  const avg = (p[0] + p[1]) / 2;
  if (avg === 0)    return 0; // free
  if (avg < 0.5)   return 1; // cheap
  if (avg < 3)     return 2; // moderate
  if (avg < 10)    return 3; // expensive
  return 4;                  // premium
}

// Cost calculation
export function calcCost(model, inputTokens, outputTokens) {
  // An unknown model costs an unknown amount. Billing it at a Sonnet-ish guess
  // put a number nobody could source in front of somebody's spend; zero at
  // least reads as "not counted" rather than as a figure.
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  return (inputTokens / 1e6) * p[0] + (outputTokens / 1e6) * p[1];
}

// ── Cost store — persists across session, resets monthly ─────────────────────
const COST_KEY = "aos_cost_data";
export function loadCostData() {
  try {
    const d = JSON.parse(localStorage.getItem(COST_KEY) || "{}");
    // Reset if it's a new month
    const month = new Date().toISOString().slice(0, 7);
    if (d.month !== month) return { month, sessions: [], total: 0 };
    // Older entries kept the start of each message. The widget needs none of it.
    let scrubbed = false;
    for (const s of d.sessions || []) if (s.preview && !/^\d+ chars$/.test(s.preview)) { s.preview = ""; scrubbed = true; }
    if (scrubbed) localStorage.setItem(COST_KEY, JSON.stringify(d));
    return d;
  } catch { return { month: new Date().toISOString().slice(0, 7), sessions: [], total: 0 }; }
}
export function saveCostData(d) { localStorage.setItem(COST_KEY, JSON.stringify(d)); }

function recordCost(model, providerId, inputTok, outputTok, preview) {
  const cost = calcCost(model, inputTok, outputTok);
  if (cost === 0 && !preview) return; // don't record free/local
  const d = loadCostData();
  const entry = { ts: Date.now(), model, provider: providerId, in: inputTok, out: outputTok, cost, preview: preview || "" };
  d.sessions.push(entry);
  d.total = (d.total || 0) + cost;
  // Keep last 500 entries
  if (d.sessions.length > 500) d.sessions = d.sessions.slice(-500);
  saveCostData(d);
  // Notify CostWidget via custom event
  window.dispatchEvent(new CustomEvent("arca_cost", { detail: entry }));
}

// Provider keys live in the encrypted vault on the server, never in this
// browser. What stays here is which providers are connected, the model picked
// and the primary; none of that is a secret.
export function loadApiConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(LS_APIS) || "{}");
    for (const v of Object.values(cfg)) if (v && typeof v === "object") delete v.key;
    return cfg;
  } catch { return {}; }
}
function saveApiConfig(cfg) {
  const clean = {};
  for (const [id, v] of Object.entries(cfg || {})) {
    if (v && typeof v === "object") { const { key, ...rest } = v; clean[id] = rest; } else clean[id] = v;
  }
  localStorage.setItem(LS_APIS, JSON.stringify(clean));
}
function keyVault(path, options = {}) {
  const jwt = readPanelStorage("jwt") || "";
  const srv = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
  return fetch(`${srv}/api/ai/keys${path}`, { ...options, headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) } });
}
export async function storeProviderKey(providerId, key, label) {
  const res = await keyVault(`/${encodeURIComponent(providerId)}`, { method: "PUT", body: JSON.stringify({ key, ...(label ? { label } : {}) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const error = new Error(data.error || "The key could not be saved"); error.refused = true; throw error; }
  return data;
}
export async function removeProviderKey(providerId, label) {
  await keyVault(`/${encodeURIComponent(providerId)}${label ? `?label=${encodeURIComponent(label)}` : ""}`, { method: "DELETE" });
}
export async function listProviderKeys() {
  const res = await keyVault("");
  return res.ok ? ((await res.json()).keys || []) : [];
}
// Keys an older panel left in this browser are moved to the vault once and
// removed from here. A key the server refused is removed too; one that could
// not be sent because the network was down waits for the next try.
export async function moveBrowserKeysToVault() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(LS_APIS) || "{}"); } catch { return; }
  const own = localStorage.getItem("aos_hosting_own_key");
  if (own) {
    const id = own.startsWith("sk-ant-") ? "anthropic" : own.startsWith("sk-") ? "openai" : null;
    if (id && !raw[id]?.key) raw[id] = { ...(raw[id] || {}), key: own };
  }
  let changed = !!own, pending = false;
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object" || typeof v.key !== "string") continue;
    changed = true;
    try {
      if (v.key.trim()) { const saved = await storeProviderKey(id, v.key.trim()); raw[id] = { ...v, connected: true, fingerprint: saved.fingerprint }; }
      delete raw[id].key;
    } catch (e) {
      if (e.refused) delete raw[id].key; else pending = true;
    }
  }
  if (!changed) return;
  localStorage.setItem(LS_APIS, JSON.stringify(raw));
  if (!pending) localStorage.removeItem("aos_hosting_own_key");
}

// Unified call — routes through the backend Echo brain. The routing table,
// system prompts, model pricing and provider keys all live server-side now,
// so this is a thin transport and none of that logic ships to the browser.
// A mode ("reflect" | "echo" | "ally" | "build") tells the server which
// persona/app prompt to assemble; opts.ctx carries the user's own data
// (name, persona, memCtx, siteCtx, focusSection) to fill it in. BYOK keys
// typed in Settings are forwarded so a user's own key still works, while the
// platform key and the routing policy never leave the server.
// Every conversation belongs to a project on the server. One id per chat
// surface, kept in this browser; the server binds it to the person's account.
export function conversationIdFor(mode) {
  const key = `aos_conv_${mode || "direct"}`;
  try {
    let id = localStorage.getItem(key);
    if (!id) { id = `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; localStorage.setItem(key, id); }
    return id;
  } catch { return null; }
}

export async function callAI(systemPrompt, messages, opts = {}) {
  await moveBrowserKeysToVault();
  const jwt = readPanelStorage("jwt") || "";
  const srv = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
  const streaming = typeof opts.onDelta === "function";
  const body = {
    messages,
    task: opts.task || null,
    model: opts.model || null,
    maxTokens: opts.maxTokens || null,
    mode: opts.mode || null,
    providerId: opts.providerId || null,
    // Demo BYOK toggle: a per-request key from component state rides this one
    // call and is never written to localStorage or anywhere else.
    // Stored keys are read by the server from its vault. Only the demo's
    // per-tab key, never saved anywhere, rides a request.
    ...(opts.byokKey ? { byok: { [opts.byokKey.provider]: { key: opts.byokKey.key } } } : {}),
    override: loadTaskRoutes(),
    stream: streaming,
    conversationId: opts.conversationId || conversationIdFor(opts.mode),
    ...(opts.ctx || {}),
  };
  // Only forward a client system prompt for raw, persona-free access (Direct
  // Chat). When a mode is set the server owns the prompt.
  if (!opts.mode && systemPrompt) body.system = systemPrompt;

  const res = await fetch(`${srv}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body),
  });

  const finish = (data) => {
    // The server meters the authoritative cost; mirror it into the local widget.
    if (data.cost != null && data.usage) {
      recordCost(data.model, data.provider, data.usage.in || 0, data.usage.out || 0, `${String(messages[messages.length-1]?.content || "").length} chars`);
    }
    // Announce which brain answered so the UI indicator can reflect reality.
    try { window.dispatchEvent(new CustomEvent("arca_brain", { detail: { provider: data.provider, source: data.source, model: data.model } })); } catch {}
  };

  // Streaming path — the reply arrives as SSE deltas and onDelta fires with
  // the accumulated text so the UI can render as the model thinks.
  if (streaming && res.ok && (res.headers.get("content-type") || "").includes("text/event-stream")) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.error) throw new Error(ev.error);
        if (ev.delta) { full += ev.delta; opts.onDelta(full, ev.delta); }
        // A staged provisioning proposal riding the stream (demo bridge).
        if (ev.action && typeof opts.onAction === "function") opts.onAction(ev.action);
        if (ev.done) finish(ev);
      }
    }
    return full;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || t("AI request failed ({status})", { status: res.status }));
  if (data.action && typeof opts.onAction === "function") opts.onAction(data.action);
  finish(data);
  return data.reply || "";
}

async function residentApiRequest(path, opts = {}) {
  const server = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
  const response = await fetch(`${server}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${readPanelStorage("jwt") || ""}`,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t("Request failed ({status})", { status: response.status }));
  return data;
}

// Resident projects are kept in their own component so every hook stays at a
// component's top level. Approval always sends the hash on the object being
// drawn: changing what is displayed makes the server refuse the old hash.
export function ProjectsSettings() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [project, setProject] = useState(null);
  const [ruleTitle, setRuleTitle] = useState("");
  const [ruleText, setRuleText] = useState("");
  const [draftRule, setDraftRule] = useState(null);
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState(null);
  const [planNote, setPlanNote] = useState("");
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");

  const loadProject = useCallback(async id => {
    if (!id) { setProject(null); return; }
    const data = await residentApiRequest(`/api/resident/projects/${encodeURIComponent(id)}`);
    setProject(data);
  }, []);

  useEffect(() => {
    let live = true;
    residentApiRequest("/api/resident/projects")
      .then(data => {
        if (!live) return;
        const found = data.projects || [];
        setProjects(found);
        setProjectId(current => current || found[0]?.id || "");
      })
      .catch(error => { if (live) setProblem(error.message); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    setProblem("");
    loadProject(projectId).catch(error => { if (live) setProblem(error.message); });
    return () => { live = false; };
  }, [projectId, loadProject]);

  useEffect(() => {
    if (!plan?.plan?.id || plan.run?.state !== "running") return undefined;
    const timer = setInterval(() => {
      residentApiRequest(`/api/resident/plans/${encodeURIComponent(plan.plan.id)}`)
        .then(setPlan).catch(error => setProblem(error.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [plan?.plan?.id, plan?.run?.state]);

  const act = async (name, work) => {
    setBusy(name); setProblem("");
    try { await work(); } catch (error) { setProblem(error.message); }
    finally { setBusy(""); }
  };

  const proposeRule = () => act("rule", async () => {
    const title = ruleTitle.trim();
    if (!title || !projectId) return;
    const data = await residentApiRequest(`/api/resident/projects/${encodeURIComponent(projectId)}/rules`, {
      method: "POST", body: JSON.stringify({ title, ...(ruleText.trim() ? { text: ruleText.trim() } : {}) }),
    });
    setDraftRule({ ...data, text: ruleText.trim() || null });
    setRuleTitle(""); setRuleText("");
  });

  const approveRule = rule => act(`approve-${rule.id}`, async () => {
    await residentApiRequest(`/api/resident/rules/${encodeURIComponent(rule.id)}/approve`, {
      method: "POST", body: JSON.stringify({ seenHash: rule.hash }),
    });
    if (draftRule?.id === rule.id) setDraftRule(null);
    await loadProject(projectId);
  });

  const makePlan = () => act("plan", async () => {
    if (!goal.trim()) return;
    const data = await residentApiRequest("/api/resident/plans", {
      method: "POST", body: JSON.stringify({ goal: goal.trim() }),
    });
    setPlan(data); setPlanNote(data.note || ""); setGoal("");
  });

  const approvePlan = () => act("approve-plan", async () => {
    const data = await residentApiRequest(`/api/resident/plans/${encodeURIComponent(plan.plan.id)}/approve`, {
      method: "POST", body: JSON.stringify({ seenHash: plan.plan.hash }),
    });
    setPlan(data);
  });

  const runPlan = () => act("run-plan", async () => {
    await residentApiRequest(`/api/resident/plans/${encodeURIComponent(plan.plan.id)}/run`, { method: "POST" });
    setPlan(current => ({ ...current, run: { ...current.run, state: "running" } }));
  });

  const decisions = project?.decisions || [];
  const constraints = project?.constraints || [];
  const inForce = [...decisions.filter(item => item.status === "settled" && item.kind !== "plan"), ...constraints.filter(item => item.status === "active")];
  const proposals = [...decisions.filter(item => item.status === "proposed" && item.kind !== "plan"), ...constraints.filter(item => item.status === "proposed")];
  const field = { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 6, border: `1px solid ${OS.border}`, background: OS.inpBg, color: OS.txt, font: "inherit" };
  const card = { padding: "12px 14px", border: `1px solid ${OS.border}`, borderRadius: 9, background: OS.panel, marginBottom: 9 };

  return (
    <div style={{ color: OS.txt }}>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>{t("Projects")}</div>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: OS.txt2, marginBottom: 18 }}>{t("See what Echo knows and what rules it must follow. Nothing is approved until you press Approve.")}</div>
      {problem && <div role="alert" style={{ ...card, color: OS.txt, borderColor: OS.txt3 }}>{problem}</div>}

      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: OS.txt3, marginBottom: 6 }}>{t("Project")}</label>
      <select value={projectId} onChange={event => { setProjectId(event.target.value); setDraftRule(null); }} style={{ ...field, marginBottom: 20 }}>
        {projects.length === 0 && <option value="">{t("No projects yet")}</option>}
        {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>

      {project && <>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 9 }}>{t("Rules in force")}</div>
        {inForce.length === 0 && <div style={{ ...card, color: OS.txt2 }}>{t("No rules are in force.")}</div>}
        {inForce.map(rule => <div key={rule.id} style={card}><div style={{ fontSize: 13, fontWeight: 650 }}>{rule.title}</div>{rule.text && <div style={{ marginTop: 4, fontSize: 12, color: OS.txt2, whiteSpace: "pre-wrap" }}>{rule.text}</div>}</div>)}

        <div style={{ fontSize: 15, fontWeight: 700, margin: "20px 0 9px" }}>{t("Waiting for approval")}</div>
        {proposals.length === 0 && <div style={{ ...card, color: OS.txt2 }}>{t("No proposals are waiting.")}</div>}
        {proposals.map(rule => <div key={rule.id} style={card}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>{rule.title}</div>
          {rule.text && <div style={{ marginTop: 4, fontSize: 12, color: OS.txt2, whiteSpace: "pre-wrap" }}>{rule.text}</div>}
          {rule.forbid?.length > 0 && <div style={{ marginTop: 7, fontSize: 11, color: OS.txt2 }}>{t("Drafted patterns")}: <span style={{ fontFamily: "ui-monospace, monospace", color: OS.txt }}>{rule.forbid.join(", ")}</span></div>}
          <button disabled={!!busy} onClick={() => approveRule(rule)} style={{ ...dBtn(true), marginTop: 9 }}>{busy === `approve-${rule.id}` ? t("Approving…") : t("Approve")}</button>
        </div>)}

        <div style={{ fontSize: 15, fontWeight: 700, margin: "20px 0 9px" }}>{t("Add a rule")}</div>
        <div style={card}>
          <input value={ruleTitle} onChange={event => setRuleTitle(event.target.value)} placeholder={t("Rule title")} style={{ ...field, marginBottom: 8 }} />
          <textarea value={ruleText} onChange={event => setRuleText(event.target.value)} placeholder={t("Optional note")} rows={3} style={{ ...field, resize: "vertical", marginBottom: 8 }} />
          <button disabled={!projectId || !ruleTitle.trim() || !!busy} onClick={proposeRule} style={dBtn(true)}>{busy === "rule" ? t("Drafting…") : t("Draft rule")}</button>
        </div>
        {draftRule && <div style={card}>
          <div style={{ fontSize: 11, fontWeight: 700, color: OS.txt3, marginBottom: 5 }}>{t("Drafted rule — not yet approved")}</div>
          <div style={{ fontSize: 13, fontWeight: 650 }}>{draftRule.title}</div>
          {draftRule.text && <div style={{ marginTop: 4, fontSize: 12, color: OS.txt2, whiteSpace: "pre-wrap" }}>{draftRule.text}</div>}
          <div style={{ marginTop: 7, fontSize: 11, color: OS.txt2 }}>{t("Drafted patterns")}: <span style={{ fontFamily: "ui-monospace, monospace", color: OS.txt }}>{draftRule.forbid?.length ? draftRule.forbid.join(", ") : t("None")}</span></div>
          <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: OS.txt2 }}>{draftRule.note}</div>
          <button disabled={!!busy} onClick={() => approveRule(draftRule)} style={{ ...dBtn(true), marginTop: 9 }}>{busy === `approve-${draftRule.id}` ? t("Approving…") : t("Approve")}</button>
        </div>}

        <div style={{ fontSize: 15, fontWeight: 700, margin: "20px 0 9px" }}>{t("Knowledge notes")}</div>
        {(project.knowledge || []).length === 0 && <div style={{ ...card, color: OS.txt2 }}>{t("No knowledge notes yet.")}</div>}
        {(project.knowledge || []).map(note => <div key={note.id} style={card}><div style={{ fontSize: 13, fontWeight: 650 }}>{note.title}</div>{note.text && <div style={{ marginTop: 4, fontSize: 12, color: OS.txt2, whiteSpace: "pre-wrap" }}>{note.text}</div>}</div>)}
      </>}

      <div style={{ fontSize: 15, fontWeight: 700, margin: "22px 0 9px" }}>{t("Build plan")}</div>
      <div style={card}>
        <textarea value={goal} onChange={event => setGoal(event.target.value)} placeholder={t("What do you want built?")} rows={3} style={{ ...field, resize: "vertical", marginBottom: 8 }} />
        <button disabled={!goal.trim() || !!busy} onClick={makePlan} style={dBtn(true)}>{busy === "plan" ? t("Planning…") : t("Create plan")}</button>
        <div style={{ marginTop: 7, fontSize: 10, color: OS.txt3 }}>{t("Build goals without a conversation use Echo's General project.")}</div>
      </div>

      {plan && <div style={card}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>{plan.plan.title}</div>
          {plan.plan.rough && <span style={{ padding: "3px 7px", border: `1px solid ${OS.border}`, borderRadius: 5, fontSize: 10, fontWeight: 800, color: OS.txt }}>{t("ROUGH")}</span>}
        </div>
        {planNote && <div style={{ fontSize: 11, lineHeight: 1.5, color: OS.txt2, marginBottom: 8 }}>{planNote}</div>}
        {(plan.steps || []).map(step => <div key={step.id} style={{ padding: "8px 0", borderTop: `1px solid ${OS.border}` }}>
          <div style={{ display: "flex", gap: 8, fontSize: 12 }}><span style={{ flex: 1 }}>{step.title}</span><strong>{t(step.status)}</strong></div>
          {step.blockedReason && <div style={{ marginTop: 4, fontSize: 11, color: OS.txt2 }}>{t("Blocked")}: {step.blockedReason}</div>}
          {step.resumedAt && <div style={{ marginTop: 4, fontSize: 11, color: OS.txt2 }}>{t("Resumed")}</div>}
        </div>)}
        <div style={{ marginTop: 10, fontSize: 11, color: OS.txt2 }}>{t("Run status")}: <strong style={{ color: OS.txt }}>{t(plan.run?.state || "not started")}</strong></div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {plan.plan.status !== "settled" && <button disabled={!!busy} onClick={approvePlan} style={dBtn(true)}>{busy === "approve-plan" ? t("Approving…") : t("Approve plan")}</button>}
          {plan.plan.status === "settled" && !["running", "done"].includes(plan.run?.state) && <button disabled={!!busy} onClick={runPlan} style={dBtn(true)}>{busy === "run-plan" ? t("Starting…") : t("Run plan")}</button>}
        </div>
      </div>}
    </div>
  );
}

// The AI Routing section, as its own component: its hooks used to run inside an
// inline function in SettingsApp, which broke the rules of hooks and blanked the
// panel the moment the section opened.
function RoutingSettings() {
  // Routing picks a provider and a model, so it reads the same catalogue the
  // key screen does rather than a list of its own.
  const catalogue = useModelCatalogue();
    const [routes, setRoutes] = useState(loadTaskRoutes);
    const cfg = loadApiConfig();
    const availableProviders = PROVIDERS.filter(p => !p.voiceOnly && (cfg[p.id]?.connected || p.id === "ollama"));

    const setRoute = (taskId, providerId, modelId) => {
      const next = { ...routes, [taskId]: { providerId, modelId } };
      setRoutes(next); saveTaskRoutes(next);
    };
    const clearRoute = (taskId) => {
      const next = { ...routes }; delete next[taskId];
      setRoutes(next); saveTaskRoutes(next);
    };

    return (
      <>
        <div style={{ fontSize: 20, fontWeight: 700, color: OS.txt, marginBottom: 6 }}>{t("AI Routing")}</div>
        <div style={{ fontSize: 12, color: OS.txt2, lineHeight: 1.7, marginBottom: 20 }}>{t("Route different tasks to the best AI for the job. Save tokens by using cheaper models for simple tasks, reserve expensive ones for complex reasoning.")}</div>

        {availableProviders.length === 0 && (
          <div style={{ padding: "12px 14px", background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.2)", borderRadius: 8, fontSize: 12, color: "#f87171", marginBottom: 16 }}>{t("No providers connected yet. Add API keys in Settings → AI Connections first.")}</div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {Object.entries(TASK_LABELS()).map(([taskId, task]) => {
            const override  = routes[taskId];
            const defaults  = (getEffectiveRoutes()[taskId] || DEFAULT_ROUTES[taskId] || []);
            // Show which default would fire given current keys
            let autoRoute = null;
            for (const [pid, mid] of defaults) {
              if (cfg[pid]?.connected || pid === "ollama") { autoRoute = { pid, mid }; break; }
            }

            return (
              <div key={taskId} style={{ padding: "12px 14px", background: "rgba(var(--os-ink),.04)", border: `1px solid ${OS.border}`, borderRadius: 9 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 16 }}>{task.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: OS.txt }}>{task.label}</div>
                    <div style={{ fontSize: 10, color: OS.txt3 }}>{task.desc}</div>
                  </div>
                  {override && (
                    <button onClick={() => clearRoute(taskId)} style={{ ...dBtn(), fontSize: 10, padding: "2px 8px" }}>{t("Reset")}</button>
                  )}
                </div>

                {/* Provider + model picker */}
                <div style={{ display: "flex", gap: 6 }}>
                  <select
                    value={override?.providerId || "__auto__"}
                    onChange={e => {
                      if (e.target.value === "__auto__") { clearRoute(taskId); return; }
                      const p = PROVIDERS.find(p => p.id === e.target.value);
                      const first = offeredModels(catalogue, e.target.value).models.find(m => m.available && m.tested);
                      setRoute(taskId, e.target.value, first ? first.id : "");
                    }}
                    style={{ flex: 1, padding: "6px 8px", background: OS.inpBg, border: `1px solid ${OS.border}`, borderRadius: 6, fontSize: 11, color: OS.txt, fontFamily: "inherit", outline: "none" }}
                  >
                    <option value="__auto__">{t("Auto {count}", { count: autoRoute ? `(${autoRoute.pid} / ${autoRoute.mid.split("-").slice(-2).join("-")})` : t("(no key configured)") })}</option>
                    {availableProviders.map(p => (
                      <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
                    ))}
                  </select>

                  {override?.providerId && (
                    <select
                      value={override.modelId}
                      onChange={e => setRoute(taskId, override.providerId, e.target.value)}
                      style={{ flex: 1, padding: "6px 8px", background: OS.inpBg, border: `1px solid ${OS.border}`, borderRadius: 6, fontSize: 11, color: OS.txt, fontFamily: "inherit", outline: "none" }}
                    >
                      {/* Only models this key reaches and this panel has
                          actually called. Routing a task to something unproved
                          fails at the moment of use, which is the worst moment
                          to find out. */}
                      {offeredModels(catalogue, override.providerId).models
                        .filter(m => m.available && m.tested)
                        .map(m => {
                          const cost = (m.input_per_mtok != null && m.output_per_mtok != null)
                            ? `$${m.input_per_mtok}/$${m.output_per_mtok}` : "—";
                          return <option key={m.id} value={m.id}>{m.display} ({cost})</option>;
                        })}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 16, padding: "10px 14px", background: "rgba(var(--os-ink),.04)", borderRadius: 8, fontSize: 11, color: OS.txt3, lineHeight: 1.65 }}>{t("Auto routing: the local model reads each request, decides what kind of work it is and picks a model for that kind of work, moving down any model that keeps getting it wrong. Override any task to always use a specific model. Changes take effect immediately.")}</div>
        <RoutingRecord />
      </>
    );
}

// Why each request went where it went: the Resident's own record, read from
// the server. It shows the reason and what left this machine by field name and
// size, never the words.
function RoutingRecord() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    const jwt = readPanelStorage("jwt") || "";
    const srv = (readPanelStorage("server") || window.location.origin).replace(/\/$/, "");
    fetch(`${srv}/api/resident/dispatches?limit=30`, { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} })
      .then(r => (r.ok ? r.json() : { dispatches: [] })).then(d => setRows(d.dispatches || [])).catch(() => setRows([]));
  }, []);
  if (!rows) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: OS.txt, marginBottom: 8 }}>{t("Recent routing decisions")}</div>
      {!rows.length && <div style={{ fontSize: 11, color: OS.txt3 }}>{t("Nothing has been routed yet.")}</div>}
      {rows.map(d => {
        const failed = ((d.result && d.result.checks) || []).filter(c => !c.passed);
        const read = d.route && d.route.understood;
        return (
          <div key={d.id} style={{ padding: "8px 12px", marginBottom: 6, borderRadius: 8, background: "rgba(var(--os-ink),.04)", fontSize: 11, color: OS.txt2, lineHeight: 1.55 }}>
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
              <strong style={{ color: OS.txt }}>{d.route ? `${d.route.role || "?"} → ${d.route.provider ? `${d.route.provider}/` : ""}${d.route.model || "?"}` : d.purpose}</strong>
              <span style={{ color: d.status === "completed" ? "#4ade80" : d.status === "failed" || d.status === "interrupted" ? "#f87171" : OS.txt3 }}>{t(d.status)}</span>
            </div>
            <div>{t("Why")}: {(d.route && d.route.reason) || t("not recorded")}{read ? ` · ${t("read by")} ${read.how}${read.state && read.state !== "neutral" ? ` · ${read.state}` : ""}` : ""}</div>
            <div style={{ color: OS.txt3 }}>{t("Sent")}: {d.sent.length ? d.sent.map(f => `${f.field} (${f.bytes} bytes)`).join(", ") : t("nothing yet")}{d.result && d.result.latencyMs != null ? ` · ${Math.round(d.result.latencyMs)} ms` : ""}</div>
            {failed.length > 0 && <div style={{ color: "#f87171" }}>{failed.map(c => c.name).join(" · ")}</div>}
          </div>
        );
      })}
    </div>
  );
}

// API Key Manager panel — shown inside Settings window
function APIKeyManager() {
  const [cfg, setCfg] = useState(loadApiConfig);
  const [expanded, setExpanded] = useState(null);
  const [showKey, setShowKey] = useState({});
  const [testing, setTesting] = useState({});
  const [testResult, setTestResult] = useState({});
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState({});
  // What the catalogue says, what this key reaches, what has been proved.
  const catalogue = useModelCatalogue();
  const [testingModel, setTestingModel] = useState(null);

  // Proving one model. The panel sends the smallest real request it can and
  // only calls the model tested if an answer came back — the whole point of
  // the word is that nobody took it on trust.
  const testModel = async (providerId, modelId) => {
    setTestingModel(`${providerId}:${modelId}`);
    try {
      await residentApiRequest("/api/ai/catalogue/test", {
        method: "POST",
        body: JSON.stringify({ provider: providerId, model: modelId }),
      });
      await catalogue.reload();
    } catch (error) {
      setTestResult(r => ({ ...r, [providerId]: error.message.slice(0, 80) }));
    }
    setTestingModel(null);
  };

  // The vault is the truth about which keys are held.
  useEffect(() => {
    let live = true;
    moveBrowserKeysToVault().then(listProviderKeys).then(keys => {
      if (!live) return;
      const held = Object.fromEntries(keys.map(k => [k.provider, k.fingerprint]));
      const next = { ...loadApiConfig() };
      for (const p of PROVIDERS) {
        if (held[p.id]) next[p.id] = { ...(next[p.id] || {}), connected: true, fingerprint: held[p.id] };
        else if (next[p.id]) next[p.id] = { ...next[p.id], connected: false, fingerprint: null };
      }
      setCfg(next); saveApiConfig(next);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  const saveKey = async (p) => {
    const key = (draft[p.id] || "").trim();
    if (!key) return;
    setSaving(s => ({ ...s, [p.id]: true }));
    try {
      const saved = await storeProviderKey(p.id, key);
      setDraft(d => ({ ...d, [p.id]: "" }));
      const next = { ...cfg, [p.id]: { ...cfg[p.id], connected: true, fingerprint: saved.fingerprint } };
      setCfg(next); saveApiConfig(next);
      setTestResult(r => ({ ...r, [p.id]: null }));
    } catch (e) {
      setTestResult(r => ({ ...r, [p.id]: e.message.slice(0, 80) }));
    }
    setSaving(s => ({ ...s, [p.id]: false }));
  };
  const removeKey = async (p) => {
    await removeProviderKey(p.id).catch(() => {});
    const next = { ...cfg, [p.id]: { ...cfg[p.id], connected: false, fingerprint: null } };
    setCfg(next); saveApiConfig(next);
    setTestResult(r => ({ ...r, [p.id]: null }));
  };

  const update = (id, field, val) => {
    const next = { ...cfg, [id]: { ...cfg[id], [field]: val } };
    setCfg(next); saveApiConfig(next);
  };
  const setPrimary = (id) => {
    const next = { ...cfg, _primary: id };
    setCfg(next); saveApiConfig(next);
  };
  const testKey = async (p) => {
    setTesting(tabId => ({ ...tabId, [p.id]: true }));
    setTestResult(r => ({ ...r, [p.id]: null }));
    try {
      // Temporarily set this as primary to test it
      const origCfg = loadApiConfig();
      const tempCfg = { ...origCfg, _primary: p.id };
      saveApiConfig(tempCfg);
      await callAI("Say only: OK", [{ role: "user", content: "OK" }], { maxTokens: 5 });
      saveApiConfig(origCfg); // restore
      setTestResult(r => ({ ...r, [p.id]: "ok" }));
    } catch (e) {
      setTestResult(r => ({ ...r, [p.id]: e.message.slice(0, 60) }));
    }
    setTesting(tabId => ({ ...tabId, [p.id]: false }));
  };

  // Provider brand colors
  const BRAND = {
    anthropic: { bg: "#6333a0", glow: "rgba(99,51,160,.4)",  badge: "#a855f7" },
    openai:    { bg: "#0d7a5f", glow: "rgba(13,122,95,.4)",  badge: "#10b981" },
    groq:      { bg: "#b45309", glow: "rgba(180,83,9,.4)",   badge: "#f59e0b" },
    gemini:    { bg: "#1a56a0", glow: "rgba(26,86,160,.4)",  badge: "#3b82f6" },
    mistral:   { bg: "#9a2b2b", glow: "rgba(154,43,43,.4)",  badge: "#f87171" },
    deepseek:  { bg: "#1d3f8a", glow: "rgba(29,63,138,.4)",  badge: "#60a5fa" },
    moonshot:  { bg: "#3b3363", glow: "rgba(59,51,99,.4)",   badge: "#8b8bd6" },
    zhipu:     { bg: "#155e63", glow: "rgba(21,94,99,.4)",   badge: "#2dd4bf" },
    ollama:    { bg: "#1e3a1e", glow: "rgba(30,58,30,.4)",   badge: "#4ade80" },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Summary strip */}
      <div style={{ display: "flex", gap: 8, padding: "6px 10px", background: "rgba(var(--os-ink),.04)", borderRadius: 10, border: "1px solid rgba(var(--os-ink),.07)" }}>
        {PROVIDERS.map(p => {
          const connected = !!cfg[p.id]?.connected;
          const isPrimary = cfg._primary === p.id;
          return (
            <div key={p.id} title={p.name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", opacity: connected ? 1 : .3 }}
              onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
              <div style={{ fontSize: 18 }}>{p.icon}</div>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: isPrimary && connected ? "#22c55e" : connected ? "#4a7cf7" : "rgba(var(--os-ink),.15)" }} />
            </div>
          );
        })}
        <div style={{ marginLeft: "auto", fontSize: 11, color: "rgba(var(--os-ink),.3)", alignSelf: "center" }}>{t("{count} connected", { count: Object.values(cfg).filter((v, i) => typeof v === "object" && v?.connected).length })}</div>
      </div>

      {/* Provider cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8, alignItems: "start" }}>
      {PROVIDERS.map(p => {
        const pCfg = cfg[p.id] || {};
        const isPrimary = cfg._primary === p.id;
        const hasKey = !!pCfg.connected;
        const isOpen = expanded === p.id;
        const res = testResult[p.id];
        const isTest = testing[p.id];
        const brand = BRAND[p.id] || { bg: "#333", glow: "rgba(0,0,0,.3)", badge: "#888" };

        return (
          <div key={p.id} style={{
            borderRadius: 12,
            border: `1px solid ${isOpen || isPrimary ? brand.badge + "44" : "rgba(var(--os-ink),.08)"}`,
            background: isOpen ? "rgba(var(--os-ink),.06)" : "rgba(var(--os-ink),.03)",
            overflow: "hidden",
            transition: "all .2s",
            boxShadow: isPrimary && hasKey ? `0 0 24px ${brand.glow}` : "none",
          }}>
            {/* Card header — always visible */}
            <div
              onClick={() => setExpanded(isOpen ? null : p.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", cursor: "pointer", userSelect: "none" }}
            >
              {/* Provider icon with colored bg */}
              <div style={{ width: 32, height: 32, borderRadius: 8, background: brand.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0, boxShadow: hasKey ? `0 4px 16px ${brand.glow}` : "none" }}>
                {p.icon}
              </div>

              {/* Name + model */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: OS.txt }}>{p.name}</span>
                  {isPrimary && (
                    <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 5, background: brand.badge, color: "#fff", fontWeight: 700, letterSpacing: ".06em" }}>{t("PRIMARY")}</span>
                  )}
                  {/* Where the inference happens. Shown always, not on hover,
                      because it is a disclosure and not a detail. */}
                  {p.region && REGIONS[p.region] && (
                    <span title={t("Runs in {label}", { label: REGIONS[p.region].label })}
                      style={{ fontSize: 9, padding: "2px 6px", borderRadius: 5, border: "1px solid rgba(var(--os-ink),.16)", color: "rgba(var(--os-ink),.45)", fontWeight: 700, letterSpacing: ".06em" }}>
                      {REGIONS[p.region].short}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "rgba(var(--os-ink),.35)", marginTop: 2 }}>
                  {hasKey ? (pCfg.model || t("no model chosen yet")) : (p.localNote || t("No key added"))}
                </div>
              </div>

              {/* Status indicator */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {isTest ? (
                  <div style={{ width: 8, height: 8, borderRadius: "50%", border: `2px solid ${brand.badge}`, borderTopColor: "transparent", animation: "spin .7s linear infinite" }} />
                ) : res === "ok" ? (
                  <div style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>{t("✓ Live")}</div>
                ) : res ? (
                  <div style={{ fontSize: 10, color: "#dc2626", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={res}>{t("✕ Error")}</div>
                ) : hasKey ? (
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#4a7cf7" }} />
                ) : (
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: "rgba(var(--os-ink),.12)" }} />
                )}
                <div style={{ fontSize: 12, color: "rgba(var(--os-ink),.2)", transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }}>▾</div>
              </div>
            </div>

            {/* Expanded body */}
            {isOpen && (
              <div style={{ padding: "0 10px 10px", borderTop: "1px solid rgba(var(--os-ink),.06)" }}>
                {/* Key field */}
                <div style={{ marginTop: 14, marginBottom: 12 }}>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "rgba(var(--os-ink),.35)", letterSpacing: ".07em", textTransform: "uppercase", display: "block", marginBottom: 8 }}>{t("API Key")}</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1, position: "relative" }}>
                      <input
                        type={showKey[p.id] ? "text" : "password"}
                        value={draft[p.id] || ""}
                        onChange={e => { const v = e.target.value; setDraft(d => ({ ...d, [p.id]: v })); }}
                        onKeyDown={e => { if (e.key === "Enter") saveKey(p); }}
                        autoComplete="off"
                        placeholder={p.localNote || (hasKey ? t("Saved on the server ({fingerprint}). Paste a new key to replace it.", { fingerprint: pCfg.fingerprint || "…" }) : t("Paste your API key…"))}
                        style={{ width: "100%", padding: "9px 36px 9px 12px", background: "rgba(var(--os-ink),.07)", border: `1px solid ${hasKey ? brand.badge + "55" : "rgba(var(--os-ink),.1)"}`, borderRadius: 9, fontSize: 12, color: "#fff", fontFamily: "inherit", outline: "none", transition: "border-color .15s" }}
                        onFocus={e => e.target.style.borderColor = brand.badge + "99"}
                        onBlur={e => e.target.style.borderColor = hasKey ? brand.badge + "55" : "rgba(var(--os-ink),.1)"}
                      />
                      <button onClick={() => setShowKey(s => ({ ...s, [p.id]: !s[p.id] }))}
                        style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "rgba(var(--os-ink),.3)", padding: 0 }}>
                        {showKey[p.id] ? "🙈" : "👁"}
                      </button>
                    </div>
                    {(draft[p.id] || "").trim() ? (
                      <button onClick={() => saveKey(p)} disabled={!!saving[p.id]}
                        style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${brand.badge}44`, background: `${brand.bg}`, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                        {saving[p.id] ? t("Saving…") : t("Save")}
                      </button>
                    ) : (
                      <button onClick={() => testKey(p)} disabled={isTest || !hasKey}
                        style={{ padding: "9px 16px", borderRadius: 9, border: `1px solid ${brand.badge}44`, background: `${brand.bg}`, color: "#fff", fontSize: 11, fontWeight: 600, cursor: hasKey ? "pointer" : "default", fontFamily: "inherit", flexShrink: 0, opacity: hasKey ? 1 : .35, transition: "opacity .15s" }}>
                        {isTest ? t("Testing…") : t("Test")}
                      </button>
                    )}
                  </div>
                  {res && res !== "ok" && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626", padding: "7px 10px", background: "rgba(248,113,113,.08)", borderRadius: 7, border: "1px solid rgba(248,113,113,.2)" }}>{res}</div>
                  )}
                </div>

                {/* Model selector — with cost tier indicators */}
                {!p.voiceOnly && (
                <div style={{ marginTop: 14 }}>
                  <label style={{ fontSize: 10, fontWeight: 700, color: "rgba(var(--os-ink),.35)", letterSpacing: ".07em", textTransform: "uppercase", display: "block", marginBottom: 8 }}>{t("Model")}</label>
                  {(() => {
                    const offer = offeredModels(catalogue, p.id);
                    if (catalogue.loading) return <div style={{ fontSize: 11, color: OS.txt3 }}>{t("Asking your provider which models this key can use…")}</div>;
                    if (!offer.hasKey) return <div style={{ fontSize: 11, color: OS.txt3 }}>{t("Add a key above and the models your account can use will be listed here.")}</div>;
                    if (offer.state === "unconfirmed") return (
                      <div style={{ fontSize: 11, color: OS.txt3, marginBottom: 8 }}>
                        {t("Your provider could not be asked which models this key can use, so these are from the catalogue and none of them is confirmed: {reason}", { reason: offer.reason || "" })}
                      </div>
                    );
                    return null;
                  })()}
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 172, overflowY: "auto" }}>
                    {offeredModels(catalogue, p.id).models.map(m => {
                      const active    = pCfg.model === m.id;
                      const usable    = m.available && m.tested;
                      const price     = (m.input_per_mtok != null && m.output_per_mtok != null) ? [m.input_per_mtok, m.output_per_mtok] : null;
                      const tier      = price ? (((price[0] + price[1]) / 2) === 0 ? 0 : ((price[0] + price[1]) / 2) < 0.5 ? 1 : ((price[0] + price[1]) / 2) < 3 ? 2 : ((price[0] + price[1]) / 2) < 10 ? 3 : 4) : null;
                      const TIER_LABELS = [t("Free"), "$", "$$", "$$$", "$$$$"];
                      const TIER_COLORS = ["#4ade80","#4ade80","#facc15","#fb923c","#f87171"];
                      // Three facts, three words. A model your key cannot reach
                      // is shown greyed rather than hidden, so the answer to
                      // "where did it go" is on the screen.
                      const badge = !m.available ? { text: t("not on this key"), tone: "rgba(var(--os-ink),.28)" }
                                  : !m.tested    ? { text: t("untested"),        tone: "#facc15" }
                                  :                { text: t("tested"),          tone: "#4ade80" };
                      return (
                        <div key={m.id}
                          style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "8px 12px", borderRadius: 7, textAlign: "left",
                            border: `1px solid ${active ? brand.badge + "77" : "rgba(var(--os-ink),.08)"}`,
                            background: active ? brand.bg + "44" : "transparent",
                            opacity: m.available ? 1 : .45,
                          }}
                        >
                          <div style={{ width: 6, height: 6, borderRadius: "50%", background: active ? brand.badge : "rgba(var(--os-ink),.15)", flexShrink: 0 }} />
                          <button
                            disabled={!usable}
                            title={usable ? "" : (!m.available ? t("Your key does not list this model.") : t("Press Test to prove this panel can call it."))}
                            onClick={() => usable && update(p.id, "model", m.id)}
                            style={{ flex: 1, textAlign: "left", background: "none", border: "none", padding: 0, cursor: usable ? "pointer" : "not-allowed", fontFamily: "inherit", overflow: "hidden" }}
                          >
                            <span style={{ display: "block", fontSize: 11, fontWeight: active ? 600 : 400, color: active ? OS.txt : OS.txt2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.display}</span>
                            {m.display !== m.id && <span style={{ display: "block", fontSize: 9, color: "rgba(var(--os-ink),.25)" }}>{m.id}</span>}
                          </button>
                          <span style={{ fontSize: 9, fontWeight: 600, color: badge.tone, flexShrink: 0 }}>{badge.text}</span>
                          {tier != null && <span style={{ fontSize: 10, fontWeight: 600, color: TIER_COLORS[tier], flexShrink: 0 }}>{TIER_LABELS[tier]}</span>}
                          {/* An unknown price says so. A guess about somebody
                              else's money is worse than an honest blank. */}
                          <span style={{ fontSize: 9, color: "rgba(var(--os-ink),.2)", flexShrink: 0 }}>
                            {price ? t("${in}/${out} per M", { in: price[0], out: price[1] }) : "—"}
                          </span>
                          {m.available && !m.tested && (
                            <button
                              onClick={() => testModel(p.id, m.id)}
                              disabled={testingModel === `${p.id}:${m.id}`}
                              style={{ fontSize: 9, padding: "3px 7px", borderRadius: 5, border: "1px solid rgba(var(--os-ink),.15)", background: "transparent", color: OS.txt2, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}
                            >{testingModel === `${p.id}:${m.id}` ? t("Testing…") : t("Test")}</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  {!isPrimary && hasKey && !p.voiceOnly && (
                    <button onClick={() => setPrimary(p.id)}
                      style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${brand.badge}66`, background: `${brand.bg}`, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{t("★ Set as Primary")}</button>
                  )}
                  {isPrimary && !p.voiceOnly && (
                    <div style={{ padding: "7px 14px", borderRadius: 8, background: brand.badge + "22", border: `1px solid ${brand.badge}44`, fontSize: 11, fontWeight: 600, color: brand.badge }}>{t("★ This is your primary AI")}</div>
                  )}
                  {p.voiceOnly && hasKey && (
                    <div style={{ padding: "7px 14px", borderRadius: 8, background: brand.badge + "18", border: `1px solid ${brand.badge}33`, fontSize: 11, color: brand.badge }}>{t("🎙️ Voice only — not used for chat")}</div>
                  )}
                  {hasKey && (
                    <button onClick={() => removeKey(p)}
                      style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid rgba(248,113,113,.2)", background: "rgba(248,113,113,.08)", color: "#dc2626", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", marginLeft: "auto" }}>{t("Remove key")}</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      </div>

      {/* Footer note */}
      <div style={{ padding: "10px 14px", background: "rgba(var(--os-ink),.03)", borderRadius: 9, border: "1px solid rgba(var(--os-ink),.06)", marginTop: 4 }}>
        <div style={{ fontSize: 11, color: "rgba(var(--os-ink),.25)", lineHeight: 1.7 }}>{t("🔒 Keys are kept in this server's encrypted vault, never in your browser, and are shown back only as a fingerprint. They are sent only to the provider's own API. The primary provider is used for Echo and all AI features.")}</div>
      </div>
    </div>
  );
}
