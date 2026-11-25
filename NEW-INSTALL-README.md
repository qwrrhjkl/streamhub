# StreamHub Ubuntu 24.04 新机安装包

这是从当前运行版本制作的 StreamHub 软件快照，目标系统为 Ubuntu Server 24.04 LTS amd64。它包含 Web/API、服务端、测试、安装脚本、systemd/Nginx 配置、编译补丁和图标资源。

安装脚本会在新机器上安装 Node.js、Nginx RTMP 与构建依赖，并从 FFmpeg 官方站点下载验签源码后编译 FFmpeg。NVIDIA 和 Blackmagic/DeckLink 支持按机器实际硬件与是否提供厂商文件启用。

## 不包含

- Blackmagic Desktop Video 驱动安装包。
- Blackmagic Desktop Video SDK 原始压缩包。
- 服务器现有账号密码、推流密钥、业务任务、运行数据、日志、录制内容和监控历史。
- 预编译 FFmpeg 二进制。安装脚本会在目标 Ubuntu 上构建匹配的版本。

需要 DeckLink 时，请按随附的《DeckLink驱动放置说明.md》下载并放置驱动与 SDK。该文件也可单独提供给负责新机安装的人员。

## 选择部署方式

如果需要以后从设置页自动更新，推荐联网机器直接克隆官方仓库，并在此目录运行安装脚本：

```bash
sudo git clone --branch main --single-branch https://github.com/qwrrhjkl/streamhub.git /opt/StreamHub
cd /opt/StreamHub
```

官方仓库目前公开，无需每台机器配置访问凭据。请不要在 Web 页面输入 GitHub PAT 或密码；更新使用服务端受限的系统服务，并只接受干净的官方 HTTPS `main` 工作树。

如需离线或固定版本部署，可使用发布归档；它不包含 `.git` 元数据，因此设置页自动更新不可用。把 `StreamHub-ubuntu24.04-amd64-20261106.tar.gz` 与同名 `.sha256` 文件上传到新机器，然后执行：

```bash
cd /tmp
sha256sum -c StreamHub-ubuntu24.04-amd64-20261106.tar.gz.sha256
sudo tar -xzf StreamHub-ubuntu24.04-amd64-20261106.tar.gz -C /opt
cd /opt/StreamHub
```

发布归档内有 `MANIFEST.sha256`，解压后可运行 `sha256sum -c MANIFEST.sha256` 校验软件文件。

## 安装顺序

有 DeckLink 的机器：先把 Blackmagic 驱动和 SDK 原始包放入 `/opt/StreamHub/vendor/blackmagic/`，然后按顺序执行：

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

首次运行第 50 步会创建 `/etc/streamhub/streamhub.env`。编辑该文件，将 `STREAMHUB_AUTH_PASSWORD` 设置为唯一的强密码，然后再次运行第 50 步完成安装；占位密码会被安装脚本拒绝。

如果本次不配置 DeckLink，可不放厂商文件；第 30 和 40 步会按脚本逻辑跳过 DeckLink，USB V4L2/ALSA 与网络源仍可用。若后来才补装 DeckLink 文件，应先重新运行第 30、40 步，再执行第 60 步验证。

安装脚本自动检测 NVIDIA GPU：没有 NVIDIA GPU 时会跳过驱动和 NVENC，使用 CPU `libx264`。如果 NVIDIA 驱动安装后需要重启，第 20 步会提示；重启后重新执行第 20 步再继续。

## 登录和端口

- Web/API：`http://新机器IP:18080`
- 默认用户名：`admin`
- 密码：首次安装时在 `/etc/streamhub/streamhub.env` 中自行设置
- RTMP：`1935/tcp`
- 内部健康端点：`127.0.0.1:18081`，不要暴露到网络

请妥善保存自行设置的密码，并只允许可信管理网段访问 18080。按需配置主机防火墙和网络 ACL，不要把管理界面直接暴露到公网。

## 硬件和空间

使用 amd64 Ubuntu Server 24.04。预检要求根分区至少有 15 GiB 可用空间；FFmpeg 编译期间需要更多临时空间，建议准备至少 30 GiB 可用磁盘。执行前确认安装窗口内服务器可以访问 Ubuntu 软件源、NodeSource、ffmpeg.org 和 Blackmagic 官方支持页。

## 验证

安装完成后 `scripts/60-verify.sh` 会检查 StreamHub 与 RTMP 服务、健康端点、Nginx 配置、FFmpeg 编码器和设备能力。随后在 Web 控制台重新录入平台服务器地址与推流密钥；旧机器上的密钥不会迁移到此软件包。
