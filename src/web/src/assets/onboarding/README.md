# 首次语音引导素材

这五段固定配音使用项目已配置的 DashScope `qwen3-tts-flash`、`Serena`
音色和默认语速生成，仅合成公开的界面引导文案，没有使用采访或用户材料。
页面运行时直接播放随 Vite 打包的文件，不再请求 TTS 服务，也不申请麦克风。

文案来源：`web/src/content/voice-onboarding.json`。第四屏使用由三段教学
无损串接的 `guide-full.wav` 连续播放，避免逐段加载造成停顿。
`manifest.json` 的 `guide_track.cues` 记录各段起始时间（毫秒）、文案和
从零开始的序号，供播放器按实际播放进度切换字幕。原始分段文件、时长和
摘要仍保留，方便修改文案时核对配音版本。

| 文件 | 时长 |
| --- | ---: |
| permission-1.wav | 3.28 秒 |
| permission-2.wav | 4.08 秒 |
| guide-1.wav | 3.68 秒 |
| guide-2.wav | 7.36 秒 |
| guide-3.wav | 6.16 秒 |
| guide-full.wav | 17.20 秒 |

授权说明素材合计 7.36 秒（授权页当前不播放）；首次教学合计 17.20 秒。文件为 24 kHz、单声道、
16-bit PCM WAV。生成脚本会修复供应商流式 WAV 的占位长度，确保浏览器
读取真实时长并正常触发播放结束事件。

修改公开文案后，在项目根目录手动执行：

```bash
.venv/bin/python tools/build_onboarding_audio.py
```

脚本使用现有 `.env` 中的 TTS 配置，但不会将凭据、接口响应或配置 URL
写入素材或日志；全部句子和连续音轨成功生成后才替换素材。浏览器阻止播放或音频
失败时可重试播放，页面始终保留文字和继续入口。

只需从现有分段重新生成连续音轨及字幕时间点时，可离线执行：

```bash
python3 tools/build_onboarding_audio.py --pack-existing
```

此模式仅使用 Python 标准库，不读取 `.env`、不创建 TTS 服务、也不访问网络。
合并前会校验分段文案、文件摘要和 PCM 格式；字幕时间点按累计采样数计算，
不改动声音、语速或文案。
