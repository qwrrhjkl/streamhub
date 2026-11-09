# Product

## Register

product

## Users

StreamHub 面向在 Ubuntu 直播服务器上进行信号接入、多平台分发和持续监控的导播、直播技术人员与网络运维人员。

## Product Purpose

StreamHub 是无 Docker 依赖的中文直播控制台。它统一管理本地 RTMP 直播间、URL 拉流、本地文件、V4L2/ALSA 与 Blackmagic DeckLink 采集、多平台推流、录制、NVENC/CPU 编码、画面叠加和 72 小时历史监控。新部署必须为空状态，不包含示例业务数据或密钥。

## Deployment Contract

- 目标系统：Ubuntu Server 24.04 LTS amd64。
- Web/API：`18080/tcp`；RTMP：`1935/tcp`；RTMP 健康：`127.0.0.1:18081`。
- SRT `10081/udp` 只预留，默认不监听。
- Node.js 22，systemd，专用普通用户 `streamhub`。
- FFmpeg 7.1.2 从官方源码与签名构建，启用 DeckLink、NVENC、libx264、SRT、TLS、FreeType 和 Fontconfig。
- Blackmagic Desktop Video 与 SDK 由管理员接受厂商许可后手工下载，发布包不包含这些文件。

## Capture Contract

V4L2 采集保留兼容格式，旧配置缺少 `capture.backend` 时按 `v4l2` 处理。DeckLink 使用：

```json
{
  "type": "capture",
  "capture": {
    "backend": "decklink",
    "device": "DeckLink device name",
    "formatCode": "auto",
    "rawFormat": "uyvy422",
    "audioChannels": 2
  }
}
```

StreamHub 通过自编译 FFmpeg 直接发现和采集 DeckLink，不依赖 OBS 或外部中转。设备名支持自动发现和手工输入；任务每次启动都重新检查设备与格式。DeckLink 视频和嵌入式音频来自同一个 FFmpeg 输入。

## Encoding Contract

- RTMP URL/本地 RTMP 直播间且无画面叠加：自动视频与音频均为 `copy`。
- RTMP 输入有水印或幻灯片：自动视频为 `h264_nvenc`，音频为 `copy`。
- V4L2/DeckLink 采集：自动视频为 `h264_nvenc`，音频为 AAC。
- 任何 NVENC 路径在启动进程前执行最小编码预检；失败为致命错误，不回退 CPU。
- 显式 `libx264` 只用于 CPU 测试。
- `copy` 不能与采集、水印或幻灯片组合，且必须使用共享转推。

## Monitoring Contract

实时轮询只获取当前快照且禁止请求重叠。每路输出分别保留内存历史，并将每秒原始数据持久化为 JSONL 72 小时。界面显示实际编码模式、输出码率、FPS、累计网络丢帧与最后错误；码率低于有效期望 30% 才产生带宽告警。显示重置只修改网络丢帧基线，不删除原始历史。

## Design Principles

- 专业、安静、直接，使用熟悉的运维工具模式。
- 运行状态、实际编码路径和错误原因优先显示。
- 配置保存、刷新和服务重启后保持一致。
- 危险操作确认，平台输出相互隔离。
- WCAG 2.1 AA，对比度、键盘焦点和窄屏长文本必须可用。
- 不使用营销式大标题、装饰性动画、卡片套卡片或不必要的视觉效果。
