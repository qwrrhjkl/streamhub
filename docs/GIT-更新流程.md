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

不要把 PAT 写入仓库 URL、脚本、`.git/config` 或文档。使用 Git Credential Manager、SSH deploy key 或 GitHub CLI 进行认证。PAT 曾经出现在聊天或终端记录中时，应在 GitHub 立即撤销并重建。

## 服务器更新

首次把服务器目录初始化为仓库工作树后，源码更新可以使用快进拉取：

```bash
cd /opt/StreamHub
sudo systemctl stop streamhub-rtmp.service streamhub.service
sudo git pull --ff-only origin main
sudo systemctl daemon-reload
sudo systemctl start streamhub.service streamhub-rtmp.service
sudo bash scripts/60-verify.sh
```

更新前建议备份配置和业务数据：

```bash
sudo tar -czf /var/backups/streamhub-$(date +%F-%H%M).tar.gz \
  /etc/streamhub /opt/StreamHub/data
```

如果工作树有本地修改，不要使用 `git reset --hard` 覆盖它们；先保存差异或在维护窗口人工处理。Git 仓库只管理源码，`/etc/streamhub/streamhub.env`、`/opt/StreamHub/data`、厂商驱动和 FFmpeg 编译产物保持在服务器本地。

## 哪些变更需要重新安装

- 只改 `app/`、`server/` 或普通文档：拉取后重启 `streamhub.service` 即可。
- 改 `services/`：拉取后重新执行 `systemctl daemon-reload`，必要时重启对应服务。
- 改 `scripts/10-install-base.sh`、Node.js 版本或系统依赖：在维护窗口重新执行对应编号脚本。
- 改 FFmpeg 构建脚本、DeckLink SDK 兼容补丁或 NVIDIA 配置：重新执行第 20、30、40 步并通过第 60 步验证。
- 更换采集卡驱动：按照厂商说明把文件放到 `/opt/StreamHub/vendor/blackmagic/`，驱动原始包不要提交到 GitHub。
