#!/usr/bin/env bash
# Transactional Arca-panel -> JotPanel layout compatibility. Source this file.

jotpanel_root_path() { printf '%s%s' "${JOTPANEL_LAYOUT_TEST_ROOT:-}" "$1"; }

jotpanel_move_with_alias() { # old new
  local old new
  old="$(jotpanel_root_path "$1")"; new="$(jotpanel_root_path "$2")"
  [[ -e "$old" || -L "$old" ]] || return 0
  [[ ! -e "$new" && ! -L "$new" ]] || return 0
  mkdir -p "$(dirname "$new")" || return 1
  mv "$old" "$new" || return 1
  # A folder its service loads by wildcard (conf.d/*.conf and the like) must not
  # keep the old name as a link: the service would read the same file twice.
  # nginx refused its whole configuration that way on the first real upgrade.
  case "$old" in
    */nginx/conf.d/*|*/fail2ban/jail.d/*|*/dovecot/conf.d/*|*/ssh/sshd_config.d/*) return 0 ;;
  esac
  ln -s "$new" "$old" || return 1
}

jotpanel_rewrite_env() { # file, writes only JOTPANEL names
  local file="$1" next="${1}.jotpanel-next"
  awk '
    /^[[:space:]]*#/ || !index($0,"=") { print; next }
    {
      key=substr($0,1,index($0,"=")-1); value=substr($0,index($0,"=")+1)
      if (key ~ /^ARCA_/) key="JOTPANEL_" substr(key,6)
      gsub("/opt/arca","/opt/jotpanel",value)
      gsub("/run/arca-ops","/run/jotpanel-ops",value)
      gsub("/var/lib/arca-ops","/var/lib/jotpanel-ops",value)
      gsub("/srv/arca-sites","/srv/jotpanel-sites",value)
      gsub("/var/backups/arca","/var/backups/jotpanel",value)
      gsub("/etc/arca-tls","/etc/jotpanel-tls",value)
      gsub("/etc/bind/arca-zones","/etc/bind/jotpanel-zones",value)
      print key "=" value
    }
  ' "$file" > "$next" || return 1
  { chmod --reference="$file" "$next" 2>/dev/null || chmod 0600 "$next"; } || return 1
  chown --reference="$file" "$next" 2>/dev/null || true
  mv "$next" "$file" || return 1
}

jotpanel_rewrite_managed_files() {
  local base file
  base="${JOTPANEL_LAYOUT_TEST_ROOT:-}"
  for file in \
    "$base/etc/nginx/conf.d/jotpanel.conf" \
    "$base/etc/nginx/sites-available/jotpanel-tls.conf" \
    "$base/etc/fail2ban/jail.d/jotpanel.conf" \
    "$base/etc/bind/named.conf.jotpanel"; do
    [[ -f "$file" ]] || continue
    sed -e 's#/opt/arca#/opt/jotpanel#g' \
        -e 's#/run/arca-ops#/run/jotpanel-ops#g' \
        -e 's#/var/lib/arca-ops#/var/lib/jotpanel-ops#g' \
        -e 's#/srv/arca-sites#/srv/jotpanel-sites#g' \
        -e 's#/var/backups/arca#/var/backups/jotpanel#g' \
        -e 's#/etc/arca-tls#/etc/jotpanel-tls#g' \
        -e 's#/etc/bind/arca-zones#/etc/bind/jotpanel-zones#g' \
        "$file" > "${file}.next" || return 1
    chmod --reference="$file" "${file}.next" 2>/dev/null || true
    chown --reference="$file" "${file}.next" 2>/dev/null || true
    mv "${file}.next" "$file" || return 1
  done
}

migrate_jotpanel_layout() {
  local old_root new_root data old new
  old_root="$(jotpanel_root_path /opt/arca)"; new_root="$(jotpanel_root_path /opt/jotpanel)"
  if [[ -L "$old_root" && -f "$new_root/app/backend/server.js" && -f "$new_root/.env" ]]; then return 0; fi
  [[ -f "$old_root/app/backend/server.js" && -f "$old_root/.env" ]] || return 1
  [[ ! -e "$new_root" && ! -L "$new_root" ]] || return 1

  JOTPANEL_ENV_BACKUP="$(mktemp "${TMPDIR:-/tmp}/jotpanel-env.XXXXXX")"
  cp -p "$old_root/.env" "$JOTPANEL_ENV_BACKUP" || return 1
  export JOTPANEL_ENV_BACKUP

  while read -r old new; do
    jotpanel_move_with_alias "$old" "$new" || return 1
  done <<'PAIRS'
/opt/arca /opt/jotpanel
/srv/arca-sites /srv/jotpanel-sites
/var/backups/arca /var/backups/jotpanel
/var/lib/arca-ops /var/lib/jotpanel-ops
/etc/arca-tls /etc/jotpanel-tls
/etc/bind/arca-zones /etc/bind/jotpanel-zones
/etc/nginx/conf.d/arca.conf /etc/nginx/conf.d/jotpanel.conf
/etc/nginx/sites-available/arca-tls.conf /etc/nginx/sites-available/jotpanel-tls.conf
/etc/fail2ban/jail.d/arca.conf /etc/fail2ban/jail.d/jotpanel.conf
/etc/bind/named.conf.arca /etc/bind/named.conf.jotpanel
/etc/postfix/arca-mailboxes /etc/postfix/jotpanel-mailboxes
/etc/postfix/arca-mailboxes.db /etc/postfix/jotpanel-mailboxes.db
/etc/postfix/arca-domains /etc/postfix/jotpanel-domains
/etc/postfix/arca-domains.db /etc/postfix/jotpanel-domains.db
/etc/postfix/arca-aliases /etc/postfix/jotpanel-aliases
/etc/postfix/arca-aliases.db /etc/postfix/jotpanel-aliases.db
/etc/postfix/arca-suspended /etc/postfix/jotpanel-suspended
/etc/postfix/arca-suspended.db /etc/postfix/jotpanel-suspended.db
/etc/dovecot/arca-users /etc/dovecot/jotpanel-users
/etc/dovecot/conf.d/99-arca-panel.conf /etc/dovecot/conf.d/99-jotpanel-panel.conf
/etc/nginx/snippets/arca-webmail.conf /etc/nginx/snippets/jotpanel-webmail.conf
/etc/ssh/sshd_config.d/arca-sftp.conf /etc/ssh/sshd_config.d/jotpanel-sftp.conf
PAIRS

  data="$new_root/data"
  if [[ -f "$data/arca.db" && ! -e "$data/jotpanel.db" ]]; then
    # The write-ahead log and its index travel with the database. Left behind
    # under the old name, SQLite opens the new name without them and the panel
    # starts empty: every account written since the last checkpoint is gone.
    # That is what the first real upgrade did, on 2026-09-23, and /health
    # still answered 200.
    mv "$data/arca.db" "$data/jotpanel.db" || return 1
    for side in -wal -shm; do
      if [[ -e "$data/arca.db$side" ]]; then mv "$data/arca.db$side" "$data/jotpanel.db$side" || return 1; fi
    done
    ln -s jotpanel.db "$data/arca.db" || return 1
  fi
  jotpanel_rewrite_env "$new_root/.env" || return 1
  jotpanel_rewrite_managed_files || return 1

  if [[ -z "${JOTPANEL_LAYOUT_TEST_ROOT:-}" ]]; then
    if getent group arca-suspended >/dev/null; then groupmod -n jotpanel-suspended arca-suspended || return 1; fi
    if getent group arca-sftp >/dev/null; then groupmod -n jotpanel-sftp arca-sftp || return 1; fi
    if getent group arca-ops >/dev/null; then groupmod -n jotpanel-ops arca-ops || return 1; fi
    if getent group arca >/dev/null; then groupmod -n jotpanel arca || return 1; fi
    if id arca >/dev/null 2>&1; then usermod -l jotpanel -d /opt/jotpanel arca || return 1; fi
  fi
}

rollback_jotpanel_layout() {
  local pair old new new_root data
  new_root="$(jotpanel_root_path /opt/jotpanel)"
  data="$new_root/data"
  if [[ -L "$data/arca.db" ]]; then rm -f "$data/arca.db"; fi
  if [[ -f "$data/jotpanel.db" && ! -e "$data/arca.db" ]]; then
    mv "$data/jotpanel.db" "$data/arca.db"
    for side in -wal -shm; do [[ -e "$data/jotpanel.db$side" ]] && mv "$data/jotpanel.db$side" "$data/arca.db$side"; done
  fi
  [[ -n "${JOTPANEL_ENV_BACKUP:-}" && -f "$JOTPANEL_ENV_BACKUP" ]] && cp -p "$JOTPANEL_ENV_BACKUP" "$new_root/.env"

  if [[ -z "${JOTPANEL_LAYOUT_TEST_ROOT:-}" ]]; then
    id jotpanel >/dev/null 2>&1 && usermod -l arca -d /opt/arca jotpanel
    getent group jotpanel >/dev/null && groupmod -n arca jotpanel
    getent group jotpanel-ops >/dev/null && groupmod -n arca-ops jotpanel-ops
    getent group jotpanel-sftp >/dev/null && groupmod -n arca-sftp jotpanel-sftp
    getent group jotpanel-suspended >/dev/null && groupmod -n arca-suspended jotpanel-suspended
  fi

  while read -r old new; do
    old="$(jotpanel_root_path "$old")"; new="$(jotpanel_root_path "$new")"
    [[ -L "$old" ]] && rm -f "$old"
    if [[ -e "$new" || -L "$new" ]]; then mkdir -p "$(dirname "$old")"; mv "$new" "$old"; fi
  done <<'PAIRS'
/etc/ssh/sshd_config.d/arca-sftp.conf /etc/ssh/sshd_config.d/jotpanel-sftp.conf
/etc/nginx/snippets/arca-webmail.conf /etc/nginx/snippets/jotpanel-webmail.conf
/etc/dovecot/conf.d/99-arca-panel.conf /etc/dovecot/conf.d/99-jotpanel-panel.conf
/etc/dovecot/arca-users /etc/dovecot/jotpanel-users
/etc/postfix/arca-suspended.db /etc/postfix/jotpanel-suspended.db
/etc/postfix/arca-suspended /etc/postfix/jotpanel-suspended
/etc/postfix/arca-aliases.db /etc/postfix/jotpanel-aliases.db
/etc/postfix/arca-aliases /etc/postfix/jotpanel-aliases
/etc/postfix/arca-domains.db /etc/postfix/jotpanel-domains.db
/etc/postfix/arca-domains /etc/postfix/jotpanel-domains
/etc/postfix/arca-mailboxes.db /etc/postfix/jotpanel-mailboxes.db
/etc/postfix/arca-mailboxes /etc/postfix/jotpanel-mailboxes
/etc/bind/named.conf.arca /etc/bind/named.conf.jotpanel
/etc/fail2ban/jail.d/arca.conf /etc/fail2ban/jail.d/jotpanel.conf
/etc/nginx/sites-available/arca-tls.conf /etc/nginx/sites-available/jotpanel-tls.conf
/etc/nginx/conf.d/arca.conf /etc/nginx/conf.d/jotpanel.conf
/etc/bind/arca-zones /etc/bind/jotpanel-zones
/etc/arca-tls /etc/jotpanel-tls
/var/lib/arca-ops /var/lib/jotpanel-ops
/var/backups/arca /var/backups/jotpanel
/srv/arca-sites /srv/jotpanel-sites
/opt/arca /opt/jotpanel
PAIRS
}
