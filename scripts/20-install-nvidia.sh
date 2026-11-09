#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib/common.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_root
require_ubuntu_2404
init_install_log "20-install-nvidia"
require_marker "10-install-base"

if ! nvidia_gpu_present; then
  write_hardware_profile
  rm -f "${INSTALL_STATE_DIR}/reboot-required-nvidia"
  mark_complete "20-install-nvidia"
  pass "No NVIDIA GPU detected. NVIDIA driver installation is skipped; continue with scripts/30-install-blackmagic.sh."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ubuntu-drivers-common
ubuntu-drivers list --gpgpu || true
ubuntu-drivers install --gpgpu

if ! nvidia-smi; then
  install -d -m 0750 "${INSTALL_STATE_DIR}"
  date -u +%FT%TZ > "${INSTALL_STATE_DIR}/reboot-required-nvidia"
  warn "NVIDIA packages are installed but the driver is not active. Reboot, then rerun this script before continuing."
  exit 20
fi

write_hardware_profile

driver_package=""
while read -r package status; do
  if [[ "${status}" == "installed" && "${package}" =~ ^nvidia-driver-([0-9]+(-server)?) ]]; then
    driver_package="${package}"
    break
  fi
done < <(dpkg-query -W -f='${binary:Package} ${db:Status-Status}\n' 'nvidia-driver-[0-9]*' 2>/dev/null || true)

if [[ "${driver_package}" =~ ^nvidia-driver-([0-9]+(-server)?) ]]; then
  apt-get install -y "libnvidia-encode-${BASH_REMATCH[1]}"
else
  fail "Could not determine the installed NVIDIA driver package required for the NVENC runtime."
fi

rm -f "${INSTALL_STATE_DIR}/reboot-required-nvidia"
mark_complete "20-install-nvidia"
pass "NVIDIA driver is active. Continue with scripts/30-install-blackmagic.sh."
