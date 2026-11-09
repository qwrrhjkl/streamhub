#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib/common.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_root
require_ubuntu_2404
init_install_log "30-install-blackmagic"
require_marker "20-install-nvidia"

VENDOR_DIR="${STREAMHUB_PREFIX}/vendor/blackmagic"
WORK_DIR="${INSTALL_STATE_DIR}/blackmagic"
SUPPORT_URL="https://www.blackmagicdesign.com/support/"
if [[ ! -d "${VENDOR_DIR}" ]]; then
  warn "${VENDOR_DIR} is absent. DeckLink support will be skipped; USB V4L2/ALSA capture remains available."
  touch "${INSTALL_STATE_DIR}/no-decklink"
  mark_complete "30-install-blackmagic"
  pass "Blackmagic installation skipped. Continue with scripts/40-build-ffmpeg-decklink.sh."
  exit 0
fi

install -d -m 0750 "${WORK_DIR}"

validate_archive_entries() {
  local archive="${1:?archive required}"
  local entry
  if [[ "${archive}" == *.zip ]]; then
    while IFS= read -r entry; do
      [[ "${entry}" != /* && "${entry}" != ../* && "${entry}" != *'/../'* ]] \
        || fail "Unsafe archive path in ${archive}: ${entry}"
    done < <(unzip -Z1 "${archive}")
  else
    while IFS= read -r entry; do
      [[ "${entry}" != /* && "${entry}" != ../* && "${entry}" != *'/../'* ]] \
        || fail "Unsafe archive path in ${archive}: ${entry}"
    done < <(tar -tf "${archive}")
  fi
}

extract_archive() {
  local archive="${1:?archive required}"
  local output="${2:?output required}"
  validate_archive_entries "${archive}"
  install -d -m 0750 "${output}"
  if [[ "${archive}" == *.zip ]]; then
    unzip -q "${archive}" -d "${output}"
  else
    tar -xf "${archive}" -C "${output}"
  fi
}

mapfile -d '' archives < <(find "${VENDOR_DIR}" -maxdepth 1 -type f \
  \( -iname '*.zip' -o -iname '*.tar' -o -iname '*.tar.gz' -o -iname '*.tgz' -o -iname '*.tar.xz' \) -print0)
(( ${#archives[@]} >= 2 )) \
  || {
    warn "Blackmagic Desktop Video archives were not found. DeckLink support will be skipped; USB V4L2/ALSA capture remains available."
    touch "${INSTALL_STATE_DIR}/no-decklink"
    mark_complete "30-install-blackmagic"
    pass "Blackmagic installation skipped. Continue with scripts/40-build-ffmpeg-decklink.sh."
    exit 0
  }

for archive in "${archives[@]}"; do
  archive_name="$(basename "${archive}")"
  output_dir="${WORK_DIR}/${archive_name//[^A-Za-z0-9._-]/_}"
  if [[ ! -f "${output_dir}/.extracted" ]]; then
    extract_archive "${archive}" "${output_dir}"
    touch "${output_dir}/.extracted"
  fi
done

mapfile -d '' deb_candidates < <(find "${WORK_DIR}" -type f -name '*.deb' -print0)
(( ${#deb_candidates[@]} > 0 )) || fail "Desktop Video amd64 .deb files were not found. Download: ${SUPPORT_URL}"
debs=()
for deb in "${deb_candidates[@]}"; do
  architecture="$(dpkg-deb -f "${deb}" Architecture 2>/dev/null || true)"
  if [[ "${architecture}" == "amd64" || "${architecture}" == "all" ]]; then
    debs+=("${deb}")
  fi
done
(( ${#debs[@]} > 0 )) || fail "No compatible Desktop Video amd64/all packages were found."
apt-get update
apt-get install -y "${debs[@]}"

# The SDK bundles macOS headers too; FFmpeg on Ubuntu needs the Linux variant.
sdk_header="$(find "${WORK_DIR}" -type f -ipath '*/linux/*' -name DeckLinkAPI.h -print -quit)"
[[ -n "${sdk_header}" ]] || fail "Linux DeckLinkAPI.h was not found in the SDK archive. Download: ${SUPPORT_URL}"
sdk_source_dir="$(dirname "${sdk_header}")"
sdk_target_dir="${STREAMHUB_PREFIX}/vendor/blackmagic-sdk/include"
install -d -m 0755 "${sdk_target_dir}"
rsync -a --delete "${sdk_source_dir}/" "${sdk_target_dir}/"
[[ -f "${sdk_target_dir}/DeckLinkAPI.h" ]] || fail "Failed to install DeckLink SDK headers."

install -d -m 0755 /etc/streamhub
printf 'DECKLINK_SDK_INCLUDE=%q\n' "${sdk_target_dir}" > /etc/streamhub/blackmagic-sdk.env
chmod 0644 /etc/streamhub/blackmagic-sdk.env
udevadm control --reload-rules || true
udevadm trigger || true
modprobe blackmagic || warn "The blackmagic module is not active yet; check Secure Boot and reboot if required."

mark_complete "30-install-blackmagic"
pass "Blackmagic Desktop Video and SDK headers are installed. Continue with scripts/40-build-ffmpeg-decklink.sh."
