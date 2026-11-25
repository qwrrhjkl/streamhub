# Git 发布与服务器更新流程

## 开发机发布

只提交源码、脚本、配置模板和文档。提交前检查：

```bash
git status --short
git diff --check
git grep -Il -I -E 'github_pat_|ghp_[A-Za-z0-9]|-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----' -- ':!tests'
```

确认没有生产密码、推流密钥、私有地址或日志后再提交：

```bash
git add .
git commit -m "Describe the change"
git push origin main
```

不要把 PAT 写入仓库 URL、脚本、`.git/config` 或文档。PAT 曾经出现在聊天或终端记录中时，应在 GitHub 立即撤销并重建。

## 设置页自动更新

当前公开仓库无需访问凭据。要启用设置页的版本更新，机器必须以官方 Git `main` 工作树部署到 `/opt/StreamHub`；tar.gz 解压版不含 Git 元数据，不支持该功能。新机可以直接克隆：

```bash
sudo git clone --branch main --single-branch https://github.com/qwrrhjkl/streamhub.git /opt/StreamHub
```

管理员在“设置 → 版本与更新”检查并确认后，受限 systemd helper 会再次核对官方仓库、`main` 分支、工作树干净状态和目标提交，并阻止推流/预览/录制进行中的更新。它只自动更新普通应用源码与文档；涉及 `scripts/`、`services/`、`config/`、依赖及运行时的提交需要人工部署。更新前会在 `/var/backups/streamhub/updater/` 创建 Git bundle，快进后重启并检查健康端点；失败时尝试恢复并重启原版本。发生无法自动恢复的情况应通过 SSH 检查 systemd 服务和代码版本。

GitHub 凭据不在 Web 页面设置，也不在确认更新时询问。此功能只针对当前公开仓库的 HTTPS remote；如果未来仓库改为私有，应先单独设计服务器只读凭据的配置、保护与轮换流程。

## 服务器手动更新

tar.gz 安装、非官方源、分支偏离或工作树有本地改动时，需要在维护窗口手动更新。更新前建议备份配置和业务数据：

```bash
sudo tar -czf /var/backups/streamhub-$(date +%F-%H%M).tar.gz \
  /etc/streamhub /opt/StreamHub/data
```

Git 仓库只管理源码，`/etc/streamhub/streamhub.env`、`/opt/StreamHub/data`、厂商驱动和 FFmpeg 编译产物保持在服务器本地。若工作树有本地修改，不要使用 `git reset --hard` 覆盖它们；先保存差异或在维护窗口人工处理。

## 哪些变更需要重新安装

- 只改 `app/`、`server/` 或普通文档：拉取后重启 `streamhub.service` 即可。
- 改 `services/`：拉取后重新执行 `systemctl daemon-reload`，必要时重启对应服务。
- 改 `scripts/10-install-base.sh`、Node.js 版本或系统依赖：在维护窗口重新执行对应编号脚本。
- 改 FFmpeg 构建脚本、DeckLink SDK 兼容补丁或 NVIDIA 配置：重新执行第 20、30、40 步并通过第 60 步验证。
- 更换采集卡驱动：按照厂商说明把文件放到 `/opt/StreamHub/vendor/blackmagic/`，驱动原始包不要提交到 GitHub。
