# JotPanel — Deploy Guide

## What you need before starting

- Ubuntu 22.04 or 24.04 VPS (1GB RAM minimum, 2GB recommended)
- A domain with an A record pointing at your VPS IP
- SMTP credentials (Gmail app password works fine for launch)
- SSH access to the VPS

---

## Option A — One-line installer (recommended)

```bash
ssh root@your-vps-ip
curl -sSL https://raw.githubusercontent.com/yourusername/jotpanel/main/install.sh | bash
```

The installer handles everything: Node 20, npm install, .env generation,
systemd service, nginx, certbot SSL, UFW firewall, fail2ban.

---

## Option B — Manual deploy

### 1. Install Node 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Set up app directory

```bash
sudo mkdir -p /opt/jotpanel/app /opt/jotpanel/data/uploads
sudo useradd -r -s /bin/false www-data  # skip if exists
git clone https://github.com/yourusername/jotpanel /opt/jotpanel/app
cd /opt/jotpanel/app
npm install --production
```

### 3. Configure environment

```bash
cp deploy/.env.production /opt/jotpanel/app/.env
nano /opt/jotpanel/app/.env
```

Fill in:
- `JWT_SECRET` — run `openssl rand -hex 32`
- `ADMIN_KEY` — run `openssl rand -hex 16`
- `JOTPANEL_ENCRYPT_SECRET` — run `openssl rand -hex 32`. Keys the AES-256-GCM encryption of stored
  mail and deploy credentials. Set it on a FRESH install only; on a box with existing data it
  falls back to JWT_SECRET and must stay that way (changing it orphans the encrypted rows).
- `DOMAIN` — your domain without https://
- `APP_URL` — full URL with https://
- SMTP credentials

### 3b. Echo voice service (Kokoro TTS + Whisper STT)

```bash
cd /opt/jotpanel/app/backend/tts && ./setup.sh
```

One idempotent command: builds the Python venv, installs the pinned voice stack (picks
faster-whisper automatically on Linux, mlx-whisper on Apple Silicon), downloads the two Kokoro
model files (~340MB) if missing and self-checks by synthesizing a clip. `server.js` spawns
`tts_server.py` on 127.0.0.1:9998 at boot; without this step Echo still runs, the voice just
falls back down the chain (ElevenLabs/OpenAI key or browser voices).

### 4. Install systemd service

```bash
sudo cp deploy/jotpanel.service /etc/systemd/system/jotpanel.service
sudo systemctl daemon-reload
sudo systemctl enable jotpanel
sudo systemctl start jotpanel
sudo systemctl status jotpanel  # should show "active (running)"
```

### 5. Install and configure nginx

```bash
sudo apt install -y nginx
sudo cp deploy/nginx.jotpanel.conf /etc/nginx/sites-available/jotpanel
sudo ln -s /etc/nginx/sites-available/jotpanel /etc/nginx/sites-enabled/jotpanel
sudo nginx -t  # must say "syntax is ok"
sudo systemctl reload nginx
```

### 6. SSL certificate

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.yourdomain.com
```

Certbot edits the nginx config automatically and sets up auto-renewal.

Verify renewal is active:
```bash
sudo systemctl status certbot.timer
```

### 7. Verify

```bash
# Check app is running
curl http://localhost:3000/health

# Run full test suite
node test.js https://app.yourdomain.com
```

---

## Magic link SMTP

In dev mode, magic links are logged to the console — no SMTP needed.

In production (`NODE_ENV=production`), SMTP is required for magic links.
If SMTP is not configured, login will fail silently.

Test your SMTP config:
```bash
curl -X POST https://app.yourdomain.com/api/auth/magic \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com"}'
```

Check the server logs if you don't receive the email:
```bash
sudo journalctl -u jotpanel -f
```

---

## Updating

```bash
cd /opt/jotpanel/app
git pull
npm install --production
sudo systemctl restart jotpanel
```

---

## Administering the machine

**There is no remote admin API behind a shared key, and the examples that used
to be here were wrong even before they were unsafe.** `ADMIN_KEY` is not a
credential for administering this box over the network. It reaches four
bootstrap routes on `127.0.0.1:9998`, a listener that is not proxied and not
part of the app served on the public ports, and it can neither create an
ordinary account, suspend one, reset a password nor sign in as anybody.

**Accounts, suspension, packages and limits are done by signing in.** Everything
a hosting company or a reseller does is a catalogue operation, proposed,
approved, executed and recorded against the identity that asked for it. The
ownership engine decides who may act on whom, so a reseller reaches its own
customers and nobody else's. That is the panel, `/hoster`, or the same
operations over the API with a signed-in session.

**Machines get their own credentials.** A billing system, a provisioning script
or a monitor that needs to call this panel is issued an API key from Settings,
which carries the identity and organization of whoever made it, may only narrow
what that person could do, is refused on the next call once revoked, and is
named in the audit record as itself. That is how a Stripe or WHMCS integration
provisions an account: `account.create` as the hosting company, not a global key
that bypasses the packages the account was sold.

```bash
# On the machine itself, and only there: the bootstrap surface.
# Creating the first owner. Refused once any account exists.
curl -X POST http://127.0.0.1:9998/admin/api/accounts \
  -H "x-admin-key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Owner","email":"owner@example.com","password":"..."}'

# Clearing a second factor for somebody who lost the phone and the codes.
curl -X POST http://127.0.0.1:9998/admin/api/accounts/USER_ID/2fa/reset \
  -H "x-admin-key: $ADMIN_KEY"
```

Monitoring is the one thing that still reads over the network with the key:
`/admin/ops` and `/admin/ai-health` answer a probe that cannot sign in. Both are
read-only, and an operator's own session reads them too.

---

## File locations

```
/opt/jotpanel/app/          — application code
/opt/jotpanel/app/.env      — environment config
/opt/jotpanel/data/         — persistent data (backups go here)
/opt/jotpanel/data/jotpanel.db  — SQLite database
/opt/jotpanel/data/uploads/ — user file uploads
```

## Backup

```bash
# Database
cp /opt/jotpanel/data/jotpanel.db /backup/jotpanel-$(date +%Y%m%d).db

# Uploads
tar -czf /backup/uploads-$(date +%Y%m%d).tar.gz /opt/jotpanel/data/uploads/
```

---

## Go-live validation (do NOT skip)

The control-panel provisioning path ships with a **real cPanel/WHM adapter that has
only been proven offline** (`provisioning/cpanelAdapter.test.js`, fake transport). It has
never executed against a live WHM. Before telling any customer the control panel works:

1. **Set the cPanel env** in `/opt/jotpanel/app/.env` and restart:
   ```
   CPANEL_WHM_HOST=whm.yourhost.com
   CPANEL_WHM_API_TOKEN=...        # WHM » Development » Manage API Tokens
   # CPANEL_TLS_INSECURE=1         # only if the WHM cert is self-signed
   ```
   On boot the log must read `[provisioning] real cPanel adapter active → whm.yourhost.com`.
   If it says `mock adapter`, the env is not set and nothing will really provision.

2. **Run one real call end to end** against a throwaway test cPanel account:
   propose → approve → execute a `fetch_account_stats` (read-only, safe) first, then a
   `add_dns_record` on a domain you own. Confirm the record actually appears in WHM.

3. **Confirm the FTP allowlist caveat.** `create_ftp_account` returns
   `enforcement.applied=false` on purpose — cPanel cannot set a per-user source-IP rule.
   Do not advertise IP-locked FTP until a firewall backend is wired.

Only after a real execute succeeds is Phase 2 truly done on this box.
