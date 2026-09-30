# Upgrading JotPanel

The supported upgrade is transactional: it builds the new release beside the running one, stops the
two panel services, switches application trees, starts both services and waits for `/health`. If the
new panel or the privileged service does not come up, it restores the previous application and starts
it again. The previous release stays at `/opt/jotpanel/app.previous` until the next upgrade.

## Before you start

1. Take a backup and move it off the machine. JotPanel's state is `/opt/jotpanel/data`.
2. Keep the bundle you are running now.
3. Read the changelog for the range you are crossing.

## The command

```bash
sudo bash upgrade.sh \
  --bundle-file /root/jotpanel.tar.gz \
  --bundle-sha256 "$(awk 'NR==1 {print $1}' /root/jotpanel.tar.gz.sha256)"
```

Then read the result rather than assuming the restart was enough:

```bash
systemctl status jotpanel jotpanel-ops
curl -fsS https://panel.example.com/health
cat /opt/jotpanel/upgrade-report.txt
```

## Upgrading an installation from before the JotPanel rename

The same command detects `/opt/arca` when `/opt/jotpanel` does not exist. Running the new
`install.sh` on that box also hands the bundle to this upgrader rather than refusing the existing
installation.

During the stopped-service window it moves the install, database, site root, backup root, operations
state, TLS files, BIND zones and managed nginx/fail2ban files to their JotPanel names. It rewrites the
`.env` file to `JOTPANEL_*`, renames the unprivileged account and operations group, renders new units
and starts `jotpanel-ops` before `jotpanel`. Old filesystem names remain symlinks, existing nginx site
files and systemd site jobs remain readable under their old names and settings continue to accept
`ARCA_*` as a fallback. This is what keeps sites, mail, DNS and databases serving while the panel's
own identity changes.

If a move, unit render or health check fails, the upgrader stops the new units, restores the old app,
names, environment and paths and starts `arca-ops` and `arca` again. Re-running after success is
idempotent.

## What the upgrade does not rename

The licence protocol keeps its original names. Existing `ARCA-` keys and `X-Arca-*` licence headers
identify registered boxes, so they are unchanged.

## After the upgrade

- Both JotPanel units should be active and `NRestarts` should remain 0.
- Sign in once. The browser reads an old `arca_jwt` session and every new write uses `jotpanel_jwt`.
- Check the Approval desk. Waiting proposals remain waiting.
- A successful local/unit run is built and tested, not live-proved. The test-box proof is a separate
  Claude run and is recorded only after the machine has been read back.
