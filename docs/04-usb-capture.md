# 新机无显卡 USB 采集部署手册

## 1. 硬件目标

本手册适用于 Ubuntu Server 24.04 amd64、无 NVIDIA 独立显卡、使用 USB 视频采集卡的主机。Intel 核显不会按 NVIDIA GPU 处理，也不会安装 NVIDIA 驱动。系统采用 CPU `libx264` 完成需要重新编码的工作。

## 2. 安装 Ubuntu 后准备

建议使用固定 IP，并确认新机器能够访问 Ubuntu 软件源、NodeSource、FFmpeg 官方站点和 Blackmagic 支持站点。至少准备 15 GiB 系统盘空间；视频素材、录制文件和监控历史还需要额外磁盘。

确认系统版本：

```bash
cat /etc/os-release
uname -m
```

必须分别看到 Ubuntu 24.04 和 `x86_64`/`amd64`。把部署 ZIP 解压到 `/opt/StreamHub`，不要解压到临时目录后直接运行。

## 3. 硬件检测逻辑

脚本 00 会检查网络、端口和硬件。检测到 NVIDIA 时启用 NVENC；没有 NVIDIA 时只记录 CPU 编码模式，不会失败。脚本 20 会再次检测，确认没有 NVIDIA 后直接完成，不运行 `ubuntu-drivers`、不安装 NVIDIA 驱动。

脚本 30 只有发现两份 Blackmagic 官方安装归档时才安装 Desktop Video 和 SDK。USB 采集卡不需要这两项；没有归档时会跳过 DeckLink。脚本 40 会根据这两个结果构建 FFmpeg：USB-only 主机启用 V4L2、ALSA、SRT、TLS、FreeType、Fontconfig 和 `libx264`，不启用 NVENC/DeckLink。

## 4. 执行安装

```bash
cd /opt/StreamHub
sudo bash scripts/00-preflight.sh
sudo bash scripts/10-install-base.sh
sudo bash scripts/20-install-nvidia.sh
sudo bash scripts/30-install-blackmagic.sh
sudo bash scripts/40-build-ffmpeg-decklink.sh
sudo bash scripts/50-install-streamhub.sh
sudo bash scripts/60-verify.sh
```

如果脚本 20 报告 NVIDIA 驱动需要重启，重启后重新执行脚本 20，再继续脚本 30。无 NVIDIA 主机不需要这一步。

## 5. USB 采集卡验证

插入采集卡后执行：

```bash
lsusb
v4l2-ctl --list-devices
v4l2-ctl --list-formats-ext -d /dev/video0
arecord -l
```

使用 FFmpeg 做短时本地测试时，先用采集卡实际支持的格式：

```bash
/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg \
  -f v4l2 -video_size 1920x1080 -framerate 30 -i /dev/video0 \
  -t 10 -an -f null -
```

如果采集卡有 HDMI/SDI 音频输入，再根据 `arecord -l` 的卡号测试 ALSA。设备名称、分辨率、帧率确认后，在 StreamHub 的分发任务中保存，不要凭经验填写不支持的格式。

## 6. 登录与初始配置

安装服务前，在 `/etc/streamhub/streamhub.env` 中为 `STREAMHUB_AUTH_PASSWORD` 设置唯一的强密码。首次运行 `scripts/50-install-streamhub.sh` 会创建该文件并在密码仍为占位值时停止；编辑后重新运行该脚本即可完成安装。

访问 `http://新机器IP:18080`，使用：

```text
用户名：admin
密码：你设置的 STREAMHUB_AUTH_PASSWORD
```

然后创建直播间、推流平台和分发任务。生产平台地址和 Stream Key 不会从 11.232 自动迁移，需要在新机器上重新填写。

## 7. 无显卡编码选择

无 NVIDIA 主机的编码下拉框中，`h264_nvenc` 会显示为不可用。编码选项含义如下：

- `copy`：不解码、不叠加、不重新编码，适合简单 RTMP 原样转推。
- `libx264（CPU）`：使用 CPU 编码，适合 USB 采集、无信号画面、水印、幻灯片和分辨率/帧率转换。
- `自动`：采集或需要叠加时自动选择 CPU `libx264`；网络源且没有叠加时优先使用 `copy`。

建议首次测试使用 1280x720、30 FPS 和 3000-6000 Kbps，确认 CPU 占用、输出 FPS 和丢帧稳定后，再提高参数。240H 类移动 CPU 运行多路 CPU H.264 时，需要根据任务数量和分辨率逐步压测。

## 8. 验收清单

```bash
systemctl is-active streamhub.service streamhub-rtmp.service
curl -fsS http://127.0.0.1:18080/api/health
curl -fsS http://127.0.0.1:18081/health
grep STREAMHUB_NVENC_ENABLED /etc/streamhub/streamhub-hardware.env
```

无显卡主机最后一条应为 `STREAMHUB_NVENC_ENABLED=0`。登录控制台后确认设备页能识别 USB 视频和音频设备；启动任务后确认实际编码模式为 `copy` 或 `CPU`，输出码率、FPS、丢帧和错误符合预期。

## 9. 常见问题

### 看不到 `/dev/video0`

检查 USB 线材、供电、`lsusb`、内核日志和设备是否被其他程序占用。更换 USB 3.x 接口后重新执行 `v4l2-ctl --list-devices`。

### CPU 编码性能不足

降低分辨率、帧率或码率，关闭不必要的幻灯片/叠加，并减少同时运行的编码任务。无显卡机器不能选择 `h264_nvenc`，不要通过接口手工提交该编码器。

### 音频没有输入

使用 `arecord -l` 确认采集卡是否暴露 ALSA 设备；视频和音频设备可能不是同一个编号。保存任务前先用短时 FFmpeg 命令验证设备。
