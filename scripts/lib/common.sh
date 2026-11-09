#!/usr/bin/env bash
set -euo pipefail

STREAMHUB_PREFIX="${STREAMHUB_PREFIX:-/opt/StreamHub}"
INSTALL_STATE_DIR="${INSTALL_STATE_DIR:-/var/lib/streamhub-install}"
INSTALL_LOG_DIR="${INSTALL_LOG_DIR:-/var/log/streamhub-install}"

log() { printf '[INFO] %s\n' "$*"; }
pass() { printf '[PASS] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

nvidia_gpu_present() {
  if command_exists lspci && lspci -nn 2>/dev/null | grep -qi 'NVIDIA'; then
    return 0
  fi
  local vendor_file vendor
  for vendor_file in /sys/class/drm/card*/device/vendor; do
    [[ -r "${vendor_file}" ]] || continue
    vendor="$(cat "${vendor_file}")"
    [[ "${vendor,,}" == "0x10de" ]] && return 0
  done
  return 1
}

write_hardware_profile() {
  local nvenc_enabled="0"
  if nvidia_gpu_present; then nvenc_enabled="1"; fi
  install -d -m 0750 /etc/streamhub
  printf 'STREAMHUB_NVENC_ENABLED=%s\n' "${nvenc_enabled}" > /etc/streamhub/streamhub-hardware.env
  chmod 0640 /etc/streamhub/streamhub-hardware.env
}

nvenc_enabled() {
  [[ -f /etc/streamhub/streamhub-hardware.env ]] \
    && grep -q '^STREAMHUB_NVENC_ENABLED=1$' /etc/streamhub/streamhub-hardware.env
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "Run this script as root (sudo)."
}

require_ubuntu_2404() {
  [[ -r /etc/os-release ]] || fail "/etc/os-release is missing."
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] \
    || fail "Ubuntu Server 24.04 is required; found ${PRETTY_NAME:-unknown}."
  [[ "$(dpkg --print-architecture)" == "amd64" ]] || fail "amd64 architecture is required."
}

init_install_log() {
  local script_name="${1:?script name required}"
  install -d -m 0750 "${INSTALL_LOG_DIR}" "${INSTALL_STATE_DIR}"
  exec > >(tee -a "${INSTALL_LOG_DIR}/${script_name}.log") 2>&1
}

port_in_use() {
  local protocol="${1:?protocol required}"
  local port="${2:?port required}"
  if [[ "${protocol}" == "udp" ]]; then
    ss -H -lun "sport = :${port}" 2>/dev/null | grep -q .
  else
    ss -H -ltn "sport = :${port}" 2>/dev/null | grep -q .
  fi
}

mark_complete() {
  local name="${1:?marker required}"
  install -d -m 0750 "${INSTALL_STATE_DIR}"
  date -u +%FT%TZ > "${INSTALL_STATE_DIR}/${name}.complete"
}

require_marker() {
  local name="${1:?marker required}"
  [[ -f "${INSTALL_STATE_DIR}/${name}.complete" ]] \
    || fail "Run the preceding script first; missing ${name}.complete."
}
