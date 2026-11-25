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

StreamHub 的 GitHub 仓库目前是公开仓库，因此每台服务器无需配置仓库密码、PAT 或 SSH 密钥。要启用设置页里的“版本与更新”，安装时须将 `/opt/StreamHub` 部署为官方 `main` 分支的 Git 工作树（而不是只解压发布归档）：

```bash
sudo git clone --branch main --single-branch https://github.com/qwrrhjkl/streamhub.git /opt/StreamHub
cd /opt/StreamHub
```

运行安装脚本后，管理员可在“设置 → 版本与更新”检查提交；确认后系统会备份当前 Git 版本、快进到检查过的提交、重启服务并做健康检查。只有官方 HTTPS 仓库、`main` 分支和无本地改动的工作树受支持；推流、预览、录制运行中不能更新。更新失败时会尝试回退，并在页面显示状态。

若机器是从 tar.gz 发布包解压安装，它不包含 Git 元数据，设置页可以查看功能但不能在线更新。此类机器须在维护窗口手动按部署说明升级，或重新按 Git 克隆方式部署。普通源码更新可由开发机提交推送：

```bash
git add .
git commit -m "Describe the change"
git push origin main
```

系统仅自动安装 `app/`、`server/` 和一般文档的快进提交。涉及安装脚本、systemd 服务、配置、依赖、FFmpeg 或运行时的提交会被拦截，需人工维护窗口处理。服务器状态和回退备份分别保存在 `/opt/StreamHub/data/` 与 `/var/backups/streamhub/updater/`。

该功能仅支持当前公开仓库；不要在 Web 页面粘贴 GitHub 凭据。如将来迁移到私有仓库，应使用服务器侧只读 Deploy Key 或其他受控凭据方案，并先设计密钥权限、轮换与审计，再启用私有仓库更新。

如果无法使用设置页自动更新，维护人员可在服务器 SSH 会话中按既有的 Git 更新流程操作：

```bash
cd /opt/StreamHub
sudo systemctl stop streamhub-rtmp.service streamhub.service
sudo git pull --ff-only origin main
sudo systemctl daemon-reload
sudo systemctl start streamhub.service streamhub-rtmp.service
sudo bash scripts/60-verify.sh
```

`/etc/streamhub/streamhub.env` 和 `/opt/StreamHub/data` 不在仓库中，Git 更新不会覆盖它们。涉及 FFmpeg 构建脚本、NVIDIA/Blackmagic 驱动、系统包或 systemd 配置的更新，需要按变更说明重新执行对应安装步骤，而不是盲目重启。

更完整的发布与回退规则见 [docs/GIT-更新流程.md](docs/GIT-更新流程.md)。

## 测试

```bash
npm test
```

测试结果和当前版本限制记录在 [PACKAGE-VERIFICATION.md](PACKAGE-VERIFICATION.md)。
