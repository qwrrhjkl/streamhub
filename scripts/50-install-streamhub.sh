#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib/common.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_root
require_ubuntu_2404
init_install_log "50-install-streamhub"
require_marker "40-build-ffmpeg-decklink"

SOURCE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
[[ "${SOURCE_ROOT}" == "${STREAMHUB_PREFIX}" ]] \
  || fail "Extract the release as ${STREAMHUB_PREFIX} before running the numbered scripts."

getent group video >/dev/null || groupadd --system video
getent group audio >/dev/null || groupadd --system audio
getent group render >/dev/null || groupadd --system render
if ! id streamhub >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/streamhub --create-home --shell /usr/sbin/nologin streamhub
fi
usermod -a -G video,audio,render streamhub

apt-get install -y --no-install-recommends polkitd

install -d -o streamhub -g streamhub -m 0750 \
  "${STREAMHUB_PREFIX}/data" \
  "${STREAMHUB_PREFIX}/data/logs" \
  "${STREAMHUB_PREFIX}/data/monitor-history" \
  "${STREAMHUB_PREFIX}/data/recordings" \
  "${STREAMHUB_PREFIX}/data/slideshow-cache" \
  "${STREAMHUB_PREFIX}/data/watermarks"
chown -R streamhub:streamhub "${STREAMHUB_PREFIX}/data"

install -d -m 0750 /etc/streamhub
install -d -o root -g root -m 0750 /var/backups/streamhub/updater
if [[ ! -f /etc/streamhub/streamhub.env ]]; then
  install -o root -g streamhub -m 0640 \
    "${STREAMHUB_PREFIX}/config/streamhub.env.example" /etc/streamhub/streamhub.env
else
  pass "Keeping existing /etc/streamhub/streamhub.env."
fi

auth_password="$(sed -n 's/^STREAMHUB_AUTH_PASSWORD=//p' /etc/streamhub/streamhub.env | tail -n 1)"
if [[ -z "${auth_password}" || "${auth_password}" == "REPLACE_WITH_A_LONG_RANDOM_PASSWORD" ]]; then
  fail "Set a unique STREAMHUB_AUTH_PASSWORD in /etc/streamhub/streamhub.env, then rerun this script."
fi

install -o root -g root -m 0644 "${STREAMHUB_PREFIX}/services/streamhub.service" /etc/systemd/system/streamhub.service
install -o root -g root -m 0644 "${STREAMHUB_PREFIX}/services/streamhub-rtmp.service" /etc/systemd/system/streamhub-rtmp.service
install -o root -g root -m 0644 "${STREAMHUB_PREFIX}/services/streamhub-poweroff.service" /etc/systemd/system/streamhub-poweroff.service
install -o root -g root -m 0644 "${STREAMHUB_PREFIX}/services/streamhub-update.service" /etc/systemd/system/streamhub-update.service
install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
install -o root -g root -m 0644 "${STREAMHUB_PREFIX}/services/streamhub-poweroff.rules" /etc/polkit-1/rules.d/50-streamhub-poweroff.rules
install -o root -g root -m 0644 "${STREAMHUB_PREFIX}/services/streamhub-update.rules" /etc/polkit-1/rules.d/51-streamhub-update.rules
install -o root -g root -m 0644 "${STREAMHUB_PREFIX}/services/streamhub-logrotate" /etc/logrotate.d/streamhub
install -d -o streamhub -g streamhub -m 0750 /run/streamhub-rtmp
runuser -u streamhub -- nginx -t -c "${STREAMHUB_PREFIX}/services/nginx-rtmp.conf" -p "${STREAMHUB_PREFIX}"
systemctl daemon-reload
systemctl enable streamhub.service streamhub-rtmp.service
systemctl restart streamhub.service
systemctl restart streamhub-rtmp.service

for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:18080/api/health >/dev/null \
    && curl -fsS http://127.0.0.1:18081/health >/dev/null; then
    break
  fi
  if (( attempt == 30 )); then
    systemctl --no-pager --full status streamhub.service streamhub-rtmp.service || true
    fail "Services did not become healthy within 30 seconds."
  fi
  sleep 1
done

mark_complete "50-install-streamhub"
pass "StreamHub services are installed. Continue with scripts/60-verify.sh"
