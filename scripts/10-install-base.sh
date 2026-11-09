#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib/common.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_root
require_ubuntu_2404
init_install_log "10-install-base"
require_marker "00-preflight"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg software-properties-common
add-apt-repository -y universe
add-apt-repository -y multiverse
apt-get update
base_packages=(
  alsa-utils autoconf automake build-essential cmake dkms git iproute2 jq libfontconfig1-dev \
  libfreetype-dev libnginx-mod-rtmp libssl-dev libsrt-openssl-dev libtool libx264-dev \
  linux-headers-"$(uname -r)" mokutil nasm nginx pciutils pkg-config \
  python3 python3-pip python3-venv rsync unzip v4l-utils xz-utils yasm
)
if nvidia_gpu_present; then
  base_packages+=(libffmpeg-nvenc-dev)
  pass "NVIDIA hardware detected; NVENC build dependencies will be installed."
else
  warn "No NVIDIA hardware detected; skipping NVENC build dependencies."
fi
apt-get install -y "${base_packages[@]}"

install -d -m 0755 /etc/apt/keyrings
nodesource_key_tmp="$(mktemp)"
trap 'rm -f "${nodesource_key_tmp}"' EXIT
curl --fail --silent --show-error --location \
  https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  --output "${nodesource_key_tmp}"
gpg --dearmor --yes --output /etc/apt/keyrings/nodesource.gpg "${nodesource_key_tmp}"
chmod 0644 /etc/apt/keyrings/nodesource.gpg
printf '%s\n' \
  'deb [arch=amd64 signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "${node_major}" =~ ^[0-9]+$ ]] && (( node_major >= 22 )) \
  || fail "Node.js 22 or later is required."
node --version
nginx -v
mark_complete "10-install-base"
pass "Base packages and Node.js are installed. Continue with scripts/20-install-nvidia.sh."
