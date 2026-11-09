# StreamHub 使用方法

## 1. 登录与运行状态

在管理网内打开 `http://服务器IP:18080`。首次部署后页面是空状态，需要先创建直播间或直接在分发任务中选择其他输入，再创建推流平台。

服务器上的常用命令：

```bash
sudo /opt/StreamHub/scripts/streamhubctl.sh status
sudo /opt/StreamHub/scripts/streamhubctl.sh restart
sudo /opt/StreamHub/scripts/streamhubctl.sh logs
sudo /opt/StreamHub/scripts/healthcheck.sh
```

## 2. 创建本地直播间并从 OBS 推流

1. 打开“本地直播间”，填写直播间名称与流名称并保存。
2. 在直播间卡片复制“推流服务器”和“推流密钥”。
3. OBS 的服务选择“自定义”。
4. 服务器填写 `rtmp://192.168.1.20:1935/live`，其中 `192.168.1.20` 仅为示例服务器 IP。
5. 串流密钥填写 StreamHub 显示的 `流名称?secret=发布密钥`。
6. OBS 开始推流后，直播间状态应变为发布中。

修改流名称、禁用直播间或停止分发任务会影响直播，界面会要求确认。

## 3. 创建推流平台

打开“推流平台”，填写平台名称、协议、服务器地址和推流密钥。支持：

- RTMP/RTMPS：服务器如 `rtmp://push.example.com/live`，密钥单独填写。
- SRT：可填写完整 caller URL；防火墙需按实际目标放行出站流量。
- 本地文件：填写 `/opt/StreamHub/data/recordings/event.flv` 等路径。

不要把真实推流密钥写入文档、截图或发布压缩包。平台可以先保存为禁用状态，联调前再启用。

## 4. 创建分发任务

打开“分发推流”，填写任务名称，选择输入，添加一个或多个已启用平台，设置运行模式与编码参数后保存。

### URL 输入

填写 RTMP、SRT、HLS 等可由 FFmpeg 读取的地址。RTMP 且无画面叠加时，“自动”模式会使用原样复制；其他 URL 是否支持自动模式取决于协议和编码要求。

### 本地文件

填写服务器上的绝对路径，并选择是否循环播放。文件必须允许 `streamhub` 用户读取。

### V4L2 / ALSA 采集

1. 输入源选择“采集卡信号”。
2. 采集接口选择“V4L2 / ALSA”。
3. 视频设备填写 `/dev/video0` 等节点。
4. 音频设备填写 `hw:0,0`；不采集音频时填写 `disabled`。
5. 选择输入分辨率和 FPS。

### Blackmagic DeckLink 采集

1. 输入源选择“采集卡信号”。
2. 采集接口选择“Blackmagic DeckLink”。
3. 从自动发现列表选择设备。如果发现失败，可按 FFmpeg 显示的完整名称手工输入。
4. 输入格式可以保留 `auto`，也可以选择 `Hp59` 等设备实际报告的格式码。
5. 像素格式通常选择 `uyvy422`；10-bit 工作流可按设备与下游要求选择 `yuv422p10` 或 `rgb10`。
6. 嵌入式音频声道可选 2、8 或 16。
7. 保存并启动任务。StreamHub 会在创建 FFmpeg 进程前重新检查设备和格式。

DeckLink 输入由 StreamHub 直接采集，不需要先启动 OBS。若提示“未找到设备”，依次检查 Desktop Video、内核模块、PCI/Thunderbolt 连接、`streamhub` 的 `video` 组和 Secure Boot；再执行 `dmesg | grep -i 'firmware version mismatch'`。如有固件不匹配提示，必须在维护窗口使用 Desktop Video firmware updater 更新采集卡固件并重启，不能只重编译 FFmpeg。若提示“不支持格式”，先把格式设为 `auto`，再核对 SDI/HDMI 输出制式。

## 5. 预览输入源

在“分发推流”的输入源区域下方点击“预览输入源”。预览仅显示视频，不播放音频，通常约 1 秒延迟；关闭窗口会自动断开预览。

运行中的共享转推任务会复用 StreamHub 的本机媒体中继，不会把预览发送到任何推流平台，也不会额外打开 DeckLink 或 V4L2 设备。首次部署此功能前已经运行的共享转推任务需要重启一次，才会生成可复用的本机预览镜像。

正在运行的直连模式采集任务不允许预览再次读取采集卡。将任务改为“共享转推”，保存并重启任务后，再使用预览功能。

## 6. 输入中断自动回退

任务已经启动后，如果 DeckLink、V4L2、本地直播间、RTMP/SRT/HLS 输入或本地文件暂时无信号、断开或读到文件结尾，StreamHub 不会停止已配置的平台输出。任务状态会显示为“黑屏回退中”，持续推送与任务输出分辨率、FPS 和码率一致的黑色视频及静音音频。

StreamHub 每 3 秒检测一次原始输入；输入恢复后会自动重新连接并回到正常画面。共享转推任务在回退期间的预览会显示同一黑屏画面，直连任务也不会重新打开采集卡设备。

首次启动时的无效设备、错误路径或 URL、未启用输出平台、不支持的采集格式和不可用的 NVENC 仍会直接报错，不会被黑屏回退掩盖。手动停止任务、禁用本地直播间或移除输出平台会取消等待恢复。

当原任务使用 `copy` 时，黑屏回退会临时使用 CPU H.264/AAC 编码，因为 FFmpeg 生成的黑帧和静音不能原样复制；真实输入恢复后会自动回到保存的编码设置。

## 7. 编码与画面设置

- `自动`：优先选择可解释的 `copy` 或 NVENC 路径。
- `copy`：只适合支持原样复制的输入，必须使用共享转推，不能叠加水印或幻灯片。
- `h264_nvenc`：明确要求 NVIDIA 硬件编码，启动前必须通过 NVENC 预检。
- `libx264`：显式 CPU 测试，不是 NVENC 失败后的自动回退。

设置输出分辨率、FPS、视频码率、关键帧间隔、音频编码、采样率和音频码率。实际模式为 `copy` 时，不生效的视频参数会被禁用。

水印可以一次上传多张并调整层级；幻灯片按列表顺序循环，播放间隔和淡入淡出时间以毫秒填写。素材必须在服务器数据目录中保持可用。

## 8. 启动、停止与平台隔离

保存任务后点击“开始”。启动前界面会再次确认输入、输出平台、DeckLink 与 NVENC 条件。共享转推模式会建立一个源侧中继和各平台独立输出；禁用或重启某个平台不会停止同一任务的其他输出。

停止任务会终止全部相关输出。修改正在运行的任务前应先停止，避免配置与实际进程不一致。

## 9. 监控与诊断

“推流状态”显示：

- 实际编码模式：`copy`、`NVENC` 或 `CPU`。
- 当前输出码率与 FPS。
- 累计网络丢帧和估算丢帧率。
- 进程状态、最后错误和 72 小时历史趋势。

码率低于有效期望 30% 才产生带宽告警。网络丢帧显示可以重置基线，但不会删除原始历史。

诊断命令：

```bash
sudo journalctl -u streamhub.service -u streamhub-rtmp.service --since "30 minutes ago"
sudo tail -n 200 /opt/StreamHub/data/logs/*.log
sudo ss -ltnp | grep -E ':18080|:1935|:18081'
/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg -hide_banner -sources decklink
nvidia-smi
```

## 10. 备份

停止服务后备份 `/opt/StreamHub/data` 和 `/etc/streamhub/streamhub.env`。恢复时保持文件所有者为 `streamhub:streamhub`，再启动应用和 RTMP 服务。不要从其他服务器复制 Blackmagic 驱动或 SDK 安装包，必须遵守厂商许可并在目标机安装。
