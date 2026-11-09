#!/usr/bin/env bash
set -Eeuo pipefail

# StreamHub Blackmagic DeckLink repair for Ubuntu Server 24.04 amd64.
# It repairs the Desktop Video driver/permissions and replaces the bundled
# FFmpeg with a DeckLink-enabled FFmpeg 7.1.2 build.

APP_ROOT="${STREAMHUB_ROOT:-/opt/StreamHub}"
FFMPEG_VERSION="7.1.2"
FFMPEG_ARCHIVE="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_ARCHIVE}"
LOG_FILE="/var/log/streamhub-bmd-repair.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_ROOT=""
NEW_RUNTIME=""

info() { printf '[信息] %s\n' "$*"; }
ok() { printf '[完成] %s\n' "$*"; }
warn() { printf '[注意] %s\n' "$*" >&2; }
die() { printf '[失败] %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "${NEW_RUNTIME:-}" && -d "${NEW_RUNTIME}" ]]; then
    rm -rf -- "${NEW_RUNTIME}"
  fi
  if [[ -n "${WORK_ROOT:-}" && -d "${WORK_ROOT}" ]]; then
    rm -rf -- "${WORK_ROOT}"
  fi
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || die "请使用 sudo bash $0 运行。"
install -d -m 0755 "$(dirname "${LOG_FILE}")"
touch "${LOG_FILE}"
chmod 0600 "${LOG_FILE}"
exec > >(tee -a "${LOG_FILE}") 2>&1

info "开始修复 Blackmagic DeckLink，日志：${LOG_FILE}"
[[ -r /etc/os-release ]] || die "找不到 /etc/os-release。"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] \
  || die "本脚本只适用于 Ubuntu Server 24.04，当前为 ${PRETTY_NAME:-未知系统}。"
[[ "$(dpkg --print-architecture)" == "amd64" ]] || die "本脚本只适用于 amd64。"
[[ -d "${APP_ROOT}" ]] || die "找不到 ${APP_ROOT}，请确认 StreamHub 已部署。"
[[ -f "${APP_ROOT}/server/lib/decklink.js" ]] \
  || warn "未找到 server/lib/decklink.js；将继续修复 FFmpeg，但请确认发布包完整。"

WORK_ROOT="$(mktemp -d /var/tmp/streamhub-bmd-repair.XXXXXX)"

info "1/7 检查 BMD 硬件、驱动和 Secure Boot"
if command -v lspci >/dev/null 2>&1; then
  hardware_text="$(lspci -nn 2>/dev/null | grep -Ei 'Blackmagic|DeckLink' || true)"
  if [[ -n "${hardware_text}" ]]; then
    printf '%s\n' "${hardware_text}"
    ok "PCIe/Thunderbolt 总线上检测到 Blackmagic 设备。"
  else
    warn "lspci 未显示 Blackmagic 设备。外接设备请确认已供电、线缆已连接且 Thunderbolt 已授权。"
  fi
fi

secure_boot_enabled=false
if command -v mokutil >/dev/null 2>&1; then
  secure_boot_text="$(mokutil --sb-state 2>&1 || true)"
  printf '%s\n' "${secure_boot_text}"
  if grep -qi 'SecureBoot enabled' <<<"${secure_boot_text}"; then
    secure_boot_enabled=true
    warn "Secure Boot 已开启；未签名的 Blackmagic 内核模块可能会被系统拒绝。"
  fi
fi

driver_installed=false
if modinfo blackmagic >/dev/null 2>&1; then
  driver_installed=true
fi

install_driver_from_bundle() {
  local driver_archive extract_dir architecture deb
  local -a debs=()
  driver_archive="$(find "${APP_ROOT}/vendor/blackmagic" -maxdepth 1 -type f \
    \( -iname '*Desktop*Video*.tar' -o -iname '*Desktop*Video*.tar.gz' -o -iname '*Desktop*Video*.tgz' \) \
    -print -quit 2>/dev/null || true)"
  [[ -n "${driver_archive}" ]] \
    || die "没有检测到 Desktop Video 驱动，也未找到 ${APP_ROOT}/vendor/blackmagic 中的驱动包。请把完整发布包复制到机器后重试。"
  extract_dir="${WORK_ROOT}/desktop-video"
  install -d -m 0750 "${extract_dir}"
  tar -xf "${driver_archive}" -C "${extract_dir}"
  while IFS= read -r -d '' deb; do
    architecture="$(dpkg-deb -f "${deb}" Architecture 2>/dev/null || true)"
    if [[ "${architecture}" == "amd64" || "${architecture}" == "all" ]]; then
      debs+=("${deb}")
    fi
  done < <(find "${extract_dir}" -type f -name '*.deb' -print0)
  (( ${#debs[@]} > 0 )) || die "驱动包中没有找到 amd64/all 的 .deb 文件。"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --reinstall "${debs[@]}"
  ok "已从发布包安装 Blackmagic Desktop Video 驱动。"
}

if [[ "${driver_installed}" == false ]]; then
  warn "没有检测到可用的 Blackmagic 内核模块，开始从发布包补装/修复驱动。"
  install_driver_from_bundle
else
  ok "Desktop Video 驱动已安装，跳过重装。"
fi

udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true
driver_loaded=false
if modprobe blackmagic 2>/dev/null; then
  driver_loaded=true
  ok "Blackmagic 内核模块已加载。"
else
  warn "Blackmagic 内核模块暂时无法加载；脚本仍会完成 FFmpeg 修复。"
fi
lsmod | grep -E '^(blackmagic|blackmagic_io)' || true

info "2/7 修复 StreamHub 运行用户的采集设备权限"
id streamhub >/dev/null 2>&1 || die "系统中没有 streamhub 用户。"
groups_to_add=()
for group_name in video audio render; do
  if getent group "${group_name}" >/dev/null; then
    groups_to_add+=("${group_name}")
  fi
done
if (( ${#groups_to_add[@]} > 0 )); then
  group_csv="$(IFS=,; printf '%s' "${groups_to_add[*]}")"
  usermod -aG "${group_csv}" streamhub
fi
id streamhub
device_nodes="$(find /dev -maxdepth 2 \
  \( -iname '*blackmagic*' -o -iname '*decklink*' \) -print 2>/dev/null || true)"
if [[ -n "${device_nodes}" ]]; then
  printf '%s\n' "${device_nodes}"
else
  warn "当前未发现 Blackmagic/DeckLink 设备节点；驱动加载或硬件连接仍可能需要处理。"
fi

info "3/7 准备 DeckLink SDK"
SDK_TARGET="${APP_ROOT}/vendor/blackmagic-sdk/include"
if [[ ! -f "${SDK_TARGET}/DeckLinkAPI.h" ]]; then
  bundled_sdk="${SCRIPT_DIR}/blackmagic-sdk/include"
  if [[ -f "${bundled_sdk}/DeckLinkAPI.h" ]]; then
    install -d -m 0755 "${SDK_TARGET}"
    rsync -a --delete "${bundled_sdk}/" "${SDK_TARGET}/"
    ok "已从修复包复制 DeckLink SDK。"
  else
    sdk_archive="$(find "${APP_ROOT}/vendor/blackmagic" -maxdepth 1 -type f \
      -iname '*DeckLink*SDK*.zip' -print -quit 2>/dev/null || true)"
    [[ -n "${sdk_archive}" ]] \
      || die "缺少 DeckLink SDK。请完整解压 BMD-DeckLink-fix 修复包后运行其中的脚本。"
    sdk_extract="${WORK_ROOT}/decklink-sdk"
    install -d -m 0750 "${sdk_extract}"
    unzip -q "${sdk_archive}" -d "${sdk_extract}"
    sdk_header="$(find "${sdk_extract}" -type f -ipath '*/linux/*' \
      -name DeckLinkAPI.h -print -quit)"
    [[ -n "${sdk_header}" ]] || die "SDK 压缩包中没有 Linux DeckLinkAPI.h。"
    install -d -m 0755 "${SDK_TARGET}"
    rsync -a --delete "$(dirname "${sdk_header}")/" "${SDK_TARGET}/"
  fi
fi
[[ -f "${SDK_TARGET}/DeckLinkAPI.h" ]] || die "DeckLink SDK 安装失败。"
install -d -m 0755 /etc/streamhub
printf 'DECKLINK_SDK_INCLUDE=%q\n' "${SDK_TARGET}" > /etc/streamhub/blackmagic-sdk.env
chmod 0644 /etc/streamhub/blackmagic-sdk.env
ok "DeckLink SDK 已准备：${SDK_TARGET}"

patch_file=""
for patch_candidate in \
  "${SCRIPT_DIR}/ffmpeg-7.1.2-decklink-sdk16.patch" \
  "${APP_ROOT}/scripts/patches/ffmpeg-7.1.2-decklink-sdk16.patch"; do
  if [[ -f "${patch_candidate}" ]]; then
    patch_file="${patch_candidate}"
    break
  fi
done
[[ -n "${patch_file}" ]] || die "缺少 FFmpeg DeckLink SDK 16 兼容补丁。"

current_ffmpeg="${APP_ROOT}/runtime/ffmpeg/bin/ffmpeg"
current_device_text=""
if [[ -x "${current_ffmpeg}" ]]; then
  current_device_text="$("${current_ffmpeg}" -hide_banner -devices 2>/dev/null || true)"
fi
if grep -qw decklink <<<"${current_device_text}"; then
  ok "当前 FFmpeg 已包含 DeckLink，跳过耗时的重新编译。"
  needs_build=false
else
  needs_build=true
fi

if [[ "${needs_build}" == true ]]; then
  info "4/7 安装 FFmpeg 编译依赖"
  build_packages=(
    autoconf automake build-essential ca-certificates cmake curl git gnupg
    libfontconfig1-dev libfreetype-dev libssl-dev libsrt-openssl-dev
    libtool libx264-dev nasm patch pkg-config rsync xz-utils yasm
  )
  missing_packages=()
  for package_name in "${build_packages[@]}"; do
    dpkg-query -W -f='${Status}' "${package_name}" 2>/dev/null \
      | grep -q '^install ok installed$' || missing_packages+=("${package_name}")
  done
  if (( ${#missing_packages[@]} > 0 )); then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y "${missing_packages[@]}"
  else
    ok "编译依赖已齐全，跳过 apt 安装。"
  fi

  info "5/7 编译带 DeckLink 支持的 FFmpeg ${FFMPEG_VERSION}（可能需要 10–30 分钟）"
  source_parent="${WORK_ROOT}/source"
  install -d -m 0750 "${source_parent}"
  cached_source="/var/lib/streamhub-install/ffmpeg-${FFMPEG_VERSION}/ffmpeg-${FFMPEG_VERSION}"
  cached_archive="/var/lib/streamhub-install/ffmpeg-${FFMPEG_VERSION}/${FFMPEG_ARCHIVE}"
  if [[ -f "${cached_source}/configure" ]]; then
    rsync -a "${cached_source}/" "${source_parent}/ffmpeg-${FFMPEG_VERSION}/"
  elif [[ -f "${cached_archive}" ]]; then
    tar -xf "${cached_archive}" -C "${source_parent}"
  else
    info "本机没有 FFmpeg 源码缓存，正在从 ffmpeg.org 下载。"
    curl --fail --show-error --location --retry 3 \
      "${FFMPEG_URL}" --output "${source_parent}/${FFMPEG_ARCHIVE}"
    curl --fail --show-error --location --retry 3 \
      "${FFMPEG_URL}.asc" --output "${source_parent}/${FFMPEG_ARCHIVE}.asc"
    curl --fail --show-error --location --retry 3 \
      'https://ffmpeg.org/ffmpeg-devel.asc' --output "${source_parent}/ffmpeg-devel.asc"
    export GNUPGHOME="${WORK_ROOT}/gnupg"
    install -d -m 0700 "${GNUPGHOME}"
    gpg --batch --import "${source_parent}/ffmpeg-devel.asc"
    gpg --batch --verify \
      "${source_parent}/${FFMPEG_ARCHIVE}.asc" \
      "${source_parent}/${FFMPEG_ARCHIVE}"
    tar -xf "${source_parent}/${FFMPEG_ARCHIVE}" -C "${source_parent}"
  fi

  source_dir="${source_parent}/ffmpeg-${FFMPEG_VERSION}"
  [[ -f "${source_dir}/configure" ]] || die "FFmpeg 源码准备失败。"
  cd "${source_dir}"
  make distclean >/dev/null 2>&1 || true
  if ! grep -q 'IDeckLinkInput_v14_2_1' libavdevice/decklink_common.h; then
    patch --batch --forward --strip=1 < "${patch_file}"
  fi

  configure_args=(
    --prefix="${APP_ROOT}/runtime/ffmpeg"
    --enable-gpl
    --enable-libx264
    --enable-libsrt
    --enable-openssl
    --enable-version3
    --enable-libfreetype
    --enable-libfontconfig
    --enable-nonfree
    --enable-decklink
    --extra-cflags="-I${SDK_TARGET}"
    --extra-cxxflags="-I${SDK_TARGET}"
    --extra-ldflags=-L/usr/lib/x86_64-linux-gnu
  )
  if command -v nvidia-smi >/dev/null 2>&1 \
    && [[ -f /usr/include/ffnvcodec/nvEncodeAPI.h ]]; then
    configure_args+=(--enable-nvenc)
  fi
  ./configure "${configure_args[@]}"
  make -j"$(nproc)"

  stage_root="${WORK_ROOT}/stage"
  make install DESTDIR="${stage_root}"
  staged_prefix="${stage_root}${APP_ROOT}/runtime/ffmpeg"
  staged_ffmpeg="${staged_prefix}/bin/ffmpeg"
  [[ -x "${staged_ffmpeg}" ]] || die "编译结果中缺少 ffmpeg。"
  staged_device_text="$("${staged_ffmpeg}" -hide_banner -devices 2>/dev/null || true)"
  staged_encoder_text="$("${staged_ffmpeg}" -hide_banner -encoders 2>/dev/null || true)"
  staged_protocol_text="$("${staged_ffmpeg}" -hide_banner -protocols 2>/dev/null || true)"
  grep -qw decklink <<<"${staged_device_text}" \
    || die "新 FFmpeg 未包含 decklink 模块。"
  grep -qw libx264 <<<"${staged_encoder_text}" \
    || die "新 FFmpeg 未包含 libx264。"
  grep -Eq '^[[:space:]]*srt[[:space:]]*$' <<<"${staged_protocol_text}" \
    || die "新 FFmpeg 未包含 SRT。"

  info "6/7 安全替换 StreamHub FFmpeg 并重启服务"
  runtime_root="${APP_ROOT}/runtime"
  install -d -m 0755 "${runtime_root}"
  NEW_RUNTIME="${runtime_root}/ffmpeg.bmd-new.$$"
  [[ ! -e "${NEW_RUNTIME}" ]] || die "临时运行时目录已存在：${NEW_RUNTIME}"
  install -d -m 0755 "${NEW_RUNTIME}"
  rsync -a "${staged_prefix}/" "${NEW_RUNTIME}/"
  backup_runtime="${runtime_root}/ffmpeg.before-bmd-$(date +%Y%m%d-%H%M%S)"
  if [[ -d "${runtime_root}/ffmpeg" ]]; then
    mv -- "${runtime_root}/ffmpeg" "${backup_runtime}"
  else
    backup_runtime=""
  fi
  if ! mv -- "${NEW_RUNTIME}" "${runtime_root}/ffmpeg"; then
    if [[ -n "${backup_runtime}" && -d "${backup_runtime}" ]]; then
      mv -- "${backup_runtime}" "${runtime_root}/ffmpeg"
    fi
    die "替换 FFmpeg 失败，已尝试恢复旧版本。"
  fi
  NEW_RUNTIME=""
  if ! systemctl restart streamhub.service; then
    warn "新运行时启动 StreamHub 失败，正在回滚。"
    failed_runtime="${runtime_root}/ffmpeg.failed-bmd-$(date +%Y%m%d-%H%M%S)"
    mv -- "${runtime_root}/ffmpeg" "${failed_runtime}"
    if [[ -n "${backup_runtime}" && -d "${backup_runtime}" ]]; then
      mv -- "${backup_runtime}" "${runtime_root}/ffmpeg"
      systemctl restart streamhub.service || true
    fi
    die "StreamHub 启动失败，已恢复旧 FFmpeg。请查看 journalctl -u streamhub.service。"
  fi
  ok "FFmpeg 已替换；旧版本保存在 ${backup_runtime:-无}。"
else
  info "6/7 重启 StreamHub，使新权限生效"
  systemctl restart streamhub.service
fi

info "7/7 验证 DeckLink 和 Web 服务"
FFMPEG="${APP_ROOT}/runtime/ffmpeg/bin/ffmpeg"
final_device_text="$("${FFMPEG}" -hide_banner -devices 2>&1 || true)"
grep -qi decklink <<<"${final_device_text}" \
  || die "FFmpeg 仍未显示 DeckLink 模块。"
source_text="$("${FFMPEG}" -hide_banner -sources decklink 2>&1 || true)"
printf '%s\n' "${source_text}"
decklink_source_row_pattern='^[[:space:]]*[^[:space:]]+[[:space:]]+\[[^]]+\][[:space:]]+\([^)]*\)[[:space:]]*$'
device_found=false
if grep -Eq "${decklink_source_row_pattern}" <<<"${source_text}" \
  || grep -Eq '^[[:space:]]*"[^"]+"[[:space:]]+\[' <<<"${source_text}" \
  || grep -Eq "\][[:space:]]+'[^']+'[[:space:]]*$" <<<"${source_text}"; then
  device_found=true
fi

systemctl is-active --quiet streamhub.service \
  || die "streamhub.service 未运行。"
curl -fsS http://127.0.0.1:18080/api/health >/dev/null \
  || die "StreamHub 健康检查失败。"
ok "StreamHub Web/API 正常。"

if [[ "${device_found}" == true ]]; then
  ok "修复完成：FFmpeg 已发现 Blackmagic DeckLink 设备。"
  printf '\n请在 Web 中进入：分发推流 → 输入源类型“采集卡信号” → 采集接口“Blackmagic DeckLink”，然后选择自动发现的设备和格式。\n'
  exit 0
fi

printf '\n'
warn "FFmpeg 已支持 DeckLink，但当前没有枚举到 BMD 设备。"
if [[ "${secure_boot_enabled}" == true || "${driver_loaded}" == false ]]; then
  warn "请进入 BIOS 关闭 Secure Boot（或完成 MOK 模块签名），重启电脑后再次运行本脚本。"
else
  warn "请检查采集卡供电/线缆/Thunderbolt 授权，并打开 Desktop Video Setup 确认设备可见。"
  warn "若提示固件版本不匹配，请先用 Blackmagic Firmware Updater 更新固件并重启。"
fi
dmesg 2>/dev/null | grep -Ei 'Blackmagic|DeckLink|firmware|module verification|Secure Boot' | tail -n 80 || true
exit 2
