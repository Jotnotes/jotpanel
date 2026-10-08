// Hoster administration, as its own surface.
//
// This used to be a section inside the control panel: the person who runs the
// machine signed in to the same screens their customers use and opened an
// administration window inside them. That is the wrong shape for the product.
// A hoster is not a customer with extra buttons, the two jobs have nothing to
// do with each other, and putting the machine's business behind a customer
// screen makes "what may this account see" a question about which window is
// open rather than a question about who signed in.
//
// So it has its own address, its own sign-in and its own navigation, and it
// asks the server who the caller is on every load rather than being handed a
// prop. Nothing here is drawn until that answer comes back: not a heading, not
// a nav, not an empty table. A surface that renders its shape before it knows
// whether the caller may see it has already leaked the shape.
//
// Everything on it is a reading or an action the panel already had and already
// proved. Nothing was invented to fill a screen, and where an administrative
// capability does not exist, there is no button pretending it does.

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { PanelIcon, OS } from './control-panel.jsx'
import { JotPanelSignIn } from './sign-in.jsx'
import { readPanelStorage, removePanelStorage } from './panel-storage.js'

const ROOT = '/hoster';

// ── Talking to the box ────────────────────────────────────────────
//
// One place, so that "the session went away" is one answer rather than eight
// different ones. A 401 means the token is gone or expired and the surface goes
// back to its sign-in; a 403 means the caller is signed in and is not the
// operator, which is a different sentence and must not look like a login
// problem.
export async function api(path, opts = {}) {
  const base = (readPanelStorage("server") || '').replace(/\/$/, '');
  const response = await fetch(base + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${readPanelStorage("jwt") || ''}`,
      ...(opts.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
const reading = name => api(`/api/panel/server/read/${name}`);

const CSS = `
  .ha{min-height:100vh;display:flex;background:#f4f6f8;color:#16202b;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .ha *{box-sizing:border-box}
  .ha-side{width:212px;flex:0 0 212px;background:#16212c;color:#c8d2dc;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow:auto}
  .ha-brand{padding:14px 14px 12px;border-bottom:1px solid #24313d;display:flex;gap:9px;align-items:center}
  .ha-brand-mark{width:28px;height:28px;flex:0 0 28px;border:1px solid #4c7ea0;display:flex;align-items:center;justify-content:center;color:#8fbdd8}
  .ha-brand strong{display:block;color:#fff;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ha-brand span{display:block;color:#7d8c99;font-size:8.5px;letter-spacing:.11em;text-transform:uppercase;margin-top:2px}
  .ha-group{padding:13px 13px 5px;color:#76848f;font-size:8.5px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}
  .ha-link{appearance:none;width:100%;border:0;border-left:3px solid transparent;background:transparent;color:#b4c0cb;
           padding:8px 12px;display:flex;align-items:center;gap:9px;text-align:left;font:650 11.5px/1.2 inherit;cursor:pointer}
  .ha-link:hover{background:#1f2c38;color:#fff}
  .ha-link.on{background:#26374a;border-left-color:#5fa3cd;color:#fff}
  .ha-link .ha-count{margin-left:auto;font-size:9.5px;background:#c0453c;color:#fff;padding:1px 6px;border-radius:9px}
  .ha-foot{margin-top:auto;padding:10px;border-top:1px solid #24313d}
  .ha-main{flex:1;min-width:0;display:flex;flex-direction:column}
  .ha-top{background:#fff;border-bottom:1px solid #dde3e9;padding:13px 20px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:2}
  .ha-top h1{margin:0;font-size:16px;font-weight:700;letter-spacing:-.01em}
  .ha-top small{display:block;color:#76848f;font-size:9px;letter-spacing:.1em;text-transform:uppercase;font-weight:800}
  .ha-who{margin-left:auto;text-align:right;color:#5b6a78;font-size:11px}
  .ha-body{padding:20px;max-width:1180px}
  .ha-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:11px;margin-bottom:18px}
  .ha-card{background:#fff;border:1px solid #dde3e9;padding:13px 14px}
  .ha-card .k{color:#76848f;font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:800}
  .ha-card .v{font-size:23px;font-weight:700;margin-top:5px;letter-spacing:-.02em}
  .ha-card .s{color:#76848f;font-size:11px;margin-top:2px}
  .ha-panel{background:#fff;border:1px solid #dde3e9;margin-bottom:18px}
  .ha-panel-h{padding:11px 14px;border-bottom:1px solid #e6ebf0;display:flex;align-items:center;gap:10px}
  .ha-panel-h strong{font-size:12.5px}
  .ha-panel-h span{color:#76848f;font-size:11px;margin-left:auto}
  .ha-panel-b{padding:14px}
  table.ha-t{width:100%;border-collapse:collapse;font-size:12px}
  table.ha-t th{text-align:left;color:#76848f;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;padding:8px 10px;border-bottom:1px solid #e6ebf0;white-space:nowrap}
  table.ha-t td{padding:9px 10px;border-bottom:1px solid #f0f3f6;vertical-align:top}
  table.ha-t tr:last-child td{border-bottom:0}
  .ha-scroll{overflow-x:auto}
  .ha-tag{display:inline-block;padding:1px 7px;font-size:10px;font-weight:700;border:1px solid transparent}
  .ha-tag.ok{background:#e3f4ec;color:#1c6b4c;border-color:#bfe3d3}
  .ha-tag.warn{background:#fdf1dc;color:#8a5a10;border-color:#f0dcb4}
  .ha-tag.bad{background:#fbe6e4;color:#93332b;border-color:#f2cac6}
  .ha-tag.mute{background:#eef1f4;color:#5b6a78;border-color:#dde3e9}
  .ha-note{padding:10px 12px;border-left:4px solid #c8922a;background:#fdf8ee;color:#5b4a2a;font-size:11.5px;margin-bottom:14px}
  .ha-empty{color:#76848f;font-size:12px;padding:16px 4px}
  .ha-err{padding:10px 12px;border-left:4px solid #c0453c;background:#fdeeed;color:#8d3229;font-size:12px;margin-bottom:14px}
  .ha-btn{appearance:none;border:1px solid #c3ccd5;background:#fff;padding:6px 12px;font:650 11.5px inherit;cursor:pointer;color:#16202b}
  .ha-btn:hover{background:#f4f6f8}
  .ha-btn.primary{background:#1f5c86;border-color:#1f5c86;color:#fff}
  .ha-btn.primary:hover{background:#256b9c}
  .ha-btn[disabled]{opacity:.5;cursor:default}
  .ha-field{display:block;margin-bottom:12px}
  .ha-field span{display:block;font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#5b6a78;margin-bottom:4px}
  .ha-field input{width:100%;max-width:340px;border:1px solid #c3ccd5;padding:7px 9px;font:13px inherit;background:#fff}
  .ha-gate{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#16212c;padding:24px}
  .ha-gate-box{width:340px;background:#1d2935;border:1px solid #2c3a48;padding:26px;text-align:center;color:#c8d2dc}
  @media(max-width:820px){
    .ha{flex-direction:column}
    .ha-side{width:auto;flex:0 0 auto;height:auto;position:static;flex-direction:row;overflow-x:auto}
    .ha-brand,.ha-group,.ha-foot{display:none}
    .ha-side>nav{display:flex}
    .ha-link{width:auto;border-left:0;border-bottom:2px solid transparent;white-space:nowrap}
    .ha-link.on{border-left:0;border-bottom-color:#5fa3cd}
    .ha-body{padding:12px}
  }
`;

// ── Little shared pieces ──────────────────────────────────────────
export const Card = ({ label, value, sub }) => (
  <div className="ha-card"><div className="k">{label}</div><div className="v">{value}</div>{sub && <div className="s">{sub}</div>}</div>
);
export const Tag = ({ tone = 'mute', children }) => <span className={`ha-tag ${tone}`}>{children}</span>;
export const Panel = ({ title, note, children }) => (
  <section className="ha-panel">
    <div className="ha-panel-h"><strong>{title}</strong>{note && <span>{note}</span>}</div>
    <div className="ha-panel-b">{children}</div>
  </section>
);
const bytes = n => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x >= 10 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
};
export const when = value => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
};

// A section that loads one thing and says so honestly while it does. The three
// states are separate on purpose: loading is not empty, and an error is not an
// empty list. A screen that renders "0 accounts" because a request failed is
// the class of bug this product is built to avoid.
export function useReading(load, deps = []) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const run = useCallback(() => {
    let live = true;
    setState(s => ({ ...s, status: 'loading' }));
    Promise.resolve().then(load).then(data => { if (live) setState({ status: 'ready', data, error: '' }); })
      .catch(error => { if (live) setState({ status: 'error', data: null, error: error.message, code: error.status }); });
    return () => { live = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(run, [run]);
  return [state, run];
}

export function Loading({ what }) { return <div className="ha-empty">Reading {what}…</div>; }
export function Failed({ error }) { return <div className="ha-err">{error}</div>; }

// ── Overview ──────────────────────────────────────────────────────
function Overview() {
  const [ops] = useReading(() => api('/admin/ops'), []);
  const [fleet] = useReading(() => api('/admin/tenants'), []);

  return <>
    {ops.status === 'error' && <Failed error={`This server's health could not be read: ${ops.error}`} />}
    {ops.status === 'loading' && <Loading what="this server" />}
    {ops.status === 'ready' && <>
      <div className="ha-cards">
        <Card label="Verdict" value={ops.data.verdict} sub={`checked ${when(ops.data.checked_at)}`} />
        <Card label="Load" value={ops.data.host.load1} sub={`${ops.data.host.cores} core${ops.data.host.cores === 1 ? '' : 's'}`} />
        <Card label="Memory" value={`${ops.data.host.mem_used_pct}%`} sub="in use" />
        <Card label="Disk" value={`${ops.data.host.disk_used_pct}%`} sub="of the root filesystem" />
        <Card label="Uptime" value={`${ops.data.host.uptime_days}d`} sub={ops.data.tls.days_remaining != null ? `certificate ${ops.data.tls.days_remaining}d left` : 'certificate unreadable'} />
      </div>

      <Panel title="What needs attention" note={`${ops.data.concerns.length} open`}>
        {ops.data.concerns.length === 0
          ? <div className="ha-empty">Nothing. Every check this server makes about itself came back clean.</div>
          : <div className="ha-scroll"><table className="ha-t"><tbody>
              {ops.data.concerns.map((c, i) => <tr key={i}>
                <td style={{ width: 86 }}><Tag tone={c.severity === 'critical' ? 'bad' : c.severity === 'warn' ? 'warn' : 'mute'}>{c.severity}</Tag></td>
                <td><strong>{c.what}</strong><div style={{ color: '#5b6a78', marginTop: 2 }}>{c.why}</div></td>
              </tr>)}
            </tbody></table></div>}
      </Panel>

      <Panel title="Services" note="what this panel needs, and what else is running">
        <div className="ha-scroll"><table className="ha-t">
          <thead><tr><th>Unit</th><th>State</th><th>To this panel</th></tr></thead>
          <tbody>{Object.entries(ops.data.services).map(([unit, state]) => {
            // An optional service being off is not a fault and must not be
            // painted as one. The server says which is which rather than the
            // screen assuming everything listed is required.
            const required = (ops.data.service_roles || {})[unit] !== 'optional';
            const bad = state !== 'active';
            return <tr key={unit}>
              <td>{unit}</td>
              <td><Tag tone={!bad ? 'ok' : required ? 'bad' : 'mute'}>{state}</Tag></td>
              <td style={{ color: '#76848f' }}>{required ? 'needed' : 'not needed'}</td>
            </tr>;
          })}</tbody>
        </table></div>
      </Panel>
    </>}

    {fleet.status === 'ready' && <Panel title="What is on this server" note={`${fleet.data.fleet.accounts} account${fleet.data.fleet.accounts === 1 ? '' : 's'}`}>
      <div className="ha-cards" style={{ marginBottom: 0 }}>
        <Card label="Websites" value={fleet.data.fleet.sites} />
        <Card label="Databases" value={fleet.data.fleet.databases} />
        <Card label="Mailboxes" value={fleet.data.fleet.mailboxes} />
        <Card label="Backups" value={fleet.data.fleet.backups} />
        <Card label="Storage" value={`${fleet.data.fleet.storage_used_mb} MB`} sub="measured on disk" />
        <Card label="Suspended" value={fleet.data.fleet.suspended} sub={`${fleet.data.fleet.active_30d} seen in 30 days`} />
      </div>
    </Panel>}
    {fleet.status === 'error' && <Failed error={`The account list could not be read: ${fleet.error}`} />}
  </>;
}

// ── Accounts ──────────────────────────────────────────────────────
function Accounts() {
  const [state] = useReading(() => api('/admin/tenants'), []);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const all = state.data?.tenants || [];
    const q = query.trim().toLowerCase();
    return q ? all.filter(t => `${t.name || ''} ${t.email || ''}`.toLowerCase().includes(q)) : all;
  }, [state.data, query]);

  if (state.status === 'loading') return <Loading what="the accounts on this server" />;
  if (state.status === 'error') return <Failed error={state.error} />;

  return <>
    <div className="ha-note">
      <strong style={{ display: 'block', marginBottom: 2 }}>This screen reads, it does not act</strong>
      Suspending, restoring and deleting an account are not offered here, because those backend routes
      still write straight to the database instead of going through proposal, approval and the durable
      record every other host action uses. They return when they do.
    </div>
    <label className="ha-field"><span>Find an account</span>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="name or email" />
    </label>
    <Panel title="Accounts" note={`${rows.length} of ${(state.data.tenants || []).length}`}>
      {rows.length === 0 ? <div className="ha-empty">No account matches that.</div> : <div className="ha-scroll">
        <table className="ha-t">
          <thead><tr>
            <th>Account</th><th>State</th><th>Sites</th><th>Databases</th><th>Mailboxes</th>
            <th>Backups</th><th>Storage</th><th>AI this month</th><th>Last seen</th>
          </tr></thead>
          <tbody>{rows.map(t => <tr key={t.id || t.email}>
            <td><strong>{t.name || 'Unnamed account'}</strong><div style={{ color: '#76848f' }}>{t.email}</div></td>
            <td>{t.suspended ? <Tag tone="bad">suspended</Tag> : <Tag tone="ok">active</Tag>}</td>
            <td>{t.sites}</td><td>{t.databases}</td><td>{t.mailboxes}</td><td>{t.backups}</td>
            {/* `unmeasured` is the list of domains that could not be measured,
                not a flag. An empty array is truthy, so testing it directly put
                "partly unmeasured" under every account on the box including the
                ones with nothing to measure. */}
            <td>{t.storage?.used_mb} MB{(t.storage?.unmeasured || []).length
              ? <div style={{ color: '#8a5a10' }}>{t.storage.unmeasured.length} domain{t.storage.unmeasured.length === 1 ? '' : 's'} not measured</div>
              : null}</td>
            <td>${(t.ai_month?.cost_usd ?? 0).toFixed(4)}</td>
            <td>{when(t.last_seen)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </Panel>
  </>;
}

// ── Backups ───────────────────────────────────────────────────────
function Backups() {
  const [health] = useReading(() => reading('backup-health'), []);
  const [incidents] = useReading(() => reading('backup-incidents'), []);
  const tone = status => (status === 'healthy' ? 'ok' : status === 'at_risk' || status === 'partial' ? 'warn' : 'bad');

  return <>
    {incidents.status === 'ready' && <Panel title="Open incidents" note={`${incidents.data.incidents.length}`}>
      {incidents.data.incidents.length === 0
        ? <div className="ha-empty">No backup on this server has failed without being dealt with.</div>
        : <div className="ha-scroll"><table className="ha-t">
            <thead><tr><th>Account</th><th>Where</th><th>Stage</th><th>Why</th><th>Runs</th><th>First seen</th></tr></thead>
            <tbody>{incidents.data.incidents.map(i => <tr key={i.id}>
              <td>{i.account}</td><td>{i.domain || '—'}</td><td>{i.stage || '—'}</td>
              <td>{i.failure_summary || i.failure_code || '—'}</td><td>{i.occurrences}</td><td>{when(i.opened_at)}</td>
            </tr>)}</tbody>
          </table></div>}
    </Panel>}
    {incidents.status === 'error' && <Failed error={`Backup incidents could not be read: ${incidents.error}`} />}

    {health.status === 'loading' && <Loading what="backup health" />}
    {health.status === 'error' && <Failed error={`Backup health could not be read: ${health.error}`} />}
    {health.status === 'ready' && <Panel title="Backup health, by account" note={`${health.data.health.length} account${health.data.health.length === 1 ? '' : 's'}`}>
      {health.data.health.length === 0 ? <div className="ha-empty">No account on this server has a backup schedule.</div> : <div className="ha-scroll">
        <table className="ha-t">
          <thead><tr><th>Account</th><th>State</th><th>Offsite</th><th>Last verified</th><th>Next due</th><th>Failures</th><th>Size</th></tr></thead>
          <tbody>{health.data.health.map(row => <tr key={row.account_id + (row.primary_domain || '')}>
            <td><strong>{row.account}</strong><div style={{ color: '#76848f' }}>{row.primary_domain || '—'}</div></td>
            <td><Tag tone={tone(row.status)}>{row.status_label || row.status}</Tag></td>
            <td><Tag tone={row.offsite_state === 'verified' ? 'ok' : row.offsite_state === 'not_configured' ? 'mute' : 'warn'}>{row.offsite_state.replace(/_/g, ' ')}</Tag></td>
            <td>{when(row.last_verified_at)}</td>
            <td>{when(row.next_due_at)}</td>
            <td>{row.consecutive_failures || 0}{row.failure_summary ? <div style={{ color: '#93332b' }}>{row.failure_summary}</div> : null}</td>
            <td>{bytes(row.bytes_total)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </Panel>}
  </>;
}

// ── Services ──────────────────────────────────────────────────────
function Services() {
  const [state] = useReading(() => reading('services'), []);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const all = state.data?.services || [];
    const q = query.trim().toLowerCase();
    return q ? all.filter(s => `${s.unit} ${s.description || ''}`.toLowerCase().includes(q)) : all;
  }, [state.data, query]);

  if (state.status === 'loading') return <Loading what="the services on this machine" />;
  if (state.status === 'error') return <Failed error={state.error} />;

  return <>
    <div className="ha-note">
      <strong style={{ display: 'block', marginBottom: 2 }}>Starting and stopping happens in the control panel</strong>
      Every service action goes through propose, approve and execute so it leaves a record, and that
      path lives on the panel's own Services screen. This is the operator's view of what is running.
    </div>
    <label className="ha-field"><span>Find a service</span>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="nginx, mariadb, ssh" />
    </label>
    <Panel title="Services" note={`${rows.length} of ${(state.data.services || []).length}`}>
      <div className="ha-scroll"><table className="ha-t">
        <thead><tr><th>Unit</th><th>State</th><th>Detail</th><th>Description</th></tr></thead>
        <tbody>{rows.map(s => <tr key={s.unit}>
          <td>{s.unit}</td>
          <td><Tag tone={s.active === 'active' ? 'ok' : s.active === 'failed' ? 'bad' : 'mute'}>{s.active}</Tag></td>
          <td style={{ color: '#5b6a78' }}>{s.sub}</td>
          <td style={{ color: '#5b6a78' }}>{s.description}</td>
        </tr>)}</tbody>
      </table></div>
    </Panel>
  </>;
}

// ── Security ──────────────────────────────────────────────────────
function Security() {
  const [firewall] = useReading(() => reading('firewall'), []);
  const [bans] = useReading(() => reading('fail2ban-bans'), []);
  const [keys] = useReading(() => reading('ssh-keys'), []);

  return <>
    {firewall.status === 'ready' && <Panel title="Firewall" note={firewall.data.active ? 'active' : 'not active'}>
      {(firewall.data.rules || []).length === 0 ? <div className="ha-empty">No rules.</div> : <div className="ha-scroll">
        <table className="ha-t">
          <thead><tr><th>#</th><th>Port or service</th><th>Action</th><th>Direction</th><th>From</th></tr></thead>
          <tbody>{firewall.data.rules.map(r => <tr key={r.index}>
            <td>{r.index}</td><td>{r.target}</td>
            <td><Tag tone={r.action === 'ALLOW' ? 'ok' : 'bad'}>{r.action}</Tag></td>
            <td>{r.direction}</td><td>{r.from}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </Panel>}
    {firewall.status === 'error' && <Failed error={`The firewall could not be read: ${firewall.error}`} />}

    {bans.status === 'ready' && <Panel title="Currently banned" note={`${(bans.data.bans || []).length} across ${(bans.data.jails || []).length} jail${(bans.data.jails || []).length === 1 ? '' : 's'}`}>
      {(bans.data.bans || []).length === 0 ? <div className="ha-empty">Nobody is banned right now.</div> : <div className="ha-scroll">
        <table className="ha-t">
          <thead><tr><th>Address</th><th>Jail</th><th>Banned</th></tr></thead>
          <tbody>{bans.data.bans.slice(0, 200).map((b, i) => <tr key={`${b.ip}-${b.jail}-${i}`}>
            <td>{b.ip}</td><td>{b.jail}</td><td>{when(b.banned_at)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </Panel>}

    {keys.status === 'ready' && <Panel title="Keys that can reach this machine over SSH" note={keys.data.path}>
      {(keys.data.keys || []).length === 0 ? <div className="ha-empty">No authorized keys.</div> : <div className="ha-scroll">
        <table className="ha-t">
          <thead><tr><th>#</th><th>Type</th><th>Comment</th><th>Fingerprint</th></tr></thead>
          <tbody>{keys.data.keys.map(k => <tr key={k.line}>
            <td>{k.line}</td><td>{k.type}</td><td>{k.comment || '—'}</td>
            <td style={{ fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 11 }}>{k.fingerprint}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </Panel>}
  </>;
}

// ── Audit ─────────────────────────────────────────────────────────
function Audit() {
  const [state] = useReading(() => api('/admin/api/audit?limit=500'), []);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const all = Array.isArray(state.data) ? state.data : [];
    const q = query.trim().toLowerCase();
    return q ? all.filter(r => `${r.action || ''} ${r.detail || ''} ${r.actor_name || ''} ${r.ip || ''}`.toLowerCase().includes(q)) : all;
  }, [state.data, query]);

  if (state.status === 'loading') return <Loading what="the audit record" />;
  if (state.status === 'error') return <Failed error={state.error} />;

  return <>
    <label className="ha-field"><span>Search the record</span>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="action, detail, person or address" />
    </label>
    <Panel title="Audit record" note={`${rows.length} of ${(Array.isArray(state.data) ? state.data : []).length} most recent`}>
      {rows.length === 0 ? <div className="ha-empty">Nothing matches that.</div> : <div className="ha-scroll">
        <table className="ha-t">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th><th>From</th></tr></thead>
          <tbody>{rows.slice(0, 300).map((r, i) => <tr key={r.id || i}>
            <td style={{ whiteSpace: 'nowrap' }}>{when(r.ts)}</td>
            <td>{r.actor_name || r.user_id || 'system'}</td>
            <td>{r.action}</td>
            <td style={{ color: '#5b6a78' }}>{r.detail || '—'}</td>
            <td style={{ color: '#76848f' }}>{r.ip || '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </Panel>
  </>;
}

// ── Licence ───────────────────────────────────────────────────────
//
// This installation's own registration, and nothing else. Issuing keys and
// carving allocations is the vendor's licence server's job and it is not on
// this machine, so there is nothing here pretending to do it.
function Licence() {
  const [state] = useReading(() => api('/api/license?refresh=1'), []);
  if (state.status === 'loading') return <Loading what="this installation's licence" />;
  if (state.status === 'error') return <Failed error={state.error} />;
  const d = state.data;
  const tone = !d.registered ? 'mute' : d.status === 'active' ? 'ok' : d.status === 'unreachable' ? 'warn' : 'bad';

  return <>
    <div className="ha-cards">
      <Card label="Registration" value={d.registered ? 'registered' : 'not registered'} sub={d.email || 'no address on file'} />
      <Card label="Status" value={d.status || 'unknown'} sub={`checked ${when(d.last_checked)}`} />
      <Card label="Assistant" value={d.assistant_available ? 'available' : 'unavailable'} sub="the only thing a licence gates" />
      <Card label="This panel" value={d.panel_available === false ? 'affected' : 'unaffected'} sub="a licence never stops the panel" />
    </div>
    <Panel title="What this means">
      <p style={{ margin: '0 0 10px' }}><Tag tone={tone}>{d.status || 'unknown'}</Tag></p>
      <p style={{ margin: 0, color: '#5b6a78' }}>
        {d.reason || 'The licence server answered and this installation is in good standing.'}
      </p>
      <p style={{ margin: '12px 0 0', color: '#5b6a78' }}>
        A licence decides whether this installation may connect to the thinking service. It never
        decides whether the panel runs. Everything on this server keeps working whatever this says.
      </p>
    </Panel>
  </>;
}

// ── Platform ──────────────────────────────────────────────────────
function Platform() {
  const [state, reload] = useReading(() => api('/api/platform/config'), []);
  const [label, setLabel] = useState(null);
  const [markup, setMarkup] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  // The assistant tier. Its own save button, because turning the paid tier on
  // for a whole deployment is not a thing to do by accident while renaming the
  // platform in the field above it.
  const [tierOn, setTierOn] = useState(false);
  const [tierPlans, setTierPlans] = useState('');
  const [tierSaving, setTierSaving] = useState(false);
  const [tierSaved, setTierSaved] = useState('');

  useEffect(() => {
    if (state.status === 'ready') {
      setLabel(state.data.label || '');
      setMarkup(state.data.markup == null ? '' : String(state.data.markup));
      setTierOn(state.data.assistantOps?.enabled === true);
      setTierPlans((state.data.assistantOps?.plans || []).join(', '));
    }
  }, [state.status, state.data]);

  if (state.status === 'loading') return <Loading what="this platform's settings" />;
  if (state.status === 'error') return <Failed error={state.error} />;

  const save = async () => {
    setSaving(true); setError(''); setSaved('');
    try {
      const body = { label: (label || '').trim() };
      const n = Number(markup);
      if (markup !== '' && Number.isFinite(n)) body.markup = n;
      await api('/api/platform/config', { method: 'PATCH', body: JSON.stringify(body) });
      setSaved('Saved.');
      reload();
    } catch (problem) { setError(problem.message); }
    finally { setSaving(false); }
  };

  const saveTier = async enabled => {
    setTierSaving(true); setError(''); setTierSaved('');
    try {
      const plans = tierPlans.split(',').map(p => p.trim()).filter(Boolean);
      // An empty list and no list are different answers. No list means every
      // plan on this deployment; sending an empty array would mean no plan at
      // all, which is the tier switched on and reaching nobody.
      await api('/api/platform/config', {
        method: 'PATCH',
        body: JSON.stringify({ assistantOps: { enabled, ...(plans.length ? { plans } : {}) } }),
      });
      setTierOn(enabled);
      setTierSaved(enabled ? 'The assistant may now do the work on this server.' : 'The assistant will answer, and will not do the work.');
      reload();
    } catch (problem) { setError(problem.message); }
    finally { setTierSaving(false); }
  };

  return <>
    {error && <Failed error={error} />}

    <Panel title="Letting the assistant do the work"
           note={tierOn ? 'on for this server' : 'off for this server'}>
      <p style={{ margin: '0 0 12px', color: '#5b6a78' }}>
        With this off, the assistant still answers questions and the panel still does everything by
        hand. What it will not do is act: a customer who asks it to add a site or make a mailbox gets
        a sentence back and no approval card. This is the switch between the free panel and the tier
        you charge for, and it starts off.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <Tag tone={tierOn ? 'ok' : 'mute'}>{tierOn ? 'The assistant may propose work' : 'Answers only'}</Tag>
        <button className={`ha-btn ${tierOn ? '' : 'primary'}`} disabled={tierSaving}
                onClick={() => saveTier(!tierOn)}>
          {tierSaving ? 'Saving…' : tierOn ? 'Turn it off' : 'Turn it on'}
        </button>
        {tierSaved && <span style={{ color: '#1c6b4c', fontSize: 12 }}>{tierSaved}</span>}
      </div>
      <label className="ha-field"><span>Plans this is part of</span>
        <input value={tierPlans} onChange={e => { setTierPlans(e.target.value); setTierSaved(''); }}
               placeholder="Leave empty for every plan on this server" />
      </label>
      <p style={{ margin: 0, color: '#5b6a78', fontSize: 11.5 }}>
        A customer below the line is told in a sentence that this is part of the named plan and that
        the panel still does everything by hand. Nothing they could do yesterday stops working.
      </p>
    </Panel>

    <Panel title="How this platform presents itself">
      <label className="ha-field"><span>Name shown to customers</span>
        <input value={label ?? ''} onChange={e => { setLabel(e.target.value); setSaved(''); }} placeholder="Hosted AI" />
      </label>
      <label className="ha-field"><span>Markup on AI usage, percent</span>
        <input value={markup ?? ''} onChange={e => { setMarkup(e.target.value); setSaved(''); }} inputMode="decimal" placeholder="20" />
      </label>
      <button className="ha-btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      {saved && <span style={{ marginLeft: 10, color: '#1c6b4c', fontSize: 12 }}>{saved}</span>}
    </Panel>
    <Panel title="Keys">
      <p style={{ margin: 0, color: '#5b6a78' }}>
        A platform AI key is {state.data.platformKey ? 'set on this server' : 'not set on this server'}.
        Customers bringing their own key is {state.data.byok === false ? 'switched off' : 'allowed'}.
      </p>
      <p style={{ margin: '10px 0 0', color: '#5b6a78' }}>
        The key itself is never sent to a browser, so it cannot be read back or edited here. It is set
        on the machine.
      </p>
    </Panel>
  </>;
}

// ── The surface ───────────────────────────────────────────────────
// The icon names are the ones the panel's own set actually has. Naming one it
// does not draws a blank square, which is how this shipped the first time.
const SECTIONS = [
  { group: 'This server', items: [
    ['overview', 'overview', 'Overview', Overview],
    ['services', 'server', 'Services', Services],
    ['security', 'shield', 'Security', Security],
  ] },
  { group: 'Customers', items: [
    ['accounts', 'user', 'Accounts', Accounts],
    ['backups', 'archive', 'Backups', Backups],
  ] },
  { group: 'This installation', items: [
    ['licence', 'license', 'Licence', Licence],
    ['platform', 'globe', 'Platform', Platform],
    ['audit', 'document', 'Audit record', Audit],
  ] },
];

// Groups this surface did not write, handed in rather than imported.
//
// The pool host's Fleet and Machines screens are JotNotes Navigator only and
// live in `fleet-admin.jsx`, which is absent from the JotPanel bundle. This
// file must therefore never name that file: a static import of a module that
// is not there does not degrade, it takes the whole screen down. So the group
// arrives as a value from whoever mounted the surface, the same way the
// desktop hands `desktopSections` to the panel's SettingsApp rather than the
// panel importing the desktop. `hoster.jsx` is what probes for the module.
//
// The gate is unchanged. Having the module says the product has the screens;
// `me.pool_host` says this install is a pool host, answered by `/api/me` on
// every load. Both are required, because the routes those screens read are
// mounted nowhere else and a nav entry on a customer's guest would be a link
// to a 404.
export const sectionsFor = (me, extraSections = []) => (
  me && me.pool_host && extraSections.length
    ? [SECTIONS[0], ...extraSections, ...SECTIONS.slice(1)]
    : SECTIONS
);

// Which section the address names. Validated against whatever is actually
// mounted rather than a fixed list, because the list grows when the optional
// module resolves: a deep link to /hoster/fleet has to still land on Fleet
// once it has, and has to fall back to the Overview where that module is not
// part of the product at all.
const pathId = () => window.location.pathname.replace(ROOT, '').replace(/^\/+|\/+$/g, '');

// One array rather than a fresh default on every render, so the memos below
// are not invalidated by the absence of a prop.
const NO_EXTRA_SECTIONS = [];

export function HosterAdminApp({ extraSections = NO_EXTRA_SECTIONS }) {
  // Three states, and they are not interchangeable. `null` means the question
  // has not been answered yet and nothing may be drawn; `false` means the
  // server said this caller is not the operator; an object means it is.
  const [who, setWho] = useState(null);
  const [refused, setRefused] = useState('');
  const [section, setSection] = useState(pathId);

  // Everything actually mounted, in nav order. It grows when the optional
  // module resolves, so it is recomputed rather than captured once.
  const groups = useMemo(() => sectionsFor(who, extraSections), [who, extraSections]);
  const flat = useMemo(() => groups.flatMap(g => g.items), [groups]);

  const ask = useCallback(async () => {
    try {
      const me = await api('/api/me');
      // The server's answer, every load. Not a prop, not local storage, and
      // not the shape of the URL somebody typed.
      if (me.is_operator) { setWho(me); setRefused(''); }
      else { setWho(false); setRefused(`Signed in as ${me.email}. This surface belongs to the account that runs this server.`); }
    } catch (error) {
      setWho(false);
      setRefused(error.status === 401 ? '' : error.message);
      if (error.status === 401) { removePanelStorage("jwt"); removePanelStorage("user"); }
    }
  }, []);

  useEffect(() => { ask(); }, [ask]);

  // The back button and a typed address mean the same thing here as anywhere.
  useEffect(() => {
    const onPop = () => setSection(pathId());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = id => {
    setSection(id);
    window.history.pushState({}, '', id === 'overview' ? ROOT : `${ROOT}/${id}`);
  };

  const signOut = () => {
    removePanelStorage("jwt");
    removePanelStorage("user");
    setWho(false);
    setRefused('');
  };

  if (who === null) return <div className="ha-gate"><style>{CSS}</style>
    <div className="ha-gate-box">Checking who you are…</div></div>;

  if (who === false) return <div className="ha-gate"><style>{CSS}</style>
    <div className="ha-gate-box">
      <div style={{ marginBottom: 14 }}><PanelIcon name="server" size={26} color="#8fbdd8" /></div>
      {refused
        // Signed in and refused. There is nothing to type, because the answer
        // is who you are, so no sign-in form is offered that could not help.
        ? <>
            <div style={{ fontSize: 14, color: '#fff', marginBottom: 8 }}>Host administration</div>
            <div role="alert" style={{ fontSize: 12, lineHeight: 1.6 }}>{refused}</div>
            <button className="ha-btn" style={{ marginTop: 16 }} onClick={signOut}>Sign in as somebody else</button>
          </>
        : <div className="panel-signin" style={{ background: 'transparent', padding: 0 }}>
            <JotPanelSignIn
              title="Host administration"
              subtitle="This is the operator's surface for this server."
              footnote="Sign in with the account that runs this server. A customer account cannot reach this."
              onAuth={() => { setWho(null); ask(); }} />
          </div>}
    </div></div>;

  // An address naming a section this product does not have falls back to the
  // Overview rather than rendering nothing, which is what the old fixed list
  // did for an unknown path and is what /hoster/fleet must do on a panel where
  // the Fleet screens are not part of the product.
  const [here, , title, Current] = flat.find(([id]) => id === section) || flat[0];

  return <div className="ha"><style>{CSS}</style>
    <aside className="ha-side">
      <div className="ha-brand">
        <div className="ha-brand-mark"><PanelIcon name="server" size={15} /></div>
        <div style={{ minWidth: 0 }}><strong>JotPanel</strong><span>Host admin</span></div>
      </div>
      <nav>
        {groups.map(group => <div key={group.group}>
          <div className="ha-group">{group.group}</div>
          {group.items.map(([id, icon, label]) => (
            <button key={id} className={`ha-link ${here === id ? 'on' : ''}`}
                    aria-current={here === id ? 'page' : undefined} onClick={() => go(id)}>
              <PanelIcon name={icon} size={14} />{label}
            </button>
          ))}
        </div>)}
      </nav>
      <div className="ha-foot">
        <button className="ha-link" onClick={signOut}><PanelIcon name="close" size={14} />Sign out</button>
      </div>
    </aside>
    <main className="ha-main">
      <header className="ha-top">
        <div><small>Host administration</small><h1>{title}</h1></div>
        <div className="ha-who">{who.email}<div style={{ color: '#8b98a5', fontSize: 10 }}>the account that runs this server</div></div>
      </header>
      <div className="ha-body"><Current /></div>
    </main>
  </div>;
}
