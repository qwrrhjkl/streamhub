#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib/common.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_root
require_ubuntu_2404
init_install_log "60-verify"
require_marker "50-install-streamhub"

failures=0
FFMPEG="${STREAMHUB_PREFIX}/runtime/ffmpeg/bin/ffmpeg"
FFPROBE="${STREAMHUB_PREFIX}/runtime/ffmpeg/bin/ffprobe"

required() {
  local label="${1:?label required}"
  shift
  if "$@" >/dev/null 2>&1; then
    pass "${label}"
  else
    printf '[FAIL] %s\n' "${label}" >&2
    failures=$((failures + 1))
  fi
}

required "Node.js is available" node --version
required "Custom FFmpeg is executable" test -x "${FFMPEG}"
required "Custom ffprobe is executable" test -x "${FFPROBE}"
if nvenc_enabled; then
  required "NVIDIA driver is active" nvidia-smi
else
  pass "NVIDIA driver check skipped; CPU encoding profile is active"
fi
required "StreamHub application service is active" systemctl is-active --quiet streamhub.service
required "StreamHub RTMP service is active" systemctl is-active --quiet streamhub-rtmp.service
required "Restricted StreamHub poweroff unit is installed" test -f /etc/systemd/system/streamhub-poweroff.service
required "Restricted StreamHub poweroff policy is installed" test -f /etc/polkit-1/rules.d/50-streamhub-poweroff.rules
required "Application health endpoint responds" curl -fsS http://127.0.0.1:18080/api/health
required "RTMP health endpoint responds" curl -fsS http://127.0.0.1:18081/health
required "Nginx RTMP configuration is valid" runuser -u streamhub -- nginx -t -c "${STREAMHUB_PREFIX}/services/nginx-rtmp.conf" -p "${STREAMHUB_PREFIX}"
required "StreamHub log rotation configuration is valid" logrotate -d /etc/logrotate.d/streamhub
required "Seven-day application log maintenance is installed" node -e "const value=require('${STREAMHUB_PREFIX}/server/lib/logManager').RETENTION_MS; process.exit(value === 7 * 24 * 60 * 60 * 1000 ? 0 : 1)"

encoder_text="$("${FFMPEG}" -hide_banner -encoders 2>/dev/null || true)"
if nvenc_enabled; then
  grep -q h264_nvenc <<<"${encoder_text}" && pass "FFmpeg exposes h264_nvenc" || { printf '[FAIL] FFmpeg does not expose h264_nvenc\n' >&2; failures=$((failures + 1)); }
else
  grep -q libx264 <<<"${encoder_text}" && pass "FFmpeg exposes CPU libx264" || { printf '[FAIL] FFmpeg does not expose CPU libx264\n' >&2; failures=$((failures + 1)); }
fi
device_text="$("${FFMPEG}" -hide_banner -devices 2>/dev/null || true)"
if [[ -f /etc/streamhub/blackmagic-sdk.env ]]; then
  grep -q decklink <<<"${device_text}" && pass "FFmpeg exposes DeckLink input" || { printf '[FAIL] FFmpeg does not expose DeckLink input\n' >&2; failures=$((failures + 1)); }
else
  pass "DeckLink check skipped; USB V4L2/ALSA capture profile is active"
fi
source_text="$("${FFMPEG}" -hide_banner -sources decklink 2>&1 || true)"
decklink_source_row_pattern='^[[:space:]]*[^[:space:]]+[[:space:]]+\[[^]]+\][[:space:]]+\([^)]*\)[[:space:]]*$'
if [[ ! -f /etc/streamhub/blackmagic-sdk.env ]]; then
  pass "DeckLink device enumeration skipped"
elif grep -Eq "${decklink_source_row_pattern}" <<<"${source_text}" \
  || grep -Eq '^[[:space:]]*"[^"]+"[[:space:]]+\[' <<<"${source_text}" \
  || grep -Eq "\][[:space:]]+'[^']+'[[:space:]]*$" <<<"${source_text}"; then
  pass "FFmpeg enumerates a Blackmagic DeckLink device"
  warn "Live SDI/HDMI signal lock is not required by this static check; validate the selected format from StreamHub before production."
else
  printf '[FAIL] No Blackmagic DeckLink device was enumerated\n' >&2
  failures=$((failures + 1))
fi

if [[ -f /etc/streamhub/blackmagic-sdk.env ]]; then
  firmware_log="$(dmesg 2>/dev/null || true)"
  if grep -Eqi 'BlackmagicIO: WARNING:.*firmware version mismatch|firmware version mismatch' <<<"${firmware_log}"; then
    printf '[FAIL] Blackmagic firmware version mismatch; run the Desktop Video firmware updater, reboot, then rerun verification\n' >&2
    failures=$((failures + 1))
  else
    pass "Blackmagic firmware matches the loaded Desktop Video driver"
  fi
else
  pass "Blackmagic firmware check skipped"
fi

port_in_use tcp 18080 && pass "Web/API listens on TCP 18080" || { printf '[FAIL] TCP 18080 is not listening\n' >&2; failures=$((failures + 1)); }
port_in_use tcp 1935 && pass "RTMP listens on TCP 1935" || { printf '[FAIL] TCP 1935 is not listening\n' >&2; failures=$((failures + 1)); }

health_socket_text="$(ss -H -ltn 'sport = :18081' 2>/dev/null || true)"
health_loopback_only=true
while IFS= read -r socket_line; do
  [[ -n "${socket_line}" ]] || continue
  if [[ ! "${socket_line}" =~ [[:space:]]127\.0\.0\.1:18081[[:space:]] ]]; then
    health_loopback_only=false
  fi
done <<<"${health_socket_text}"
if [[ -n "${health_socket_text}" && "${health_loopback_only}" == true ]]; then
  pass "RTMP health listens only on loopback TCP 18081"
else
  printf '[FAIL] Loopback-only TCP 18081 is not listening\n' >&2
  failures=$((failures + 1))
fi

if (( failures > 0 )); then
  fail "Verification completed with ${failures} required failure(s)."
fi
mark_complete "60-verify"
pass "All required StreamHub deployment checks passed."
