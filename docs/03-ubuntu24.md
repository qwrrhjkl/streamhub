# StreamHub Ubuntu 24.04 安装环境

本手册适用于全新的 Ubuntu Server 24.04 LTS amd64，目标路径为 `/opt/StreamHub`。安装过程会配置 Node.js 22、Nginx RTMP、NVIDIA 驱动、Blackmagic Desktop Video、DeckLink SDK，以及带 DeckLink/NVENC 的 FFmpeg 7.1.2。RTMP 标准端口为 `1935/tcp`。

## 1. 硬件与固件准备

- amd64 服务器，建议至少 8 核 CPU、16 GiB 内存、30 GiB 可用磁盘。
- NVIDIA 支持 NVENC 的 GPU，连接正常且服务器固件已启用对应 PCIe 插槽。
- Blackmagic DeckLink 采集卡或受支持的 Thunderbolt/USB 设备，安装在厂商支持的拓扑中。
- SDI/HDMI 信号源在最终验证时可用，制式已知。
- 固件、BMC 和主板 BIOS 更新到生产认可版本。安装 Desktop Video 后，如 `dmesg` 出现 `firmware version mismatch`，必须在维护窗口使用 Desktop Video firmware updater 升级采集卡固件并重启；不要仅重编译 FFmpeg 或忽略该提示。

检查：

```bash
uname -m
cat /etc/os-release
lspci -nn | grep -Ei 'NVIDIA|Blackmagic|DeckLink'
df -h /
sudo mokutil --sb-state
```

Secure Boot 启用时，NVIDIA 与 Blackmagic DKMS 内核模块可能需要 MOK 注册。无人值守服务器建议在维护窗口完成注册与重启；如果安全策略允许，也可以在固件中关闭 Secure Boot。不要在未确认组织安全要求时直接改变该设置。

## 2. 上传和解压系统文件

把发布包与 `.sha256` 上传到服务器并验证：

```bash
cd /tmp
sha256sum -c StreamHub-ubuntu24.04-amd64-20260725.tar.gz.sha256
sudo mkdir -p /opt
sudo tar -xzf StreamHub-ubuntu24.04-amd64-20260725.tar.gz -C /opt
sudo test -f /opt/StreamHub/MANIFEST.sha256
cd /opt/StreamHub
sha256sum -c MANIFEST.sha256
```

发布包不会包含业务密钥、日志、历史数据或 Blackmagic 受许可安装包。

## 3. 获取 Blackmagic 官方文件

1. 在有浏览器的管理电脑打开 [Blackmagic Design 官方支持页](https://www.blackmagicdesign.com/support/)。
2. 选择当前支持 Linux 的 Desktop Video 下载，阅读并接受许可。
3. 下载 Desktop Video SDK，阅读并接受许可。
4. 不解压、不改名，把两个原始 ZIP/TAR 文件上传到 `/opt/StreamHub/vendor/blackmagic/`。
5. 确认 SDK 归档中最终可以找到 `DeckLinkAPI.h`。

2026-07-25 查看到的版本是 Desktop Video 16.1 for Linux 和 Desktop Video 16.0 SDK。厂商可能更新版本，应优先使用支持页当前版本，并确认采集卡兼容性。StreamHub 不代为下载或再分发这些文件。

## 4. 系统将安装的服务与软件

安装脚本会执行相当于以下内容的操作：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg software-properties-common
sudo add-apt-repository -y universe
sudo add-apt-repository -y multiverse
sudo apt-get install -y build-essential cmake dkms git iproute2 jq nginx libnginx-mod-rtmp \
  alsa-utils v4l-utils pciutils mokutil linux-headers-"$(uname -r)" pkg-config nasm yasm \
  autoconf automake libtool xz-utils unzip rsync libx264-dev libsrt-openssl-dev \
  libssl-dev libfreetype-dev libfontconfig1-dev libffmpeg-nvenc-dev
sudo apt-get install -y ubuntu-drivers-common
sudo ubuntu-drivers install --gpgpu
```

Node.js 22 使用 NodeSource 的签名 APT 仓库安装；脚本只下载并安装仓库签名密钥和 APT 源，不把远程脚本直接传给 Bash。Blackmagic `.deb` 只从 `/opt/StreamHub/vendor/blackmagic/` 中的归档解出。FFmpeg 源码从 ffmpeg.org 下载并用官方签名验证后编译。

最终 systemd 服务：

- `streamhub.service`：Node.js Web/API、配置与任务管理，端口 `18080/tcp`。
- `streamhub-rtmp.service`：专用 Nginx RTMP，端口 `1935/tcp`，健康端点 `127.0.0.1:18081`。

两个服务均使用 `streamhub` 普通用户，不使用 root 运行。

## 5. 严格安装顺序

每一步成功后再执行下一步。所有命令从 `/opt/StreamHub` 运行。

### 5.1 预检：00-preflight.sh

```bash
cd /opt/StreamHub
sudo bash scripts/00-preflight.sh
```

检查系统版本、amd64、磁盘、DNS/HTTPS、NVIDIA/Blackmagic PCI 信息和端口冲突。若 `18080`、`1935` 或 `18081` 已占用，先停止冲突服务再重跑。

### 5.2 基础环境：10-install-base.sh

```bash
sudo bash scripts/10-install-base.sh
```

安装构建工具、Node.js 22、Nginx RTMP、V4L2/ALSA 工具和 FFmpeg 编译依赖。

### 5.3 NVIDIA：20-install-nvidia.sh

```bash
sudo bash scripts/20-install-nvidia.sh
```

脚本执行 `ubuntu-drivers install --gpgpu`。如果结尾提示驱动尚未激活：

```bash
sudo reboot
# 重新登录后
cd /opt/StreamHub
sudo bash scripts/20-install-nvidia.sh
```

只有 `nvidia-smi` 成功后才继续。

### 5.4 Blackmagic：30-install-blackmagic.sh

```bash
sudo bash scripts/30-install-blackmagic.sh
```

脚本安全解压 vendor 目录内的归档，安装 amd64/all Desktop Video `.deb`，部署 SDK 头文件并记录路径。如果内核模块因 Secure Boot 尚未加载，完成 MOK 注册或维护窗口重启，然后重跑本步骤。

### 5.5 编译 FFmpeg：40-build-ffmpeg-decklink.sh

```bash
sudo bash scripts/40-build-ffmpeg-decklink.sh
```

编译结果安装到 `/opt/StreamHub/runtime/ffmpeg`，必须同时显示 `decklink`、`h264_nvenc`、SRT 和 TLS 支持。对于 Desktop Video SDK 16，脚本会在官方验签的 FFmpeg 7.1.2 源码上应用可审计的 `v14_2_1` DeckLink 兼容补丁；旧的自编译版本保留在 `runtime/ffmpeg.previous` 供回退。

### 5.6 安装并启动服务：50-install-streamhub.sh

```bash
sudo bash scripts/50-install-streamhub.sh
```

创建 `streamhub` 用户和数据目录，安装 `/etc/streamhub/streamhub.env` 与 systemd 单元，校验 Nginx 配置，启用并启动两个服务。

### 5.7 完整验证：60-verify.sh

```bash
sudo bash scripts/60-verify.sh
```

必须通过 Node、FFmpeg/ffprobe、NVIDIA、DeckLink 枚举、systemd、健康端点和监听端口检查。没有活动 SDI/HDMI 信号可以是提示，但设备本身无法枚举属于失败。

## 6. 防火墙

不要把管理界面或 RTMP 接入直接暴露给公网。以下示例只允许管理网 `192.168.10.0/24` 和制作网 `192.168.20.0/24`：

```bash
sudo ufw default deny incoming
sudo ufw allow from 192.168.10.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.10.0/24 to any port 18080 proto tcp
sudo ufw allow from 192.168.20.0/24 to any port 1935 proto tcp
sudo ufw enable
sudo ufw status verbose
```

`18081/tcp` 只绑定环回地址，不添加 UFW 规则。`10081/udp` 仅为预留端口，默认不监听、不开放。

## 7. 安装后验收

```bash
systemctl --no-pager --full status streamhub.service streamhub-rtmp.service
curl -fsS http://127.0.0.1:18080/api/health
curl -fsS http://127.0.0.1:18081/health
sudo ss -ltnp | grep -E ':18080|:1935|:18081'
nvidia-smi
/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg -hide_banner -encoders | grep h264_nvenc
/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg -hide_banner -sources decklink
```

然后在 Web 控制台创建一个 DeckLink 任务，选择设备和实际输入格式，向测试平台推送至少 10 分钟，观察实际 FPS、码率、NVENC 模式和网络丢帧。

## 8. 日常维护、备份与回退

```bash
sudo /opt/StreamHub/scripts/streamhubctl.sh status
sudo /opt/StreamHub/scripts/streamhubctl.sh restart
sudo /opt/StreamHub/scripts/streamhubctl.sh logs
```

备份：

```bash
sudo systemctl stop streamhub-rtmp.service streamhub.service
sudo tar -czf /var/backups/streamhub-data-$(date +%F).tar.gz \
  /opt/StreamHub/data /etc/streamhub
sudo systemctl start streamhub.service streamhub-rtmp.service
```

FFmpeg 回退：停止服务，交换 `runtime/ffmpeg` 与 `runtime/ffmpeg.previous`，重新运行完整验证。应用版本回退时先备份 `data/state.json`，只用已验证的发布包覆盖程序目录，绝不覆盖数据目录。

## 9. 故障排查

| 症状 | 检查 |
| --- | --- |
| `nvidia-smi` 失败 | Secure Boot、内核头、DKMS 状态、重启、`journalctl -k` |
| FFmpeg 没有 `h264_nvenc` | `libffmpeg-nvenc-dev`、编译日志、NVIDIA 驱动版本 |
| 未发现 DeckLink | Desktop Video 包、`lsmod`、`lspci`、设备供电、`video` 组、Secure Boot；再执行 `dmesg \| grep -i 'firmware version mismatch'`。如有提示，用 Desktop Video firmware updater 更新固件并重启 |
| 设备存在但格式失败 | 信号源制式、格式码大小写、先改为 `auto`、重新插拔/锁定信号 |
| RTMP 无法推流 | UFW、`1935/tcp`、直播间流名/密钥、Nginx 日志 |
| Web 无法访问 | `18080/tcp`、管理网路由、应用服务日志 |
| 服务反复重启 | `/etc/streamhub/streamhub.env`、数据目录所有者、自编译 FFmpeg 路径 |

安装日志位于 `/var/log/streamhub-install/`，运行日志优先查看 systemd journal 和 `/opt/StreamHub/data/logs/`。
