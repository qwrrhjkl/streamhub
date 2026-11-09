# 采集卡驱动与支持范围

采集卡厂商驱动、SDK 压缩包和许可文件不存放在本仓库。克隆仓库后，按具体型号从厂商官方渠道取得文件；不要把驱动包提交到 GitHub。

## Blackmagic DeckLink

当前安装脚本提供 DeckLink 安装流程。将官方 Linux Desktop Video 驱动归档和 SDK 原始归档放入：

```text
/opt/StreamHub/vendor/blackmagic/
```

保持厂商原始文件名，不要手动解压。然后执行：

```bash
cd /opt/StreamHub
sudo bash scripts/30-install-blackmagic.sh
sudo bash scripts/40-build-ffmpeg-decklink.sh
sudo bash scripts/60-verify.sh
```

详细说明见 [DeckLink驱动放置说明.md](DeckLink驱动放置说明.md)。Git 会忽略 `vendor/blackmagic/` 中除 `README.txt` 外的所有文件。

## DekTec DTA-2178

当前仓库的采集输入后端为 DeckLink 与标准 V4L2；DTA-2178 尚未集成到 StreamHub 的设备发现或采集配置。现有 `scripts/30-install-blackmagic.sh` 只安装 Blackmagic Desktop Video，**不是** DekTec 安装器。把 DekTec 驱动放到 `vendor/blackmagic/` 不会让 StreamHub 获得 DTA-2178 支持。

DTA-2178 需要 DekTec Linux 驱动/DTAPI，以及支持 DekTec `-f dektec` 输入的 FFmpeg 构建或官方集成版本。接入方式需要额外适配和验证；仅安装本仓库当前版本不能直接在 UI 选择这张卡。请从 [DekTec DTA-2178 产品页](https://www.dektec.com/products/PCIe/DTA-2178/)、[DekTec Linux SDK 下载页](https://www.dektec.com/downloads/SDK/) 和 [FFmpeg for DekTec](https://www.dektec.com/products/SDK/ffmpeg/) 获取当前厂商文件及支持说明。

在适配完成前，不要把未经验证的闭源驱动或 FFmpeg 二进制放进仓库，也不要假设 DeckLink 构建脚本可安装 DekTec 驱动。

## 标准 V4L2/ALSA 设备

如果某个采集设备由其驱动暴露为标准 `/dev/video*` V4L2 视频设备及 ALSA 音频设备，可按 USB/V4L2 流程接入；这不等于 StreamHub 原生管理该厂商 PCIe 卡的专有 API。
