# Configuration reference

Every setting the panel reads at boot, where it comes from, and what happens when it is wrong.

Configuration lives in one file, `/opt/jotpanel/.env`, written by the installer and owned by root with
the panel's group. The panel reads it at start and does not watch it, so a change takes effect on
`systemctl restart jotpanel`.

Nothing here needs editing on a normal install. The installer sets what it needs to, and the things
an operator changes day to day, so the panel's domain, packages, backup destinations and the rest,
are changed from inside the panel and not from this file.

Every `JOTPANEL_*` setting below is read first. Its former `ARCA_*` spelling is a permanent fallback
for existing installations, but the installer, the domain operation and the migration write only the
new name. `JOTPANEL_LICENSE_URL` follows that rule; the licence request itself deliberately keeps its
`X-Arca-*` headers and `ARCA-` key format, so registered boxes keep working.

---

## What the installer writes

| Key | Default | What it is |
|---|---|---|
| `NODE_ENV` | `production` | Anything other than `production` turns on development behaviour. Leave it. |
| `PORT` | `9999` | The panel's own listener. nginx proxies to it. Not reachable from outside. |
| `JOTPANEL_BOOTSTRAP_PORT` | `9998` | The loopback surface that creates the first owner and then refuses. Never exposed. |
| `DOMAIN` | your domain | The panel's name, or the machine's address when it was installed without one. |
| `JOTPANEL_PUBLIC_ORIGIN` | `https://DOMAIN` | The origin the panel believes it is served from. Sign-in links and certificate checks use it. |
| `JOTPANEL_VERSION` | bundle version | Reported in the panel and in the install report. |
| `JOTPANEL_DATA_DIR` | `/opt/jotpanel/data` | The panel's database and its action record. Back this up. |
| `UPLOADS_DIR` | `/opt/jotpanel/uploads` | Files people upload through the panel. |
| `JOTPANEL_JOB_ROOT` | `/opt/jotpanel` | Where job working directories are made. |
| `JWT_SECRET` | generated | Signs sessions. Changing it signs everybody out. |
| `ADMIN_KEY` | generated | Authorises the loopback bootstrap surface only. |
| `JOTPANEL_ENCRYPT_SECRET` | generated | Encrypts stored credentials, including backup destinations. **Losing it loses access to everything encrypted with it, and no backup restores without it.** |
| `JOTPANEL_LICENSE_URL` | the JotNotes licence service | Where registration talks to. Registration is optional and off until asked for. |
| `JOTPANEL_PROVISIONING_ADAPTER` | `native` | `native` means the panel runs this machine itself. |
| `JOTPANEL_OPS_SOCKET` | install path | The Unix socket to the privileged service. |
| `OLLAMA_BASE` | loopback | The local engine endpoint, used only when one is installed. |
| `MAX_UPLOAD_MB` | `1024` | Largest single upload the panel accepts. |

The three generated secrets are generated per machine. Two machines never share them, and there is
no vendor copy of any of them.

## Optional, and what each one is for

| Key | What it does |
|---|---|
| `JOTPANEL_PANEL_PORT` | The recovery surface's port, default `7443`. It answers directly rather than through nginx, so the panel is still reachable when nginx is what is broken. |
| `JOTPANEL_PANEL_CERT`, `JOTPANEL_PANEL_KEY` | Certificate and key for that recovery surface. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Where the panel sends its own mail, meaning sign-in links and alerts. Without these the panel still works and simply cannot send. |
| `JOTPANEL_BACKUP_ALERT_TO` | Address that gets told when a scheduled backup fails. |
| `JOTPANEL_THINKING_URL`, `JOTPANEL_CONCIERGE_BRAIN`, `JOTPANEL_CONCIERGE_MODEL` | Optional hosted engine for Echo. Leave unset: Echo then answers with the AI key added in Settings, and that key stays on this server. |
| `AI_MONTHLY_CAP_USD` | A hard monthly ceiling on assistant spend for the deployment. |
| `JOTPANEL_GPU_OLLAMA_BASE`, `JOTPANEL_OLLAMA_KEEP_ALIVE` | A GPU engine elsewhere on your network, and how long it holds a model in memory. |
| `JOTPANEL_OWNER_EMAIL` | The owner the machine was installed for. Read for display. |
| `JOTPANEL_ENV_FILE` | Where the panel looks for this file, when it is not in the install directory. |

## The privileged service

`jotpanel-ops` reads its own small set, and these are set by its unit file rather than by hand.

| Key | What it is |
|---|---|
| `JOTPANEL_OPS_STATE_DIR` | Where the privileged half keeps its state. |
| `JOTPANEL_OPS_SITE_ROOT` | Where site document roots are made. |
| `JOTPANEL_OPS_BACKUP_ROOT` | Where backups are written on this machine. |
| `JOTPANEL_BACKUP_MAX_AGE_DAYS` | How long a backup may exist before it is destroyed: `30`, `60` or `90` (default `90`). Any other value is refused. |
| `JOTPANEL_EDU_BOARD_ARCHIVE` | A board records destination on another machine, as `<provider>:<json>` using the backup destinations, e.g. `sftp.generic:{"host":…,"username":…,"private_key":…,"directory":"/records"}`. Copies are staged here first and shipped after; a failed shipment stays in staging with its reason and is retried. Takes precedence over the directory. |
| `JOTPANEL_EDU_STAGING_DAYS` | How long a transfer copy stays in staging after the board has confirmed receipt (default `30`). |
| `JOTPANEL_OPS_ZONE_DIR` | Where DNS zone files live. |
| `JOTPANEL_OPS_RUNTIME_DIR`, `JOTPANEL_OPS_DB_PREFIX`, `JOTPANEL_OPS_GROUP`, `JOTPANEL_OPS_SSH_AUTHORIZED_KEYS` | Paths and names it uses when it makes something. |

## Test-only settings

`JOTPANEL_BACKUP_FAULT` and `JOTPANEL_BACKUP_FAULT_INJECTION` make a backup fail on purpose, so the failure
path can be proved rather than assumed. `JOTPANEL_DEMO_TENANTS`, `JOTPANEL_DEMO_TTL_HOURS` and
`JOTPANEL_DEMO_CAP_USD` belong to the demo mode. None of these belong on a production machine.

## Changing the panel's domain

Do not edit `DOMAIN` by hand. There is an operation for it, `panel.domain.set`, which changes the
name, the nginx site and the certificate together and writes the change to the record. Editing the
file changes one of those three and leaves the machine disagreeing with itself.

**It has a screen, in Settings, as of 2026-09-10.** It asks for the name, a contact address for the
certificate, and offers a test certificate for a first attempt, because the certificate authority
allows only a handful of failures a week for the same name. The operation refuses a name that does
not already resolve to this machine and says what it resolved to instead, so a wrong name costs
nothing.

**`--domain` at install is still the better path**, and the installer offers both. Naming the panel
during installation avoids the restart: changing the name afterwards fetches a certificate and
restarts the panel, so anybody signed in is signed out for a moment.

## After any change

```bash
sudo systemctl restart jotpanel
systemctl status jotpanel jotpanel-ops
curl -fsS https://panel.example.com/health
```

If the panel does not come back, `journalctl -u jotpanel -n 100 --no-pager` says why on the first or
second screen, and `docs/TROUBLESHOOTING.md` covers the common causes.
