// The sign-in both shells use.
//
// It was written once inside the control panel and is needed twice now that the
// hoster's administration is its own surface with its own address. Copying it
// would mean two places to fix the day the second factor changes, and one of
// them would be missed, so it lives here and both import it.
//
// There is no option to send a magic link, on purpose (a link it is handed
// is honoured, below). The desktop signs in by mail
// because people reach it from their own inbox. A server does not: the
// installer creates the owner with a password and configures no mail server, so
// on a freshly installed box a magic link posts, answers ok, sends nothing, and
// leaves the owner locked out of the machine they just installed. Offering that
// door is the button-that-cannot-work rule broken at the front door.

import React, { useState, useEffect } from 'react'
import { readPanelStorage, writePanelStorage } from './panel-storage.js'

export function JotPanelSignIn({ title = "JotPanel", subtitle = "Sign in to run this server.", footnote, onAuth }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Set once the password has been accepted and the account has a second
  // factor. It is a ticket, not a session: it is good for proving the code and
  // for nothing else, and the server refuses it anywhere a real token goes.
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");

  const server = () => (readPanelStorage("server") || window.location.origin).replace(/\/$/, '');

  // What this server can actually offer. Asked rather than assumed, because a
  // passkey button on a box with no domain, or with nobody enrolled, sends
  // somebody into a browser prompt that can only fail.
  const [options, setOptions] = useState(null);
  useEffect(() => {
    fetch(`${server()}/api/auth/options`).then(r => r.json()).then(setOptions).catch(() => setOptions({}));
  }, []);

  const passkeyOffered = !!(options && options.passkey && options.passkey_enrolled
    && typeof window !== 'undefined' && window.PublicKeyCredential);

  const bytesFrom = value => {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
    return Uint8Array.from(binary, ch => ch.charCodeAt(0));
  };
  const toB64url = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // No email is typed and none is sent. The authenticator says which credential
  // it used and the server finds the account from that, so this cannot be used
  // to ask whether an address has an account here.
  const signInWithPasskey = async () => {
    setBusy(true); setError("");
    try {
      const optionsRes = await fetch(`${server()}/api/auth/passkey/options`, { method: 'POST' });
      const publicKey = await optionsRes.json();
      if (!optionsRes.ok) throw new Error(publicKey.error || 'This server could not start a passkey sign-in.');
      const assertion = await navigator.credentials.get({
        publicKey: {
          ...publicKey,
          challenge: bytesFrom(publicKey.challenge),
          allowCredentials: (publicKey.allowCredentials || []).map(c => ({ ...c, id: bytesFrom(c.id) })),
        },
      });
      if (!assertion) throw new Error('No passkey was offered.');
      const res = await fetch(`${server()}/api/auth/passkey/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response: {
            id: assertion.id,
            rawId: toB64url(assertion.rawId),
            type: assertion.type,
            clientExtensionResults: assertion.getClientExtensionResults(),
            response: {
              clientDataJSON: toB64url(assertion.response.clientDataJSON),
              authenticatorData: toB64url(assertion.response.authenticatorData),
              signature: toB64url(assertion.response.signature),
              userHandle: assertion.response.userHandle ? toB64url(assertion.response.userHandle) : null,
            },
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.error || `Passkey sign-in failed (${res.status})`);
      finish(data);
    } catch (problem) {
      setError(problem.name === 'NotAllowedError' ? 'That was cancelled, or the device timed out.' : problem.message);
      setBusy(false);
    }
  };

  const finish = data => {
    writePanelStorage("jwt", data.token);
    if (data.user) writePanelStorage("user", JSON.stringify(data.user));
    onAuth(data.user);
  };

  // The single-use link the installer prints, or a hosting company issues, for
  // the account's first way in. This screen never offers to send one; it only
  // honours one it is handed. The token leaves the address bar at once so it is
  // not kept in history or shown to anyone looking at the screen.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("magic");
    if (!token) return;
    params.delete("magic");
    const rest = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash);
    setBusy(true);
    fetch(`${server()}/api/auth/magic?token=${encodeURIComponent(token)}`)
      .then(async r => { const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || "That sign-in link did not work."); return data; })
      .then(data => { if (data.two_factor_required) { setChallenge(data.challenge); setBusy(false); return; } finish(data); })
      .catch(problem => { setError(`${problem.message} Ask for a new link, or sign in with the owner password.`); setBusy(false); });
  }, []);

  const submit = async event => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const res = await fetch(`${server()}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Sign-in failed (${res.status})`);
      // Half a sign-in. The password was right and the account has a second
      // factor, so the code screen comes next rather than the panel.
      if (data.two_factor_required) { setChallenge(data.challenge); setBusy(false); return; }
      // The server's own words, not a sentence invented here.
      if (!data.token) throw new Error(data.error || `Sign-in failed (${res.status})`);
      finish(data);
    } catch (problem) {
      setError(problem.message);
      setBusy(false);
    }
  };

  const submitCode = async event => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const res = await fetch(`${server()}/api/login/2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, code: code.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.error || `Sign-in failed (${res.status})`);
      finish(data);
    } catch (problem) {
      setError(problem.message);
      setBusy(false);
      // An expired ticket means starting again with the password, so say that
      // and put the password screen back rather than leaving a dead code box.
      if (/expired/i.test(problem.message)) { setChallenge(""); setCode(""); }
    }
  };

  if (challenge) return <form className="panel-login" onSubmit={submitCode}>
    <h1>One more step</h1>
    <p>Enter the six-digit code from your authenticator app.</p>
    <label htmlFor="panel-code">Code</label>
    <input id="panel-code" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus required
           value={code} onChange={e => setCode(e.target.value)} placeholder="000000"/>
    <button type="submit" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Continue"}</button>
    {error && <div className="panel-login-error" role="alert">{error}</div>}
    <small>Lost the device? Type one of your recovery codes here instead. Each one works once.</small>
  </form>;

  return <form className="panel-login" onSubmit={submit}>
    <h1>{title}</h1>
    <p>{subtitle}</p>
    <label htmlFor="panel-email">Email</label>
    <input id="panel-email" type="email" autoComplete="username" autoFocus required
           value={email} onChange={e => setEmail(e.target.value)} placeholder="owner@example.com"/>
    <label htmlFor="panel-password">Password</label>
    <input id="panel-password" type="password" autoComplete="current-password" required
           value={password} onChange={e => setPassword(e.target.value)}/>
    <button type="submit" disabled={busy || !email.trim() || !password}>{busy ? "Signing in…" : "Sign in"}</button>
    {/* Offered only where it can work: this server has a domain, somebody has
        actually registered a passkey, and the browser has the API. It sits
        under the password rather than above it because the password is still
        what every account on this box has, and calling the panel passkey-first
        while that is true would be a claim rather than a fact. */}
    {passkeyOffered && <>
      <div className="panel-login-or" aria-hidden="true">or</div>
      <button type="button" className="panel-login-alt" disabled={busy} onClick={signInWithPasskey}>
        Use a passkey
      </button>
    </>}
    {error && <div className="panel-login-error" role="alert">{error}</div>}
    {footnote !== null && <small>{footnote || "The owner account and its password were set when this panel was installed. The installation report records the address."}</small>}
  </form>;
}
