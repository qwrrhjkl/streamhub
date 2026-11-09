#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib/common.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_root
require_ubuntu_2404
init_install_log "00-preflight"

log "Checking host resources and required network endpoints."
available_kib="$(df -Pk / | awk 'NR==2 {print $4}')"
[[ "${available_kib}" =~ ^[0-9]+$ ]] || fail "Unable to determine free disk space."
(( available_kib >= 15 * 1024 * 1024 )) || fail "At least 15 GiB free disk space is required."
pass "Disk space is at least 15 GiB."

getent ahosts ffmpeg.org >/dev/null || fail "DNS resolution for ffmpeg.org failed."
getent ahosts deb.nodesource.com >/dev/null || fail "DNS resolution for deb.nodesource.com failed."
if command_exists curl; then
  curl --fail --silent --show-error --location --max-time 15 https://ffmpeg.org/ >/dev/null
  curl --fail --silent --show-error --location --max-time 15 https://www.blackmagicdesign.com/support/ >/dev/null
elif command_exists python3; then
  python3 -c 'import urllib.request; urllib.request.urlopen("https://ffmpeg.org/", timeout=15).read(1)'
  python3 -c 'import urllib.request; urllib.request.urlopen("https://www.blackmagicdesign.com/support/", timeout=15).read(1)'
else
  fail "curl or python3 is required for HTTPS checks."
fi
pass "DNS and HTTPS connectivity are available."

command_exists ss || fail "The ss command is required (package: iproute2)."
for port in 18080 1935 18081; do
  if port_in_use tcp "${port}"; then
    ss -ltnp "sport = :${port}" || true
    fail "TCP port ${port} is already in use. Stop the conflicting service and rerun preflight."
  fi
done
pass "TCP ports 18080, 1935, and 18081 are free."

if command_exists lspci; then
  pci_text="$(lspci -nn)"
  if grep -qi 'NVIDIA' <<<"${pci_text}"; then
    pass "NVIDIA PCI hardware detected; NVENC installation will be enabled."
  else
    pass "No NVIDIA PCI hardware detected; CPU encoding profile will be used."
  fi
  if grep -Eqi 'Blackmagic|DeckLink' <<<"${pci_text}"; then
    pass "Blackmagic/DeckLink PCI hardware detected."
  else
    warn "No Blackmagic PCI entry was detected; USB/Thunderbolt or powered-off hardware must be checked before script 60."
  fi
else
  if nvidia_gpu_present; then
    pass "NVIDIA GPU detected through the Linux device tree."
  else
    pass "No NVIDIA GPU detected; CPU encoding profile will be used."
  fi
fi

if command_exists mokutil && mokutil --sb-state 2>/dev/null | grep -qi enabled; then
  warn "Secure Boot is enabled. NVIDIA and Blackmagic kernel modules may require MOK enrollment or Secure Boot changes."
fi

mark_complete "00-preflight"
pass "Preflight complete. Continue with scripts/10-install-base.sh."
