# DeckLink 驱动与 SDK 放置说明

本次 StreamHub 发布包不包含 Blackmagic Desktop Video 驱动或厂商 SDK 压缩包。需要 DeckLink 采集时，请先从 Blackmagic Design 官方支持页下载适用于 Linux 的 Desktop Video 驱动包，以及对应的 Desktop Video SDK，并自行阅读、接受厂商许可。

官方支持页：<https://www.blackmagicdesign.com/support/>

## 放置目录

把下载的两个原始压缩包上传到新服务器上的：

```text
/opt/StreamHub/vendor/blackmagic/
```

不要手动解压或改名。驱动归档内应包含适用于 Ubuntu amd64 的 `.deb` 安装包；SDK 归档内应包含 Linux 版本的 `DeckLinkAPI.h`。

放好文件后，按顺序执行：

```bash
cd /opt/StreamHub
sudo bash scripts/30-install-blackmagic.sh
sudo bash scripts/40-build-ffmpeg-decklink.sh
```

然后继续 `scripts/50-install-streamhub.sh` 和 `scripts/60-verify.sh`。如果暂时不需要 DeckLink，可不放这些厂商文件；安装脚本会跳过 DeckLink，USB V4L2/ALSA 与网络视频源仍可使用。

## 校验目录

上传完成后可运行：

```bash
find /opt/StreamHub/vendor/blackmagic -maxdepth 1 -type f -printf '%f\n'
```

目录中应看到 Desktop Video Linux 驱动归档和 Desktop Video Linux SDK 归档。具体文件名及版本以官方支持页当前提供的内容为准。
