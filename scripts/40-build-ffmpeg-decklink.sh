#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib/common.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_root
require_ubuntu_2404
init_install_log "40-build-ffmpeg-decklink"
require_marker "30-install-blackmagic"

FFMPEG_VERSION="7.1.2"
FFMPEG_ARCHIVE="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_ARCHIVE}"
BUILD_ROOT="${INSTALL_STATE_DIR}/ffmpeg-${FFMPEG_VERSION}"
RUNTIME_ROOT="${STREAMHUB_PREFIX}/runtime"
DECKLINK_SDK16_PATCH="${SCRIPT_DIR}/patches/ffmpeg-7.1.2-decklink-sdk16.patch"
decklink_enabled=false
if [[ -f /etc/streamhub/blackmagic-sdk.env ]]; then
  # shellcheck disable=SC1091
  source /etc/streamhub/blackmagic-sdk.env
  if [[ -f "${DECKLINK_SDK_INCLUDE}/DeckLinkAPI.h" && -f "${DECKLINK_SDK16_PATCH}" ]]; then
    decklink_enabled=true
  else
    warn "DeckLink SDK headers or compatibility patch are missing; building without DeckLink support."
  fi
else
  warn "DeckLink SDK is not installed; building for USB V4L2/ALSA and network inputs."
fi

install -d -m 0750 "${BUILD_ROOT}"
cd "${BUILD_ROOT}"
curl --fail --show-error --location --retry 3 "${FFMPEG_URL}" --output "${FFMPEG_ARCHIVE}"
curl --fail --show-error --location --retry 3 "${FFMPEG_URL}.asc" --output "${FFMPEG_ARCHIVE}.asc"
curl --fail --show-error --location --retry 3 https://ffmpeg.org/ffmpeg-devel.asc --output ffmpeg-devel.asc

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
chmod 0700 "${GNUPGHOME}"
trap 'rm -rf "${GNUPGHOME}" "${temporary_root:-}"' EXIT
gpg --batch --import ffmpeg-devel.asc
gpg --batch --verify "${FFMPEG_ARCHIVE}.asc" "${FFMPEG_ARCHIVE}"
pass "FFmpeg release signature verified."

source_dir="${BUILD_ROOT}/ffmpeg-${FFMPEG_VERSION}"
if [[ ! -f "${source_dir}/configure" ]]; then
  tar -xf "${FFMPEG_ARCHIVE}" -C "${BUILD_ROOT}"
fi

temporary_root="$(mktemp -d "${BUILD_ROOT}/install.XXXXXX")"
cd "${source_dir}"
make distclean >/dev/null 2>&1 || true
if [[ "${decklink_enabled}" == true ]] && ! grep -q 'IDeckLinkInput_v14_2_1' libavdevice/decklink_common.h; then
  patch --batch --forward --strip=1 < "${DECKLINK_SDK16_PATCH}"
fi
configure_args=(
  --prefix="${RUNTIME_ROOT}/ffmpeg" \
  --enable-gpl \
  --enable-libx264 \
  --enable-libsrt \
  --enable-openssl \
  --enable-version3 \
  --enable-libfreetype \
  --enable-libfontconfig \
  --extra-ldflags="-L/usr/lib/x86_64-linux-gnu"
)
if [[ "${decklink_enabled}" == true ]]; then
  configure_args+=(--enable-nonfree --enable-decklink --extra-cflags="-I${DECKLINK_SDK_INCLUDE}" --extra-cxxflags="-I${DECKLINK_SDK_INCLUDE}")
fi
if nvenc_enabled; then configure_args+=(--enable-nvenc); fi
./configure "${configure_args[@]}"
make -j"$(nproc)"
make install DESTDIR="${temporary_root}"

staged_prefix="${temporary_root}${RUNTIME_ROOT}/ffmpeg"
staged_ffmpeg="${staged_prefix}/bin/ffmpeg"
[[ -x "${staged_ffmpeg}" ]] || fail "Staged FFmpeg binary is missing."
encoder_text="$("${staged_ffmpeg}" -hide_banner -encoders 2>/dev/null)"
device_text="$("${staged_ffmpeg}" -hide_banner -devices 2>/dev/null)"
protocol_text="$("${staged_ffmpeg}" -hide_banner -protocols 2>/dev/null)"
if nvenc_enabled; then
  grep -q 'h264_nvenc' <<<"${encoder_text}" || fail "FFmpeg lacks h264_nvenc although NVIDIA hardware is enabled."
else
  grep -q 'libx264' <<<"${encoder_text}" || fail "FFmpeg lacks the CPU libx264 encoder."
fi
if [[ "${decklink_enabled}" == true ]]; then
  grep -q 'decklink' <<<"${device_text}" || fail "FFmpeg lacks the DeckLink device."
else
  warn "DeckLink device support is not enabled; USB capture uses V4L2/ALSA."
fi
grep -q '^  srt$' <<<"${protocol_text}" || fail "FFmpeg lacks SRT."
grep -q '^  tls$' <<<"${protocol_text}" || fail "FFmpeg lacks TLS."

install -d -m 0755 "${RUNTIME_ROOT}"
new_prefix="${RUNTIME_ROOT}/ffmpeg.new"
previous_prefix="${RUNTIME_ROOT}/ffmpeg.previous"
rm -rf "${new_prefix}"
install -d -m 0755 "${new_prefix}"
rsync -a "${staged_prefix}/" "${new_prefix}/"
rm -rf "${previous_prefix}"
if [[ -d "${RUNTIME_ROOT}/ffmpeg" ]]; then
  mv "${RUNTIME_ROOT}/ffmpeg" "${previous_prefix}"
fi
mv "${new_prefix}" "${RUNTIME_ROOT}/ffmpeg"

version_text="$("${RUNTIME_ROOT}/ffmpeg/bin/ffmpeg" -version)"
IFS= read -r version_line <<<"${version_text}"
printf '%s\n' "${version_line}"
mark_complete "40-build-ffmpeg-decklink"
pass "FFmpeg ${FFMPEG_VERSION} is installed with the detected hardware profile. Continue with scripts/50-install-streamhub.sh."
