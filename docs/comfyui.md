# 用 ComfyUI 工作流生成视频

剧本、资产提取、生图仍走云端 API；视频生成可以切到本机或内网的 ComfyUI，由你自己的工作流（Wan 2.x、Hunyuan Video、LTX、CogVideoX 等）出片。火宝负责把分镜的提示词、参考图、时长、分辨率塞进工作流，提交到 ComfyUI，轮询结果并把 mp4 拉回本地。

## 1. 准备 ComfyUI

1. 启动 ComfyUI，确认浏览器能打开 `http://127.0.0.1:8188`（局域网机器就填它的地址）。
2. 在 ComfyUI 里把图生视频工作流调通一次，保证能产出 **mp4 / webm**（推荐 `SaveVideo` 或 VideoHelperSuite 的 `VHS_VideoCombine`，format 选 `video/h264-mp4`）。gif / webp 输出不会被识别。
3. 设置 → 开启 **Dev mode / 开发者模式**，然后用 **Export (API)** 导出工作流 JSON（文件内容是 `{"3": {"class_type": ..., "inputs": {...}}, ...}` 这种结构；界面格式的 `nodes/links` 数组不能用）。

## 2. 在火宝里添加视频服务

设置 → AI 服务 → 视频 → 添加，选模板 **ComfyUI 本地工作流**：

| 字段 | 填法 |
|---|---|
| Base URL | `http://127.0.0.1:8188`（或内网地址；经 Nginx 反代也行） |
| API Key | 留空。只有反代加了 `Authorization: Bearer` 鉴权时才填 |
| 模型 | 随便起个名字做标识，如 `wan2.2-i2v-14b`；工作流里可用 `{{model}}` 读到它 |
| 工作流 | 粘贴 API 格式 JSON，或点「从文件导入」 |
| 负向提示词 | 可选，会写进负向 CLIPTextEncode |
| 帧率 | 用来把分镜时长换成帧数，默认 16 |

保存后把这条配置的优先级调到最高（或在工作台模型下拉里直接选它），之后点「生成视频」就走 ComfyUI。可以添加多条 ComfyUI 配置，各挂不同的工作流，在工作台按分镜切换。

## 3. 工作流怎么拿到分镜数据

### 方式 A：什么都不改（自动填充）

适合标准的图生视频工作流。适配器会：

- 把分镜提示词写进 **正向** `CLIPTextEncode`（按采样器 `positive` 连线反查；查不到就按节点标题含 `negative/负向` 排除）
- 把负向提示词写进 **负向** `CLIPTextEncode`
- 按节点 id 顺序给 `LoadImage` 节点填图：首帧（或第 1 张参考图）→ 尾帧 → 其余参考图。标题含 `last / end / 尾` 的节点优先拿尾帧
- 给第 1 个 `LoadVideo` / `LoadAudio` 节点填参考视频 / 音频（如果分镜有）
- 把所有 `seed` / `noise_seed` 换成随机数，避免 ComfyUI 命中缓存直接返回上一次结果

### 方式 B：写占位符（精确控制）

在导出的 JSON 里，把想让火宝填的字段改成占位符字符串：

```json
"6": {
  "class_type": "CLIPTextEncode",
  "inputs": { "text": "{{prompt}}", "clip": ["38", 0] }
},
"52": {
  "class_type": "LoadImage",
  "inputs": { "image": "{{first_frame}}", "upload": "image" }
},
"50": {
  "class_type": "WanImageToVideo",
  "inputs": { "width": "{{width}}", "height": "{{height}}", "length": "{{frames}}", ... }
},
"3": {
  "class_type": "KSampler",
  "inputs": { "seed": "{{seed}}", ... }
}
```

| 占位符 | 内容 |
|---|---|
| `{{prompt}}` / `{{negative_prompt}}` | 分镜提示词（已注入项目风格词）/ 配置里的负向提示词 |
| `{{image}}` | 主图：首帧 > 图片 > 第 1 张参考图 |
| `{{first_frame}}` / `{{last_frame}}` | 首帧 / 尾帧 |
| `{{image_1}}` … `{{image_9}}` | 第 n 张图（首帧在前，其后是绑定的场景/角色/道具图） |
| `{{video}}` `{{video_1}}`… / `{{audio}}` `{{audio_1}}`… | 参考视频 / 参考音频 |
| `{{width}}` / `{{height}}` | 由集分辨率（480p/720p/1080p）和项目画幅算出的像素，16 的倍数 |
| `{{duration}}` / `{{fps}}` / `{{frames}}` | 时长（秒）/ 帧率 / 帧数（`duration×fps` 取 4n+1） |
| `{{seed}}` | 随机种子 |
| `{{model}}` / `{{aspect_ratio}}` / `{{resolution}}` | 配置里的模型名 / 画幅 / 分辨率档位 |

规则：

- 字段**整个**就是一个占位符时，按原类型写入（`"{{frames}}"` → `81`，数字节点不会收到字符串）。
- 占位符嵌在长文本里时做字符串替换，比如 `"text": "cinematic, {{prompt}}, 8k"`。
- 图片类占位符对应的素材会先上传到 ComfyUI 的 `input/huobao/` 目录，写进节点的是文件名。
- 用了占位符的字段不再自动填充；两种方式可以混用（例如只写 `{{frames}}`，提示词和图片靠自动填充）。

## MiniMax H3 工作流

工作流含 `MiniMaxH3*` 节点时自动启用 H3 规则：尺寸取 32 的倍数（720p 16:9 为 1280x736），帧数对齐 17k+5（5 秒为 124 帧，15 秒为 362 帧），时长限制在 4 到 15 秒，帧率默认 24。

推荐从官方 `video_minimax_h3_r2v.json` 模板导出 API 工作流。自动填充会覆盖 H3 节点的 prompt、width、height、length，并按分镜实际绑定的图片和音色数量重建 ref_images、ref_audios 连线，所以模板里的示例图不会混进结果。参考视频需要在 LoadVideo 节点里写占位符。关闭 autoFill 可以保留工作流里写死的尺寸和帧数。

## 4. 高级选项

这些选项目前没有界面，需要直接改数据库 `ai_service_configs.settings` 的 JSON（或用 `PUT /api/v1/ai-configs/:id` 传 `settings`）：

```json
{
  "workflow": { ... },
  "negativePrompt": "blurry, low quality",
  "fps": 16,
  "width": 832, "height": 480,
  "autoFill": true,
  "randomizeSeed": true,
  "outputNode": "58",
  "uploadSubfolder": "huobao",
  "clientId": "huobao",
  "headers": { "X-Token": "..." }
}
```

- `width/height`：固定尺寸，覆盖分辨率换算
- `autoFill: false`：关闭自动填充，只认占位符
- `randomizeSeed: false`：不改 seed
- `outputNode`：多个输出节点时指定取哪一个的视频
- `headers`：附加到每个请求的头（反代鉴权等）

## 5. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 「ComfyUI 拒绝了工作流: … node_errors」 | 工作流里有节点校验失败，错误里带节点 id 和字段名；通常是模型文件名不存在或占位符填进了枚举字段 |
| 「执行完成但没有找到视频输出」 | 没有 SaveVideo / VHS_VideoCombine，或输出的是 gif/webp；把 format 改成 `video/h264-mp4` |
| 「Response is not an MP4 or WebM video」 | 输出容器不是 mp4/webm（如 mov/mkv）；改用 h264-mp4 |
| 任务一直「生成中」 | ComfyUI 排队或还在跑；后端每 10 秒查一次，最长等 50 分钟。看 ComfyUI 控制台进度 |
| 「上传素材到 ComfyUI 失败」 | Base URL 不通，或反代拦了 `/upload/image`；用设置页的「测试配置」先探 `/system_stats` |
| 「粘贴的是 ComfyUI 界面格式工作流」 | 用 Export (API) 重新导出 |

测试配置按钮会请求 `GET {Base URL}/system_stats`，返回 200 即连通。

## 6. 实现位置

- 适配器：`backend/src/services/adapters/comfyui-video.ts`
- 任务流程中的异步构建钩子：`backend/src/services/generation.ts`（`prepareGenerateRequest`）
- 配置校验与 `settings` 读写：`backend/src/routes/aiConfigs.ts`
- 设置页表单：`frontend/app/pages/settings.vue`

仓库内提供了一份可直接导入的 API 工作流：`docs/workflows/minimax_h3_r2v_api.json`。它使用 `minimax_h3_ref2va_bf16`（约 66GB）、`qwen3vl_32b_minimax_h3_nvfp4_awq` 和 fp16 视频 VAE，默认 20 步，导入前请确认服务器上有这些文件。

## 图片生成（角色、场景、道具、分镜帧）

设置 → AI 服务 → 图片 → 添加，选「ComfyUI 本地工作流」，导入 `docs/workflows/qwen_image_2_1_turbo_api.json`。这个工作流使用 Qwen-Image 2.1 Turbo（int8）、8 步，同一个工作流既能文生图，也能带参考图生图：

- 提示词和反向提示词自动写入 `TextEncodeQwenImage21`。
- 参考图按实际数量连接到 `images.image_1`、`images.image_2`……，原图直接上传，不做压缩。
- `EmptyLatentImage` 的宽高按火宝请求的尺寸写入（16 的倍数）。

Qwen-Image Edit 系列工作流（`TextEncodeQwenImageEditPlus`）也会自动识别，参考图依次接到 image1 到 image3。其他工作流按通用规则填充 CLIPTextEncode 和 LoadImage。

RTX 4090 实测：1920x1088 文生图约 64 秒，带两张参考图的 1344x768 图生图约 72 秒，包含首次加载模型的时间。生图和 H3 视频共用显卡，交替运行时会重新加载模型。

## 提速：INT8 注意力与稀疏注意力（RTX 4090 实测）

同一镜头（4 秒、1344x768、3 张参考图、同一随机种子），只计 ComfyUI 执行时间：

| 方案 | 工作流 | 耗时 |
|---|---|---|
| 原高质量（20 步） | — | 371 秒 |
| 高质量 + INT8 注意力 | — | 197 秒 |
| 高质量 + INT8 注意力 + 稀疏注意力 | `minimax_h3_r2v_quality_api.json` | 158 秒 |
| 4 步加速 LoRA + INT8 注意力 | `minimax_h3_r2v_fast_api.json` | 66 秒 |

- `ModelAttentionBackend`（comfy kitchen attention）是 INT8 量化注意力，同种子下画面几乎不变。
- `BlockSparseAttention`（sol-attn，tau 1.3）免训练，20 步时再快约 20%；对 4 步 LoRA 几乎没有提速。
- `EasyCache` 在这两种配置下没有带来提速。
- FastH3 蒸馏模型只支持文生视频和首尾帧，不支持参考生视频，火宝用不上。

## 关键帧（首尾帧）流程

漫剧流水线升级第二步：先出图挑关键帧，再让视频模型在首帧与尾帧之间补运动，避免 Ref2VA 纯参考生成时人物走样。

1. 分镜面板「关键帧」区：首帧 / 尾帧各自「生成候选」（×1–×4），候选图按 `shot_spec` 的 start_frame / end_frame、场记状态、景别拼提示词，参考图依次为：本镜首帧（生成尾帧时）或上一镜结束画面（同场生成首帧时）→ 角色定妆图 → 场景 → 道具。候选不会覆盖分镜，点选后才写入 `first_frame_image` / `last_frame_image`。
2. 工具栏「批量首帧」给所有还没首帧的分镜出候选；「批量尾帧」只给有运镜（camera_move ≠ STATIC）的分镜出候选。
3. 生成视频时分镜有首帧就自动带 `first_frame_url`（有尾帧再带 `last_frame_url`）。ComfyUI 配置的 `settings.keyframeWorkflow` 存在时改用该工作流：
   - `docs/workflows/minimax_h3_fl2va_fast_api.json`：FL2VA pruned int8 + 8 步 turbo LoRA + INT8 注意力（4090 上 5 秒镜头约 2.5 分钟）
   - `docs/workflows/minimax_h3_fl2va_quality_api.json`：FL2VA int8 20 步 + INT8 注意力 + sol-attn 稀疏注意力
   适配器会把六段式 Ref2VA 提示词转成 FL2VA/I2VA 格式（去掉 @ 引用、Subject 换成描述、锚定「从 Picture 1 开始、停在 Picture 2」）。
4. 接口：`GET/POST /storyboards/:id/keyframes`、`POST /storyboards/:id/keyframes/select`、`POST /episodes/:id/keyframes`（批量）。Wan 3.0（aliyun）首尾帧不能混用参考图，带首帧时后端自动丢弃参考图。

## 成片增强：超分 + 补帧

镜头定稿后再做的最后一步，很慢，不对草稿批量跑。

- 工作流：`docs/workflows/enhance_seedvr2_rife_api.json`。LoadVideo（`{{video}}`）→ SeedVR2 3B fp8 超分（短边 1080，batch 21，VAE 分块）→ RIFE 4.7 补帧 ×2（24→48fps）→ 原音轨重新封装。
- 配置：ComfyUI 视频配置 `settings.enhanceWorkflow`。增强任务是该分镜的一条新视频任务（`referenceMode=enhance`），完成后回写分镜视频，原片留在任务历史里。增强模式不做自动填充（SeedVR2 的 seed 上限是 2^32）。
- 入口：分镜参数区「超分补帧」按钮、工具栏「批量超分补帧」；接口 `POST /storyboards/:id/enhance`、`POST /episodes/:id/enhance`。
- 实测（RTX 4090）：4.5 秒镜头 768×1344@24 → 1080×1890@48，约 265-290 秒（含模型加载）。
- 服务器要求：SeedVR2（seedvr2_videoupscaler 节点 + `models/SEEDVR2` 下的 3B fp8 与 ema_vae）、ComfyUI-Frame-Interpolation（rife47.pth）。PyTorch cu13 环境需要把 `site-packages/nvidia/cu13/lib` 加进 `LD_LIBRARY_PATH`，否则 SeedVR2 报 `libnvrtc-builtins.so.13.0` 找不到（OneThingAI 服务器用 `/root/start_comfyui.sh` 启动）。

## T8 节点（MiniMax H3 Audio T8）

OneThingAI 服务器已装 T8 v1.104.0（commit 3a23f33，GPL-3.0，仅装在服务器上，不随本仓库分发）。只装了代码（排除 examples/tests/docs），无额外 pip 依赖。服务器连 GitHub 不稳定时，在本机 clone 后 scp 上传。T8 的人物音色 / 对白需要角色声音样本或台词录音，尚未接入火宝流程。

## 台词配音（TTS）：IndexTTS2 + Qwen3-TTS

台词驱动剧本里，只有对口型台词（`shot_spec.dialogue`）由 H3 在视频里说（用角色音色样本做 `#角色名` 参考）；`[VO]` 内心独白、`[OS]` 画外音、只配音的角色（项目 metadata `dub_only_characters`，如簿簿、线团团）的台词写进 `shot_spec.voiceover`，由 TTS 配音，拼接成片时混入。名条和 `[画面文字]`（`shot_spec.onscreen_text`）拼接时用 FFmpeg 叠加（字体：`SUBTITLE_FONT`，Windows 默认微软雅黑）。

- **节点**：[snicolast/ComfyUI-IndexTTS2](https://github.com/snicolast/ComfyUI-IndexTTS2)（IndexTTS-2，零样本克隆音色 + 情绪向量）。音色设计用 [1038lab/ComfyUI-QwenTTS](https://github.com/1038lab/ComfyUI-QwenTTS) 的 `AILab_Qwen3TTSVoiceDesign`（Qwen3-TTS-12Hz-1.7B-VoiceDesign）。两个一起装：`docs/server/install_tts.sh`（国内服务器：节点代码本机下载后 scp，模型全走 ModelScope，依赖锁住 protobuf/torch/transformers 不被改动）。2026-11-08 已在 OneThingAI A100 上跑通 IndexTTS2（首句约 86 秒，含加载模型）。
- **音色**：角色页上传的 5-15 秒参考人声（`voice_audio_url`）优先；没有的话，配音时自动设计——文本模型按角色资料和台词写一句音色描述（存 `characters.voice_prompt`，按启用的 OpenAI 兼容文本配置优先级逐个试，本地 vLLM 没开时自动落到下一个），Qwen3-TTS VoiceDesign 用它念一段该角色的台词，存为 `voice_audio_url`（`voice_audio_name`=「自动设计音色」）。H3 对口型的 `#角色名` 音色参考也用这段。同一个人的不同造型（太白金星·天庭 / 太白金星·物业）、编号群角色（线团团甲/乙/丙）共用一个音色。
- **工作流**：默认内置（LoadAudio → IndexTTS2EmotionVector → IndexTTS2Simple → IndexTTS2SaveAudio），复用分集视频配置的 ComfyUI 地址；可在视频配置 settings 里用 `ttsWorkflow` 换成自己的 API 格式工作流，占位符 `{{text}} {{audio}} {{name}}` 和 8 个情绪 `{{happy}}…{{calm}}`。表演提示（tone）按关键词换成情绪向量（`services/tts.ts emotionFromTone`）。
- **配音面板**（工作台「配音面板」）：左边每个角色的音色试听和音色描述，「换音色」= 按描述（可改）换随机种子重新设计并重做本集他的台词；右边逐句列表，可改台词/语气后「重新生成」（写回 shot_spec；IndexTTS2 没有 seed，重新生成时把 output_gain 在 0.97–1 之间微调来绕开 ComfyUI 缓存）。对口型台词改字后视频口型不会变，界面会先提醒。
- **接口**：`POST /episodes/:id/voices {force?, storyboard_ids?}` 后台按句生成，结果写进分镜 `voice_tracks`；`GET /episodes/:id/voices` 查状态；`GET /episodes/:id/line-sheet` 导出按角色分好的台词清单；`GET /episodes/:id/voice-lines` 配音面板数据；`POST /episodes/:id/voices/redesign {character_id, voice_prompt?}` 换音色（后台，状态同 GET /voices）；`POST /storyboards/:id/voices/:index {text?, tone?}` 重新生成一句。视频配置 settings 可用 `voiceDesignWorkflow` 换音色设计工作流（占位符 `{{text}} {{instruct}} {{seed}} {{name}}`）。工作台「生成配音」「台词清单」按钮对应这两个接口。
- **合成**：拼接成片时，只要有镜头带配音或画面文字，就逐镜混音（原声 0.8 + 配音，配音默认排在对口型台词说完之后）、叠字，再拼接。
