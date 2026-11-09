# StreamHub

StreamHub 是运行在 Ubuntu Server 24.04 amd64 上的中文直播推流控制服务，提供采集预览、多平台分发、录制、水印、幻灯片、无信号画面和运行监控。

## 仓库内容

仓库保存可审计的服务源码、前端、安装脚本、systemd/Nginx 配置、测试和部署文档。以下内容不会提交：

- Blackmagic Desktop Video 驱动、SDK 原始归档和其他采集卡驱动；
- `/data` 运行数据、日志、录制文件、缓存、任务状态和生产配置；
- `/runtime` 预编译 FFmpeg；
- 用户密码、平台推流密钥和临时发布包。

## 新机安装

目标目录为 `/opt/StreamHub`。完整步骤见 [NEW-INSTALL-README.md](NEW-INSTALL-README.md)。基本顺序：

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

没有 Blackmagic 采集卡时可以跳过第 30 步；安装脚本会使用 V4L2/ALSA 或网络输入。需要 DeckLink 时，先阅读 [DeckLink驱动放置说明.md](DeckLink驱动放置说明.md)，把厂商文件放到 `/opt/StreamHub/vendor/blackmagic/`，不要把它们提交到仓库。采集卡支持边界见 [CAPTURE-DRIVERS.md](CAPTURE-DRIVERS.md)。

## 认证与端口

配置模板在 `config/streamhub.env.example`。首次执行安装脚本时，先为 `STREAMHUB_AUTH_PASSWORD` 设置唯一的强密码；占位值会被安装器拒绝。Web/API 默认端口为 `18080/tcp`，RTMP 为 `1935/tcp`，内部健康端点为 `127.0.0.1:18081`。不要把管理端口直接暴露到公网。

## 从 GitHub 更新服务器

服务器初次部署完成后，可以把 `/opt/StreamHub` 保持为这个仓库的 Git 工作树。后续源码更新只需在开发机提交并推送：

```bash
git add .
git commit -m "Describe the change"
git push origin main
```

私有仓库服务器应配置只读 GitHub Deploy Key，并使用 SSH remote；密钥保存在服务器账户的 `.ssh` 目录，不要写入仓库、服务配置或 remote URL。服务器维护窗口更新并重启服务：

```bash
cd /opt/StreamHub
sudo systemctl stop streamhub-rtmp.service streamhub.service
sudo git pull --ff-only origin main
sudo systemctl daemon-reload
sudo systemctl start streamhub.service streamhub-rtmp.service
sudo bash scripts/60-verify.sh
```

`/etc/streamhub/streamhub.env` 和 `/opt/StreamHub/data` 不在仓库中，`git pull` 不会覆盖它们。PAT 不要写入 Git remote。涉及 FFmpeg 构建脚本、NVIDIA/Blackmagic 驱动、系统包或 systemd 配置的更新，需要按变更说明重新执行对应安装步骤，而不是盲目重启。

更完整的发布与回退规则见 [docs/GIT-更新流程.md](docs/GIT-更新流程.md)。

## 测试

```bash
npm test
```

测试结果和当前版本限制记录在 [PACKAGE-VERIFICATION.md](PACKAGE-VERIFICATION.md)。
