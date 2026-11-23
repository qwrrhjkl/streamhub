# StreamHub 新机器部署交接文档

更新时间：2026-11-23（北京时间）

## 1. 部署目标

在一台全新的 Ubuntu Server 24.04 LTS amd64 机器上，从 GitHub 云端仓库拉取 StreamHub，并完成 Node.js、Nginx RTMP、NVIDIA/NVENC、Blackmagic DeckLink、FFmpeg、systemd 服务和控制台安装。

本文档按“新机器、空业务数据”编写。不会自动迁移旧机器的账号、密码、直播任务、推流密钥、素材、录制文件、日志或监控历史。

## 2. 云端仓库信息

| 项目 | 内容 |
|---|---|
| 云端平台 | GitHub |
| GitHub 账号/仓库所有者 | `qwrrhjkl` |
| 仓库名称 | `streamhub` |
| 仓库地址 | `https://github.com/qwrrhjkl/streamhub.git` |
| 部署分支 | `main` |
| 文档编写前的云端基线 | `c686d1130ab4be3da9036a7a3c405b1502eca7cb` |
| 基线提交说明 | `Add user management and session security settings` |
| 目标安装目录 | `/opt/StreamHub` |

部署时以 `origin/main` 的实际 HEAD 为准。克隆完成后使用 `git rev-parse HEAD` 和 `git ls-remote origin refs/heads/main` 核对本地与云端一致，不要直接复制开发机工作区覆盖云端版本。

不要在本文档、Git remote、脚本或命令历史中保存 GitHub 密码、Personal Access Token、服务器密码或平台推流密钥。私有仓库建议给新服务器配置只读 Deploy Key；也可以使用 GitHub CLI 登录后再克隆。

## 3. 新机器要求

- Ubuntu Server 24.04 LTS amd64。
- 建议至少 8 核 CPU、16 GiB 内存；当前同类生产负载使用 28 个逻辑核和 32 GiB 内存。
- 根分区至少 30 GiB 可用空间；录制和素材空间另算。
- 管理网固定 IP，能访问 Ubuntu 软件源、`deb.nodesource.com`、`ffmpeg.org`、GitHub 和 Blackmagic 官方支持页。
- 需要 NVENC 时安装支持 NVENC 的 NVIDIA GPU。
- 需要 SDI/HDMI 专业采集时安装 Blackmagic DeckLink，并准备官方 Linux Desktop Video 驱动包和 Linux SDK 包。
- 安装前确认 TCP `18080`、`1935`、`18081` 未被占用。

## 4. 从云端拉取代码

先登录新机器并安装基础下载工具：

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl
sudo install -d -m 0755 /opt
```

### 4.1 仓库可直接读取时

```bash
sudo git clone --branch main --single-branch \
  https://github.com/qwrrhjkl/streamhub.git /opt/StreamHub
cd /opt/StreamHub
git remote -v
git status --short --branch
git rev-parse HEAD
```

首次部署时核对本地提交与云端 `main`：

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

两个命令显示的提交哈希应一致。

### 4.2 私有仓库认证

推荐给新机器创建只读 SSH Deploy Key，并在 GitHub 仓库的 **Settings → Deploy keys** 中登记公钥。登记完成后使用 SSH 地址：

```bash
sudo git clone --branch main --single-branch \
  git@github.com:qwrrhjkl/streamhub.git /opt/StreamHub
```

不要把 PAT 写入 `https://TOKEN@github.com/...` 形式的 remote URL。

## 5. Blackmagic DeckLink 厂商文件

Git 仓库不包含 Blackmagic 驱动和 SDK，这是厂商许可边界。需要 DeckLink 时，由管理员从官方支持页下载：

- Blackmagic Desktop Video for Linux；
- Blackmagic Desktop Video SDK，必须包含 Linux 版 `DeckLinkAPI.h`。

官方地址：<https://www.blackmagicdesign.com/support/>

将两个原始压缩包上传到：

```text
/opt/StreamHub/vendor/blackmagic/
```

不要解压、不要改名。检查文件：

```bash
sudo mkdir -p /opt/StreamHub/vendor/blackmagic
find /opt/StreamHub/vendor/blackmagic -maxdepth 1 -type f -printf '%f\n'
```

不使用 DeckLink 时可以不上传；安装脚本会保留网络输入和 USB V4L2/ALSA 采集能力。

## 6. 严格安装顺序

所有步骤必须从 `/opt/StreamHub` 执行，一步成功后再执行下一步：

```bash
cd /opt/StreamHub
sudo bash scripts/00-preflight.sh
sudo bash scripts/10-install-base.sh
sudo bash scripts/20-install-nvidia.sh
sudo bash scripts/30-install-blackmagic.sh
sudo bash scripts/40-build-ffmpeg-decklink.sh
sudo bash scripts/50-install-streamhub.sh
```

### 6.1 NVIDIA 重启处理

如果第 20 步退出码为 `20`，说明 NVIDIA 驱动已安装但尚未激活。执行：

```bash
sudo reboot
```

重新登录后从第 20 步继续：

```bash
cd /opt/StreamHub
sudo bash scripts/20-install-nvidia.sh
sudo bash scripts/30-install-blackmagic.sh
sudo bash scripts/40-build-ffmpeg-decklink.sh
sudo bash scripts/50-install-streamhub.sh
```

如果 Secure Boot 已启用，NVIDIA 和 Blackmagic 内核模块可能需要 MOK 注册。不要在未确认安全策略时直接修改 Secure Boot。

### 6.2 首次配置登录账号

第 50 步第一次运行会创建：

```text
/etc/streamhub/streamhub.env
```

它会因为占位密码而停止。编辑配置：

```bash
sudo nano /etc/streamhub/streamhub.env
```

至少确认以下内容：

```dotenv
STREAMHUB_ROOT=/opt/StreamHub
STREAMHUB_HOST=0.0.0.0
STREAMHUB_PORT=18080
STREAMHUB_RTMP_PORT=1935
STREAMHUB_FFMPEG=/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg
STREAMHUB_FFPROBE=/opt/StreamHub/runtime/ffmpeg/bin/ffprobe
STREAMHUB_AUTH_USERNAME=admin
STREAMHUB_AUTH_PASSWORD=这里填写新机器唯一的强密码
NODE_ENV=production
```

保存后再次执行：

```bash
cd /opt/StreamHub
sudo bash scripts/50-install-streamhub.sh
sudo bash scripts/60-verify.sh
```

不要沿用公开、弱口令或聊天记录中出现过的密码。

## 7. 安装完成后的端口

| 端口 | 用途 | 暴露范围 |
|---|---|---|
| `18080/tcp` | StreamHub Web/API | 只允许可信管理网 |
| `1935/tcp` | RTMP 接入 | 只允许制作网或指定来源 |
| `18081/tcp` | RTMP 内部健康检查 | 只监听 `127.0.0.1` |
| `10081/udp` | SRT 预留 | 默认不监听 |

登录地址：

```text
http://新机器IP:18080
```

初始用户名由 `STREAMHUB_AUTH_USERNAME` 决定，模板默认为 `admin`；密码是新机器 `/etc/streamhub/streamhub.env` 中设置的密码。

不要把 `18080` 直接开放到公网。应通过防火墙、管理 VLAN、VPN 或受控反向代理限制访问。

## 8. 最终验收

首先运行项目自带验收脚本：

```bash
cd /opt/StreamHub
sudo bash scripts/60-verify.sh
```

再人工检查：

```bash
systemctl --no-pager --full status streamhub.service streamhub-rtmp.service
curl -fsS http://127.0.0.1:18080/api/health
curl -fsS http://127.0.0.1:18081/health
/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg -hide_banner -encoders | grep -E 'h264_nvenc|libx264'
/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg -hide_banner -devices | grep -E 'decklink|v4l2|alsa'
nvidia-smi
```

使用 DeckLink 时还要检查：

```bash
/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg -hide_banner -sources decklink
dmesg | grep -iE 'blackmagic|firmware version mismatch'
lspci -nnk | grep -A3 -Ei 'Blackmagic|DeckLink'
```

验收标准：

- `streamhub.service` 与 `streamhub-rtmp.service` 均为 `active`；
- Web/API 与 RTMP 健康端点正常；
- NVIDIA 机器可以看到 `h264_nvenc`，无 NVIDIA 机器可以看到 `libx264`；
- DeckLink 机器可以枚举真实设备，且没有 firmware mismatch；
- 控制台能登录；
- 创建测试任务后能识别真实输入格式、启动推流并显示 FPS/码率；
- 测试输出无持续丢帧或码率异常。

## 9. 空部署与旧机迁移的区别

从 GitHub 克隆只获得程序源码，不包含以下内容：

- `/etc/streamhub/streamhub.env`；
- `/opt/StreamHub/data` 中的业务状态、账号密码哈希、素材、录制、日志和监控历史；
- 平台推流地址和密钥；
- Blackmagic 驱动与 SDK 原始包；
- 编译后的 `/opt/StreamHub/runtime/ffmpeg`。

如果新机器需要完全继承旧机器业务，应另开迁移维护窗口，在旧机器停止服务后备份：

```bash
sudo systemctl stop streamhub-rtmp.service streamhub.service
sudo tar -czf /var/backups/streamhub-migration-$(date +%F-%H%M).tar.gz \
  /etc/streamhub /opt/StreamHub/data
sudo systemctl start streamhub.service streamhub-rtmp.service
```

恢复到新机器前必须确认：

- 新旧机器程序版本兼容；
- 文件所有者恢复为 `streamhub:streamhub`；
- 推流密钥传输渠道安全；
- 旧机和新机不要同时启动相同的平台输出任务；
- 不要从旧机复制 NVIDIA/Blackmagic 内核驱动或编译产物，驱动和 FFmpeg必须在新机重新安装、重新构建。

如果只需要新系统，建议保持空部署，并在控制台中重新创建用户、直播间、输出目标和任务。

## 10. 常用排障命令

```bash
sudo systemctl --no-pager --full status streamhub.service streamhub-rtmp.service
sudo journalctl -u streamhub.service -u streamhub-rtmp.service --since '30 minutes ago'
sudo tail -n 200 /opt/StreamHub/data/logs/*.log
sudo ss -ltnp | grep -E ':18080|:18081|:1935'
sudo bash /opt/StreamHub/scripts/60-verify.sh
```

安装日志位于：

```text
/var/log/streamhub-install/
```

## 11. 后续从云端更新

更新前先备份配置和业务数据：

```bash
sudo tar -czf /var/backups/streamhub-$(date +%F-%H%M).tar.gz \
  /etc/streamhub /opt/StreamHub/data
```

然后执行快进更新：

```bash
cd /opt/StreamHub
git status --short
sudo systemctl stop streamhub-rtmp.service streamhub.service
sudo git pull --ff-only origin main
sudo systemctl daemon-reload
sudo systemctl start streamhub.service streamhub-rtmp.service
sudo bash scripts/60-verify.sh
```

如果 `git status --short` 有本地源码修改，先停止更新并人工处理；禁止使用 `git reset --hard` 覆盖不明修改。

## 12. 回退原则

- 源码更新前记录旧提交：`git rev-parse HEAD`。
- 保留 `/etc/streamhub` 和 `/opt/StreamHub/data` 的维护窗口备份。
- FFmpeg 构建脚本会将旧运行时保留为 `/opt/StreamHub/runtime/ffmpeg.previous`。
- 回退源码时只能切换到已经确认可用的提交，并在回退后重新执行必要的安装/服务步骤和 `scripts/60-verify.sh`。
- 不要通过删除数据目录、强制重置仓库或覆盖生产配置实现回退。

## 13. 交接确认清单

- [ ] 新机器是 Ubuntu Server 24.04 LTS amd64。
- [ ] 已记录管理 IP、网关、DNS 和允许访问的管理网段。
- [ ] 已确认 GitHub 账号/仓库：`qwrrhjkl/streamhub`。
- [ ] 已从 `main` 分支拉取并核对目标提交。
- [ ] 已确认是否需要 NVIDIA/NVENC。
- [ ] 已确认是否需要 DeckLink，并准备两份官方厂商归档。
- [ ] 已设置新机器唯一的控制台强密码。
- [ ] 已完成 `scripts/60-verify.sh`。
- [ ] 已完成一次真实采集、编码和输出测试。
- [ ] 已限制 `18080` 和 `1935` 的网络访问范围。
- [ ] 已明确采用空部署还是迁移旧机业务数据。

