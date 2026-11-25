#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${STREAMHUB_ROOT:-/opt/StreamHub}"
DATA_DIR="${APP_ROOT}/data"
REQUEST_FILE="${DATA_DIR}/update-request.json"
STATUS_FILE="${DATA_DIR}/update-status.json"
BACKUP_ROOT="/var/backups/streamhub/updater"
LOCK_FILE="/run/lock/streamhub-update.lock"
CURRENT_COMMIT=""
TARGET_COMMIT=""
BACKUP_BUNDLE=""
SERVICE_STOPPED=0
TREE_UPDATED=0

write_status() {
  local state="${1:?state required}"
  local message="${2:?message required}"
  local updated_at temp_file
  updated_at="$(date -u +%FT%TZ)"
  temp_file="$(mktemp "${DATA_DIR}/.update-status.XXXXXX")"
  UPDATE_STATE="${state}" \
  UPDATE_MESSAGE="${message}" \
  UPDATE_CURRENT_COMMIT="${CURRENT_COMMIT}" \
  UPDATE_TARGET_COMMIT="${TARGET_COMMIT}" \
  UPDATE_UPDATED_AT="${updated_at}" \
  UPDATE_BACKUP_PATH="${BACKUP_BUNDLE}" \
    python3 - "${temp_file}" <<'PY'
import json
import os
import sys

payload = {
    "state": os.environ["UPDATE_STATE"],
    "message": os.environ["UPDATE_MESSAGE"],
    "currentCommit": os.environ["UPDATE_CURRENT_COMMIT"],
    "targetCommit": os.environ["UPDATE_TARGET_COMMIT"],
    "updatedAt": os.environ["UPDATE_UPDATED_AT"],
    "backupPath": os.environ["UPDATE_BACKUP_PATH"],
}
with open(sys.argv[1], "w", encoding="utf-8") as output:
    json.dump(payload, output, ensure_ascii=False)
    output.write("\n")
PY
  chmod 0640 "${temp_file}"
  chown streamhub:streamhub "${temp_file}"
  mv -f "${temp_file}" "${STATUS_FILE}"
}

fail_before_stop() {
  local message="${1:?message required}"
  write_status failed "${message}"
  exit 1
}

git_safe() {
  /usr/bin/git -c core.hooksPath=/dev/null -c credential.helper= -C "${APP_ROOT}" "$@"
}

rollback_update() {
  local message="${1:?message required}"
  local rollback_ok=1
  set +e
  if (( TREE_UPDATED )); then
    if systemctl is-active --quiet streamhub.service && ! systemctl stop streamhub.service; then
      rollback_ok=0
    fi
    if ! systemctl is-active --quiet streamhub.service; then
      git_safe reset --hard "${CURRENT_COMMIT}" || rollback_ok=0
      chown -R streamhub:streamhub "${APP_ROOT}" || rollback_ok=0
      systemctl daemon-reload || rollback_ok=0
    else
      rollback_ok=0
    fi
  fi
  if (( SERVICE_STOPPED )) && ! systemctl start streamhub.service; then rollback_ok=0; fi
  if (( rollback_ok )); then
    write_status rolled-back "${message} 已恢复更新前版本并重新启动服务。"
  else
    write_status failed "${message} 自动回退或服务恢复未能确认，请通过 SSH 检查服务和代码版本。"
  fi
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  printf 'This updater must run as root.\n' >&2
  exit 1
fi
if [[ "$(realpath -m "${APP_ROOT}")" != "/opt/StreamHub" || ! -d "${APP_ROOT}/.git" ]]; then
  printf 'Online update requires the Git checkout at /opt/StreamHub.\n' >&2
  exit 1
fi
install -d -m 0750 "${DATA_DIR}" "${BACKUP_ROOT}" /run/lock
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  write_status failed '已有更新正在执行。'
  exit 1
fi

if [[ ! -s "${REQUEST_FILE}" ]]; then fail_before_stop '缺少更新请求，请重新在设置页检查版本。'; fi
if ! TARGET_COMMIT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("targetCommit", ""))' "${REQUEST_FILE}")"; then
  fail_before_stop '更新请求文件无法读取，请重新在设置页检查版本。'
fi
if [[ ! "${TARGET_COMMIT}" =~ ^[a-f0-9]{40}$ ]]; then fail_before_stop '更新请求中的提交版本无效。'; fi
CURRENT_COMMIT="$(git_safe rev-parse --verify HEAD)"
if [[ ! "${CURRENT_COMMIT}" =~ ^[a-f0-9]{40}$ ]]; then fail_before_stop '无法读取本机 Git 版本。'; fi

branch="$(git_safe branch --show-current)"
remote="$(git_safe remote get-url origin)"
if [[ "${branch}" != "main" ]]; then fail_before_stop '当前分支不是 main，已停止自动更新。'; fi
case "${remote}" in
  https://github.com/qwrrhjkl/streamhub.git|https://github.com/qwrrhjkl/streamhub) ;;
  *) fail_before_stop 'origin 不是受信任的 StreamHub GitHub 仓库。' ;;
esac

if [[ -n "$(git_safe status --porcelain --untracked-files=all)" ]]; then
  fail_before_stop '检测到本机源码或未跟踪文件改动；为保护本地内容，自动更新已取消。'
fi
health_port="${STREAMHUB_PORT:-}"
if [[ -z "${health_port}" && -r /etc/streamhub/streamhub.env ]]; then
  health_port="$(sed -n 's/^STREAMHUB_PORT=//p' /etc/streamhub/streamhub.env | tail -n 1)"
fi
health_port="${health_port:-18080}"
if [[ ! "${health_port}" =~ ^[0-9]{1,5}$ ]] || (( health_port < 1 || health_port > 65535 )); then
  fail_before_stop 'Web 服务端口配置无效，已停止自动更新。'
fi
if pgrep -x ffmpeg >/dev/null 2>&1; then
  fail_before_stop '检测到 FFmpeg 推流、预览或录制进程；请停止运行任务后再更新。'
fi

write_status running '正在读取 GitHub 版本并检查本机代码状态。'
if ! GIT_TERMINAL_PROMPT=0 git_safe -c http.extraHeader= -c credential.helper= -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --no-tags origin main; then
  fail_before_stop '无法从 GitHub 拉取 main 分支。'
fi
FETCHED_COMMIT="$(git_safe rev-parse --verify FETCH_HEAD)"
if [[ "${FETCHED_COMMIT}" != "${TARGET_COMMIT}" ]]; then
  fail_before_stop '检查版本后云端 main 已变化，请重新检查更新。'
fi
if [[ "${CURRENT_COMMIT}" == "${TARGET_COMMIT}" ]]; then
  write_status up-to-date '本机已经是 GitHub main 最新版本。'
  rm -f "${REQUEST_FILE}"
  exit 0
fi
if ! git_safe merge-base --is-ancestor "${CURRENT_COMMIT}" "${TARGET_COMMIT}"; then
  fail_before_stop '云端版本与本机版本不是快进关系，需要人工检查后更新。'
fi

changed_paths="$(git_safe diff --name-only "${CURRENT_COMMIT}" "${TARGET_COMMIT}")"
if grep -Eq '^(scripts/|services/|config/|package\.json$|package-lock\.json$|vendor/|runtime/)' <<<"${changed_paths}"; then
  fail_before_stop '更新包含安装脚本、系统服务、依赖或运行时变更；此类版本需要维护窗口人工部署。'
fi

backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_BUNDLE="${BACKUP_ROOT}/streamhub-${CURRENT_COMMIT}-${backup_stamp}.bundle"
if ! git_safe bundle create "${BACKUP_BUNDLE}" --all; then
  rm -f "${BACKUP_BUNDLE}"
  BACKUP_BUNDLE=""
  fail_before_stop '创建更新回退备份失败。'
fi
chmod 0600 "${BACKUP_BUNDLE}"
write_status running '备份已完成，正在停止 StreamHub 服务并安装更新。'

if ! systemctl stop streamhub.service; then fail_before_stop '无法停止 StreamHub 服务，未安装更新。'; fi
SERVICE_STOPPED=1
TREE_UPDATED=1
if ! git_safe merge --ff-only --no-edit "${TARGET_COMMIT}"; then
  rollback_update '快进更新失败，已尝试恢复更新前版本。'
fi
# git 以 root 运行时重写文件会导致属主变成 root，服务用户 streamhub 无法读取；
# 每次改动工作树后都恢复属主，避免服务因 EACCES 启动失败。
chown -R streamhub:streamhub "${APP_ROOT}"
if ! systemctl daemon-reload; then rollback_update '重新加载 systemd 配置失败，已回退代码。'; fi
if ! systemctl start streamhub.service; then rollback_update '更新后服务无法启动，已回退代码。'; fi

healthy=0
for _attempt in {1..30}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:${health_port}/api/health" >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if (( ! healthy )); then rollback_update '更新后健康检查失败，已回退到更新前版本。'; fi

write_status succeeded '更新完成，StreamHub 服务健康检查通过。'
rm -f "${REQUEST_FILE}"
