/**
 * ComfyUI 工作流视频生成 Adapter
 *
 * 提交: POST {baseUrl}/prompt  { prompt: <API 格式工作流>, client_id } -> { prompt_id }
 * 轮询: GET  {baseUrl}/history/{prompt_id} -> { [prompt_id]: { status, outputs } }
 * 下载: GET  {baseUrl}/view?filename=..&subfolder=..&type=output
 * 素材: 参考图/视频/音频先 POST {baseUrl}/upload/image 上传到 ComfyUI 的 input 目录，
 *       再把返回的文件名写进 LoadImage / LoadVideo / LoadAudio 节点。
 *
 * 工作流存在 ai_service_configs.settings.workflow（ComfyUI「导出 (API)」格式 JSON）。
 *
 * 占位符（可写在任意节点输入的字符串字段里）：
 *   {{prompt}} {{negative_prompt}}
 *   {{image}} {{first_frame}} {{last_frame}} {{image_1}}…{{image_9}}
 *   {{video}} {{video_1}}…  {{audio}} {{audio_1}}…
 *   {{width}} {{height}} {{duration}} {{fps}} {{frames}} {{seed}} {{model}} {{aspect_ratio}} {{resolution}}
 * 整个字段恰好是一个占位符时按原类型写入（数字保持数字）；嵌在长文本中时做字符串替换。
 *
 * 没写占位符时的自动填充（settings.autoFill=false 可关闭）：
 *   - 正/负向提示词：按采样器 positive/negative 输入反查 CLIPTextEncode，查不到再按节点标题含 negative/负向 判断
 *   - LoadImage：按节点 id 顺序依次填 首帧(或 image / 第 1 张参考图)、尾帧、其余参考图
 *   - LoadVideo / LoadAudio：填第 1 个参考视频 / 音频
 *   - seed / noise_seed：每次随机（record.seed 优先；settings.randomizeSeed=false 关闭）
 *
 * MiniMax H3 工作流（含 MiniMaxH3* 节点时自动识别）：尺寸取 32 的倍数，帧数落在 17k+5（4-15 秒），fps 默认 24；
 * 自动填充直接写 H3 节点的 prompt/width/height/length，并按实际素材数连接 ref_images / ref_audios / first_frame / last_frame。
 *
 * settings 可选项：negativePrompt、fps(默认 16)、width/height(覆盖分辨率换算)、autoFill、randomizeSeed、
 *   clientId、headers(附加请求头)、outputNode(指定取结果的节点 id)、uploadSubfolder(默认 huobao)
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { getAbsolutePath, parseDataUrl } from '../../utils/storage.js'

export type WorkflowNode = { class_type?: string; inputs?: Record<string, any>; _meta?: { title?: string } }
export type Workflow = Record<string, WorkflowNode>
export type MediaKind = 'image' | 'video' | 'audio'

interface ComfySettings {
  workflow?: Workflow | string
  negativePrompt?: string
  fps?: number
  width?: number
  height?: number
  autoFill?: boolean
  randomizeSeed?: boolean
  clientId?: string
  headers?: Record<string, string>
  outputNode?: string
  uploadSubfolder?: string
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g
const EXACT_PLACEHOLDER_RE = /^\{\{\s*([a-zA-Z_][\w]*)\s*\}\}$/
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v'])
const MIME_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
}

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

/** 项目内部分辨率档位 + 画幅比例 → 像素尺寸（16 的倍数） */
export function resolveDimensions(resolution?: string | null, aspectRatio?: string | null, multiple = 16): { width: number; height: number } {
  const round16 = (n: number) => Math.max(multiple, Math.round(n / multiple) * multiple)
  const r = String(resolution || '').toLowerCase()
  const tier = r === '480p' ? 480 : r === '1080p' || r === '2k' ? 1080 : 720
  const m = String(aspectRatio || '16:9').match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/)
  const rw = m ? Number(m[1]) : 16
  const rh = m ? Number(m[2]) : 9
  if (!rw || !rh) return { width: round16(tier * 16 / 9), height: tier }
  if (rw >= rh) return { width: round16(tier * rw / rh), height: round16(tier) }
  return { width: round16(tier), height: round16(tier * rh / rw) }
}

/** 时长(秒)×fps → 4n+1 帧（Wan / Hunyuan 等视频模型的常见约束） */
export function framesFor(duration: number, fps: number): number {
  const raw = Math.max(1, Math.round(duration * fps))
  return Math.floor((raw - 1) / 4) * 4 + 1
}

/** MiniMax H3：时长限制 4-15 秒，帧数向上对齐 17k+5（5 秒@24fps → 124 帧） */
export function miniMaxH3FramesFor(duration: number, fps: number): number {
  const seconds = Math.min(15, Math.max(4, duration))
  let frames = Math.max(5, Math.round(seconds * fps))
  while (frames % 17 !== 5) frames++
  return frames
}

/**
 * 本地 H3 只认 <d>…</d> 里的字是要说出来的台词（<d> 是文本编码器的专用 token），
 * 工作台的写法是「说：「台词」」「旁白：「台词」」，不转换的话模型只知道有人在说话，会自己编出含糊的声音。
 * 只转换紧跟在说话动词/旁白后面的引号，屏幕上的字（如「营业中」）不动；已经写了 <d> 的提示词原样保留。
 */
const SPEECH_QUOTE_RE = /((?:(?:说|道|问|喊|叫|答|吼|念|喝|令|嚷|骂|叹|唤|应|嘟囔|低语|喃喃|嘀咕|开口|旁白|独白|画外音|内心OS|OS|VO)[^「“"\n<>]{0,6}?[：:，,]?|[：:])\s*)[「“"]([^」”"\n<>]+)[」”"]/g
export function toMiniMaxH3Dialogue(prompt: string): string {
  if (/<d>/.test(prompt)) return prompt
  return prompt.replace(SPEECH_QUOTE_RE, (_m, lead: string, line: string) =>
    `${lead}<d>[${/[一-鿿]/.test(line) ? 'Chinese' : 'English'}] ${line.trim()}</d>`)
}

/** 工作台按云端 API 写法输出 @图片1、音色参考音频1；本地 H3 文本编码器使用 <Picture i> / <Audio j> 标签 */
export function toMiniMaxH3Tags(prompt: string): string {
  return toMiniMaxH3Dialogue(prompt)
    .replace(/@图片(\d+)\s*/g, '<Picture $1> ')
    .replace(/音色参考音频(\d+)/g, '<Audio $1>')
}

const isH3Node = (node: WorkflowNode) => /MiniMaxH3/.test(node.class_type || '')

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  /** 接口要求的同步方法；ComfyUI 需要先上传素材，实际走 prepareGenerateRequest */
  buildGenerateRequest(): ProviderRequest {
    throw new Error('ComfyUI 适配器需要异步准备素材，请通过 prepareGenerateRequest 构建请求')
  }

  async prepareGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const settings = this.settingsOf(config)
    const workflow = this.loadWorkflow(settings)
    const autoFill = settings.autoFill !== false

    const negativePrompt = (settings.negativePrompt || '').trim()
    const h3 = Object.values(workflow).some(isH3Node)
    const rawPrompt = (record.prompt || '').trim()
    const prompt = h3 ? toMiniMaxH3Tags(rawPrompt) : rawPrompt
    const fps = Number(settings.fps) > 0 ? Number(settings.fps) : (h3 ? 24 : 16)
    const duration = Number(record.duration) > 0 ? Number(record.duration) : 5
    const dims = resolveDimensions(record.resolution, record.aspectRatio, h3 ? 32 : 16)
    let width = Number(settings.width) > 0 ? Number(settings.width) : dims.width
    let height = Number(settings.height) > 0 ? Number(settings.height) : dims.height
    // 配置里的固定宽高只定尺寸档位，横竖跟随项目画幅（竖屏剧 1344x768 → 768x1344）
    if ((dims.height > dims.width) !== (height > width) && width !== height) [width, height] = [height, width]
    const seed = record.seed != null && Number.isFinite(Number(record.seed))
      ? Number(record.seed)
      : Math.floor(Math.random() * 2 ** 48)

    // 素材候选：主图 = 首帧 > imageUrl > 第 1 张参考图
    const refImages = parseUrlArray(record.referenceImageUrls)
    const firstFrame = (record.firstFrameUrl || record.imageUrl || '').trim() || refImages[0] || ''
    const lastFrame = (record.lastFrameUrl || '').trim()
    const images = dedupe([firstFrame, ...refImages].filter(Boolean))
    const videos = parseUrlArray(record.referenceVideoUrls)
    const audios = parseUrlArray(record.referenceAudioUrls)

    // 第一遍：收集工作流里用到的占位符，决定需要上传哪些素材
    const used = collectPlaceholders(workflow)
    const uploads = new Map<string, string>() // 原始地址 → ComfyUI input 文件名
    const upload = async (value: string, kind: MediaKind) => {
      if (!value) return ''
      if (!uploads.has(value)) uploads.set(value, await this.uploadMedia(config, settings, value, kind))
      return uploads.get(value)!
    }

    const frames = h3 ? miniMaxH3FramesFor(duration, fps) : framesFor(duration, fps)
    const vars: Record<string, string | number> = {
      prompt,
      negative_prompt: negativePrompt,
      width,
      height,
      duration,
      fps,
      frames,
      seed,
      model: record.model || config.model || '',
      aspect_ratio: record.aspectRatio || '16:9',
      resolution: record.resolution || '720p',
    }

    const requireMedia = async (name: string, value: string, kind: MediaKind, label: string) => {
      if (!used.has(name)) return
      if (!value) throw new Error(`工作流使用了 {{${name}}}，但本次任务没有${label}`)
      vars[name] = await upload(value, kind)
    }
    await requireMedia('image', firstFrame, 'image', '可用的参考图/首帧')
    await requireMedia('first_frame', firstFrame, 'image', '首帧图')
    await requireMedia('last_frame', lastFrame, 'image', '尾帧图')
    await requireMedia('video', videos[0] || '', 'video', '参考视频')
    await requireMedia('audio', audios[0] || '', 'audio', '参考音频')
    for (const name of used) {
      const m = name.match(/^(image|video|audio)_(\d+)$/)
      if (!m) continue
      const kind = m[1] as MediaKind
      const idx = Number(m[2]) - 1
      const list = kind === 'image' ? images : kind === 'video' ? videos : audios
      const label = kind === 'image' ? '参考图' : kind === 'video' ? '参考视频' : '参考音频'
      if (!list[idx]) throw new Error(`工作流使用了 {{${name}}}，但本次任务只有 ${list.length} 个${label}`)
      vars[name] = await upload(list[idx], kind)
    }

    // 第二遍：替换占位符
    substitutePlaceholders(workflow, vars)

    // 第三遍：没写占位符的字段自动填充
    if (autoFill) {
      const mediaUsed = (kind: MediaKind) => [...used].some((n) =>
        n === kind || n.startsWith(`${kind}_`) || (kind === 'image' && (n === 'first_frame' || n === 'last_frame')))

      // H3 节点：字段直接写值，覆盖模板里接到 Primitive / 数学表达式节点的连线（断开后的节点不会被执行）
      let h3HasPrompt = false
      let h3WiredMedia = false
      for (const id of Object.keys(workflow)) {
        const node = workflow[id]
        if (!isH3Node(node) || !node.inputs) continue
        if ('width' in node.inputs && 'height' in node.inputs) {
          node.inputs.width = width
          node.inputs.height = height
        }
        if ('length' in node.inputs) node.inputs.length = frames
        if ('prompt' in node.inputs) {
          h3HasPrompt = true
          if (!used.has('prompt') && prompt) node.inputs.prompt = prompt
        }
        const type = node.class_type || ''
        if (type === 'MiniMaxH3ReferenceToVideo') {
          h3WiredMedia = true
          if (!mediaUsed('image')) {
            const names = await Promise.all(images.map((u) => upload(u, 'image')))
            wireAutogrow(workflow, id, 'ref_images.ref_image_', 'LoadImage', 'image', names)
          }
          if (!mediaUsed('audio')) {
            const names = await Promise.all(audios.map((u) => upload(u, 'audio')))
            wireAutogrow(workflow, id, 'ref_audios.ref_audio_', 'LoadAudio', 'audio', names)
          }
          if (videos.length && !mediaUsed('video')) {
            throw new Error('MiniMax H3 工作流收到参考视频：请在工作流的 LoadVideo 节点中写 {{video}} / {{video_1}} 占位符')
          }
        } else if (type === 'MiniMaxH3ImageToVideo') {
          h3WiredMedia = true
          if (!mediaUsed('image')) {
            wireOptionalImage(workflow, id, 'first_frame', firstFrame ? await upload(firstFrame, 'image') : '')
            wireOptionalImage(workflow, id, 'last_frame', lastFrame ? await upload(lastFrame, 'image') : '')
          }
        }
      }

      if ((!used.has('prompt') && !h3HasPrompt) || (!used.has('negative_prompt') && negativePrompt)) {
        const { positive, negative } = findTextEncodeNodes(workflow)
        if (!used.has('prompt') && !h3HasPrompt && prompt && positive) workflow[positive].inputs!.text = prompt
        if (!used.has('negative_prompt') && negativePrompt && negative) workflow[negative].inputs!.text = negativePrompt
      }

      if (!h3WiredMedia && !mediaUsed('image') && images.length) {
        const loaders = findLoaderNodes(workflow, 'image')
        // 顺序：首帧/主图 → 尾帧 → 其余参考图；标题含 last/end/尾 的节点优先拿尾帧
        const rest = images.filter((u) => u !== firstFrame)
        const queue = lastFrame ? [firstFrame, lastFrame, ...rest] : [firstFrame, ...rest]
        const lastNode = lastFrame ? loaders.find((id) => /last|end|尾/i.test(workflow[id]._meta?.title || '')) : undefined
        if (lastNode) {
          workflow[lastNode].inputs!.image = await upload(lastFrame, 'image')
          queue.splice(queue.indexOf(lastFrame), 1)
        }
        for (const id of loaders) {
          if (id === lastNode) continue
          const value = queue.shift()
          if (!value) break
          workflow[id].inputs!.image = await upload(value, 'image')
        }
      }
      if (!mediaUsed('video') && videos[0]) {
        for (const id of findLoaderNodes(workflow, 'video').slice(0, 1)) workflow[id].inputs!.video = await upload(videos[0], 'video')
      }
      if (!h3WiredMedia && !mediaUsed('audio') && audios[0]) {
        for (const id of findLoaderNodes(workflow, 'audio').slice(0, 1)) workflow[id].inputs!.audio = await upload(audios[0], 'audio')
      }
      if (!used.has('seed') && settings.randomizeSeed !== false) {
        for (const node of Object.values(workflow)) {
          for (const key of ['seed', 'noise_seed']) {
            if (typeof node.inputs?.[key] === 'number') node.inputs[key] = seed
          }
        }
      }
    }

    return {
      url: joinProviderUrl(config.baseUrl, '', '/prompt'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders(config, settings) },
      body: {
        prompt: workflow,
        client_id: settings.clientId || `huobao-drama-${record.id}`,
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result?.error) {
      const nodeErrors = result.node_errors && typeof result.node_errors === 'object'
        ? Object.entries(result.node_errors).map(([id, e]: [string, any]) => {
          const msgs = Array.isArray(e?.errors) ? e.errors.map((x: any) => x?.message || x?.details || JSON.stringify(x)).join('; ') : ''
          return `节点 ${id}${e?.class_type ? `(${e.class_type})` : ''}: ${msgs}`
        }).join(' | ')
        : ''
      const msg = typeof result.error === 'string' ? result.error : (result.error.message || JSON.stringify(result.error))
      throw new Error(`ComfyUI 拒绝了工作流: ${msg}${nodeErrors ? ` — ${nodeErrors}` : ''}`)
    }
    if (result?.prompt_id) return { isAsync: true, taskId: String(result.prompt_id) }
    throw new Error('ComfyUI 响应中没有 prompt_id')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '', `/history/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: this.authHeaders(config, this.settingsOf(config)),
      body: undefined,
    }
  }

  parsePollResponse(result: any, config?: AIConfig): VideoPollResponse {
    // /history/{id} 完成前返回 {}（排队或执行中）
    const entry: any = result && typeof result === 'object' ? Object.values(result)[0] : null
    if (!entry || typeof entry !== 'object') return { status: 'processing' }

    const status = entry.status || {}
    if (status.status_str === 'error') {
      return { status: 'failed', error: describeExecutionError(status.messages) }
    }
    const done = status.completed === true || status.status_str === 'success'
      || (!entry.status && entry.outputs && Object.keys(entry.outputs).length > 0)
    if (!done) return { status: 'processing' }

    const videoUrl = config ? this.extractVideoUrl(result, config) : null
    if (!videoUrl) {
      return {
        status: 'failed',
        error: 'ComfyUI 执行完成但没有找到视频输出：请确认工作流包含 SaveVideo / VHS_VideoCombine 等节点，且输出 mp4 或 webm',
      }
    }
    return { status: 'completed', videoUrl }
  }

  extractVideoUrl(result: any, config?: AIConfig): string | null {
    if (!config) return null
    const entry: any = result && typeof result === 'object' ? Object.values(result)[0] : null
    const outputs: Record<string, any> = entry?.outputs || {}
    const settings = this.settingsOf(config)
    const nodeIds = Object.keys(outputs)
    if (settings.outputNode && outputs[settings.outputNode]) {
      nodeIds.sort((a, b) => (a === settings.outputNode ? -1 : b === settings.outputNode ? 1 : 0))
    }

    const candidates: { filename: string; subfolder?: string; type?: string; score: number }[] = []
    for (const id of nodeIds) {
      const out = outputs[id] || {}
      for (const key of ['videos', 'gifs', 'images', 'audio', 'files']) {
        const items = Array.isArray(out[key]) ? out[key] : []
        for (const item of items) {
          if (!item?.filename) continue
          const ext = path.extname(String(item.filename)).toLowerCase()
          const isVideoExt = VIDEO_EXTS.has(ext)
          const isVideoFormat = typeof item.format === 'string' && item.format.startsWith('video/')
          if (!isVideoExt && !isVideoFormat) continue
          // mp4/webm 可直接落盘；其他容器放后面兜底
          const score = (ext === '.mp4' || ext === '.webm' ? 10 : 1) + (item.type === 'output' ? 1 : 0)
          candidates.push({ filename: item.filename, subfolder: item.subfolder, type: item.type, score })
        }
      }
      if (candidates.length) break
    }
    if (!candidates.length) return null
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]
    const url = new URL(joinProviderUrl(config.baseUrl, '', '/view'))
    url.searchParams.set('filename', best.filename)
    url.searchParams.set('subfolder', best.subfolder || '')
    url.searchParams.set('type', best.type || 'output')
    return url.toString()
  }

  // ─── 内部工具 ──────────────────────────────────────────────

  settingsOf(config: AIConfig): ComfySettings {
    const s = config.settings
    if (!s) return {}
    if (typeof s === 'string') {
      try { return JSON.parse(s) || {} } catch { return {} }
    }
    return s as ComfySettings
  }

  loadWorkflow(settings: ComfySettings): Workflow {
    let wf: any = settings.workflow
    if (typeof wf === 'string') {
      try { wf = JSON.parse(wf) } catch { throw new Error('ComfyUI 工作流不是合法 JSON，请在设置页重新粘贴「导出 (API)」格式的工作流') }
    }
    if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
      throw new Error('未配置 ComfyUI 工作流：请在「设置」对应服务的 ComfyUI 配置中粘贴 API 格式工作流 JSON')
    }
    const hasNode = Object.values(wf).some((n: any) => n && typeof n === 'object' && typeof n.class_type === 'string')
    if (!hasNode) {
      // 常见误操作：粘贴了界面格式（含 nodes/links 数组）
      if (Array.isArray(wf.nodes)) throw new Error('粘贴的是 ComfyUI 界面格式工作流，请在 ComfyUI 中开启开发者模式后用「导出 (API)」导出')
      throw new Error('ComfyUI 工作流中没有任何节点（缺少 class_type）')
    }
    return JSON.parse(JSON.stringify(wf)) as Workflow
  }

  authHeaders(config: AIConfig, settings: ComfySettings): Record<string, string> {
    const headers: Record<string, string> = {}
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    if (settings.headers && typeof settings.headers === 'object') {
      for (const [k, v] of Object.entries(settings.headers)) if (typeof v === 'string') headers[k] = v
    }
    return headers
  }

  /** 把 data URL / 本地 static 路径 / 远程 URL 上传到 ComfyUI input 目录，返回 LoadImage 可用的文件名 */
  async uploadMedia(config: AIConfig, settings: ComfySettings, value: string, kind: MediaKind): Promise<string> {
    const { bytes, ext } = await readMedia(value, kind)
    const name = `huobao-${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}${ext}`
    const subfolder = settings.uploadSubfolder ?? 'huobao'

    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(bytes)]), name)
    form.append('overwrite', 'true')
    if (subfolder) form.append('subfolder', subfolder)

    const resp = await fetch(joinProviderUrl(config.baseUrl, '', '/upload/image'), {
      method: 'POST',
      headers: this.authHeaders(config, settings),
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    if (!resp.ok) throw new Error(`上传素材到 ComfyUI 失败: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`)
    const data: any = await resp.json().catch(() => ({}))
    const savedName = data?.name || name
    const savedSub = typeof data?.subfolder === 'string' ? data.subfolder : subfolder
    return savedSub ? `${savedSub}/${savedName}` : savedName
  }
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list))
}

async function readMedia(value: string, kind: MediaKind): Promise<{ bytes: Buffer; ext: string }> {
  const raw = value.trim()
  if (raw.startsWith('data:')) {
    const parsed = parseDataUrl(raw)
    if (!parsed) throw new Error('无法解析素材 data URL')
    return { bytes: Buffer.from(parsed.data, 'base64'), ext: MIME_EXT[parsed.mimeType] || defaultExt(kind) }
  }
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const rel = raw.startsWith('/') ? raw.slice(1) : raw
    const abs = getAbsolutePath(rel)
    if (!fs.existsSync(abs)) throw new Error(`本地素材不存在: ${rel}`)
    return { bytes: fs.readFileSync(abs), ext: path.extname(abs).toLowerCase() || defaultExt(kind) }
  }
  if (/^https?:\/\//.test(raw)) {
    const resp = await fetch(raw, { signal: AbortSignal.timeout(60_000) })
    if (!resp.ok) throw new Error(`下载素材失败: HTTP ${resp.status}`)
    const type = (resp.headers.get('content-type') || '').split(';')[0].trim()
    let ext = ''
    try { ext = path.extname(new URL(raw).pathname).toLowerCase() } catch {}
    return { bytes: Buffer.from(await resp.arrayBuffer()), ext: ext || MIME_EXT[type] || defaultExt(kind) }
  }
  throw new Error(`不支持的素材地址: ${raw.slice(0, 80)}`)
}

function defaultExt(kind: MediaKind) {
  return kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.wav'
}

export function collectPlaceholders(workflow: Workflow): Set<string> {
  const used = new Set<string>()
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node.inputs || {})) {
      if (typeof value !== 'string') continue
      for (const m of value.matchAll(PLACEHOLDER_RE)) used.add(m[1])
    }
  }
  return used
}

export function substitutePlaceholders(workflow: Workflow, vars: Record<string, string | number>) {
  for (const node of Object.values(workflow)) {
    if (!node.inputs) continue
    for (const [key, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'string') continue
      const exact = value.match(EXACT_PLACEHOLDER_RE)
      if (exact) {
        if (exact[1] in vars) node.inputs[key] = vars[exact[1]]
        continue
      }
      node.inputs[key] = value.replace(PLACEHOLDER_RE, (_m, name: string) => (name in vars ? String(vars[name]) : ''))
    }
  }
}

/** 正/负向 CLIPTextEncode：优先按采样器 positive/negative 连线反查，其次按标题判断 */
export function findTextEncodeNodes(workflow: Workflow): { positive?: string; negative?: string } {
  const isText = (id?: string) => !!id && /TextEncode/i.test(workflow[id]?.class_type || '') && typeof workflow[id]?.inputs?.text === 'string'
  const linkTarget = (v: any) => (Array.isArray(v) && typeof v[0] !== 'undefined' ? String(v[0]) : undefined)
  let positive: string | undefined
  let negative: string | undefined
  for (const node of Object.values(workflow)) {
    const p = linkTarget(node.inputs?.positive)
    const n = linkTarget(node.inputs?.negative)
    if (!positive && isText(p)) positive = p
    if (!negative && isText(n)) negative = n
  }
  if (!positive || !negative) {
    const textNodes = Object.keys(workflow).filter((id) => isText(id)).sort((a, b) => Number(a) - Number(b))
    const byTitle = (re: RegExp) => textNodes.find((id) => re.test(workflow[id]._meta?.title || ''))
    if (!negative) negative = byTitle(/negative|负面|负向|反向/i)
    if (!positive) positive = byTitle(/positive|正面|正向/i) || textNodes.find((id) => id !== negative)
  }
  return { positive, negative }
}

export function findLoaderNodes(workflow: Workflow, kind: MediaKind): string[] {
  const classRe = kind === 'image' ? /LoadImage(?!Mask)/ : kind === 'video' ? /LoadVideo/i : /LoadAudio/i
  return Object.keys(workflow)
    .filter((id) => classRe.test(workflow[id].class_type || '') && typeof workflow[id].inputs?.[kind] === 'string')
    .sort((a, b) => Number(a) - Number(b))
}

/** 按实际素材数重建 Autogrow 输入（如 ref_images.ref_image_0…），每个素材一个新的加载节点；start 为第一个编号（Qwen-Image 2.1 从 1 开始） */
export function wireAutogrow(workflow: Workflow, nodeId: string, prefix: string, loader: string, field: string, names: string[], start = 0) {
  const inputs = workflow[nodeId].inputs!
  for (const key of Object.keys(inputs)) if (key.startsWith(prefix)) delete inputs[key]
  names.forEach((name, i) => {
    const loaderId = `huobao_${nodeId}_${field}_${i}`.replace(/:/g, '_')
    workflow[loaderId] = { class_type: loader, inputs: { [field]: name } }
    inputs[`${prefix}${i + start}`] = [loaderId, 0]
  })
}

export function wireOptionalImage(workflow: Workflow, nodeId: string, key: string, name: string) {
  const inputs = workflow[nodeId].inputs!
  delete inputs[key]
  if (!name) return
  const loaderId = `huobao_${nodeId}_${key}`.replace(/:/g, '_')
  workflow[loaderId] = { class_type: 'LoadImage', inputs: { image: name } }
  inputs[key] = [loaderId, 0]
}

export function describeExecutionError(messages: any): string {
  if (!Array.isArray(messages)) return 'ComfyUI 执行失败'
  for (const entry of messages) {
    if (!Array.isArray(entry) || entry[0] !== 'execution_error') continue
    const d = entry[1] || {}
    const where = d.node_type ? `${d.node_type}${d.node_id ? `#${d.node_id}` : ''}: ` : ''
    const msg = d.exception_message || d.exception_type || 'unknown error'
    return `ComfyUI 执行失败 — ${where}${String(msg).slice(0, 400)}`
  }
  const interrupted = messages.some((e: any) => Array.isArray(e) && e[0] === 'execution_interrupted')
  return interrupted ? 'ComfyUI 任务被中断' : 'ComfyUI 执行失败'
}
