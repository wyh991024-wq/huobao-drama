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
