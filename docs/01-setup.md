# StreamHub 系统介绍

## 1. 系统定位

StreamHub 是面向导播、直播技术人员和服务器运维人员的中文直播信号接入与多平台分发系统。它运行在 Ubuntu Server 24.04 amd64 上，不依赖 Docker，通过一个 Web 控制台管理直播间、输入信号、推流平台、编码参数、画面叠加和运行监控。

发布包是干净初始状态：没有预置直播间、平台、推流密钥、任务、日志或监控历史。管理员部署后自行创建业务配置。

## 2. 主要功能

- 本地 RTMP 直播间：为 OBS、VLC 或硬件编码器生成发布地址和独立推流密钥。
- 多种输入：RTMP/SRT/HLS URL、本地视频、V4L2/ALSA 采集设备和 Blackmagic DeckLink。
- 原生 DeckLink 采集：StreamHub 直接调用带 DeckLink SDK 支持的 FFmpeg，采集同一输入的嵌入式视频与音频，不需要 OBS 或外部中转服务。
- 多平台分发：一个输入可以共享编码后推送到多个 RTMP、RTMPS、SRT 或本地录制目标；单个平台可以独立启停。
- NVIDIA NVENC：需要转码时使用 `h264_nvenc`，任务启动前执行最小硬件编码预检，失败时不会静默退回 CPU。
- 原样复制：符合条件的 RTMP 输入在无水印、无幻灯片时可以 `copy`，避免不必要的转码。
- 画面处理：支持有序静态水印和循环淡入淡出的透明幻灯片。
- 运行监控：显示实际编码模式、输出码率、FPS、累计网络丢帧、运行状态和错误；每秒原始监控数据保留 72 小时。
- 配置持久化：直播间、平台、任务和显示基线保存在本地 JSON 数据中，服务重启后仍可使用。

## 3. 系统架构

```text
OBS / URL / 文件 / V4L2 / DeckLink
                  |
                  v
        StreamHub Node.js 控制服务
          | 配置、校验、预检、监控
          v
   自编译 FFmpeg 7.1.2 (DeckLink + NVENC)
          |                     |
          |                     +--> 本地录制
          +--> RTMP / RTMPS / SRT 多路输出

OBS --> Nginx RTMP :1935 --> StreamHub 分发任务
```

### DeckLink 数据流

1. Web 控制台调用 `/api/devices`。
2. StreamHub 使用指定的 FFmpeg 执行 DeckLink 设备和格式发现。
3. 用户选择或手工输入设备名、输入格式码、像素格式和嵌入式音频声道数。
4. 任务启动时再次检查设备和格式，防止设备拔插或信号制式变化。
5. FFmpeg 以单个 DeckLink 输入接收视频和嵌入式音频，再通过 NVENC/CPU 编码分发。

### 编码选择

| 场景 | 自动视频模式 | 自动音频模式 |
| --- | --- | --- |
| RTMP 输入，无画面叠加 | `copy` | `copy` |
| RTMP 输入，有水印或幻灯片 | `h264_nvenc` | `copy` |
| V4L2 或 DeckLink 采集 | `h264_nvenc` | `aac` |

显式 `libx264` 只用于有意的 CPU 测试。采集输入、静态水印或幻灯片不能与视频 `copy` 组合。

## 4. 技术组成

- Ubuntu Server 24.04 LTS amd64
- Node.js 22：HTTP API、配置管理、任务编排和监控
- 原生 HTML、CSS、JavaScript：中文 Web 控制台
- FFmpeg 7.1.2：DeckLink 输入、NVENC/libx264 编码、SRT/TLS、画面叠加和多路输出
- Blackmagic Desktop Video 与 Desktop Video SDK：DeckLink 驱动、用户态组件和 `DeckLinkAPI.h`
- NVIDIA Ubuntu 驱动：NVENC 硬件编码
- Nginx RTMP 模块：本地直播间接入、发布鉴权回调和 RTMP 状态
- systemd：应用与 RTMP 服务启动、重启和日志管理

## 5. 端口与网络

| 端口 | 作用 | 建议暴露范围 |
| --- | --- | --- |
| `18080/tcp` | Web 控制台和 API | 仅管理网段 |
| `1935/tcp` | RTMP 发布与播放 | 仅可信推流/播放网段 |
| `127.0.0.1:18081/tcp` | Nginx RTMP 健康与统计 | 仅本机 |
| `10081/udp` | 预留 SRT 端口 | 默认不监听、不开放 |

## 6. 文件与数据

程序安装在 `/opt/StreamHub`，运行环境在 `/opt/StreamHub/runtime/ffmpeg`，服务环境变量在 `/etc/streamhub/streamhub.env`，安装状态和解包缓存位于 `/var/lib/streamhub-install`，安装日志位于 `/var/log/streamhub-install`。

业务数据位于 `/opt/StreamHub/data`：

- `state.json`：业务配置与显示基线。
- `logs/`：FFmpeg 与 Nginx 运行日志。
- `monitor-history/`：72 小时 JSONL 原始监控历史。
- `recordings/`：本地录制文件。
- `watermarks/`、`slideshow-cache/`：画面素材与缓存。

## 7. 安全与许可边界

应用和专用 Nginx 都以 `streamhub` 普通用户运行，systemd 启用文件系统保护、私有临时目录、`NoNewPrivileges` 和明确的可写数据目录。Web/API 本身不提供公网身份认证，必须放在受信任管理网络或额外的反向代理鉴权之后；RTMP 直播间通过流名与密钥校验，但端口仍应由防火墙限制来源。

Blackmagic Desktop Video 和 SDK 受厂商许可约束，不包含在发布包中。管理员必须从 [Blackmagic Design 官方支持页](https://www.blackmagicdesign.com/support/) 阅读并接受许可后下载，再放入 `vendor/blackmagic/`。StreamHub 只提供自动安装与编译接入脚本。

## 8. 验证边界

Windows 构建环境可以验证 Node.js 逻辑、文档、发布包和 PDF，但不能验证 Linux 内核模块、真实 NVIDIA 编码吞吐或 SDI/HDMI 信号锁定。最终验收必须在目标 Ubuntu 24.04 服务器上执行完整安装顺序和 `60-verify.sh`，再从 Web 控制台启动一次真实 DeckLink 输入任务。
