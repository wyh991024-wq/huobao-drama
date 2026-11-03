/**
 * ComfyUI 工作流图片生成 Adapter（角色、场景、道具、分镜帧）
 *
 * 与视频适配器共用提交、上传、轮询逻辑：POST /prompt → GET /history/{id} → GET /view。
 * 工作流存在 ai_service_configs.settings.workflow（「导出 (API)」格式）。
 *
 * 占位符：{{prompt}} {{negative_prompt}} {{width}} {{height}} {{seed}} {{model}} {{image}} {{image_1}}…
 *
 * 没写占位符时的自动填充（settings.autoFill=false 可关闭）：
 *   - Qwen-Image 2.1（TextEncodeQwenImage21）：写 prompt / negative_prompt，按参考图数量重建 images.image_N 连线
 *   - Qwen-Image Edit（TextEncodeQwenImageEditPlus）：写 prompt，参考图依次接到 image1~image3
 *   - 其他工作流：正/负向 CLIPTextEncode 写提示词，LoadImage 按顺序填参考图
 *   - Empty*Latent* 节点的 width / height 按请求尺寸写入（16 的倍数）
 *   - seed / noise_seed 每次随机
 */
import path from 'node:path'
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'
import {
  ComfyUIVideoAdapter,
  collectPlaceholders,
  substitutePlaceholders,
  findTextEncodeNodes,
  findLoaderNodes,
  wireAutogrow,
  wireOptionalImage,
  describeExecutionError,
} from './comfyui-video'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function parseRefs(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? Array.from(new Set(arr.filter((u) => typeof u === 'string' && u.trim()))) : []
  } catch {
    return []
  }
}

/** "1920x1080" → 16 的倍数的宽高；解析失败回退 1024x1024 */
export function parseImageSize(size?: string | null): { width: number; height: number } {
  const m = String(size || '').match(/^(\d+)\s*[x×*]\s*(\d+)$/i)
  const round16 = (n: number) => Math.max(256, Math.round(n / 16) * 16)
  if (!m) return { width: 1024, height: 1024 }
  return { width: round16(Number(m[1])), height: round16(Number(m[2])) }
}

export class ComfyUIImageAdapter implements ImageProviderAdapter {
  provider = 'comfyui'
  private core = new ComfyUIVideoAdapter()

  buildGenerateRequest(): ProviderRequest {
    throw new Error('ComfyUI 适配器需要异步准备素材，请通过 prepareGenerateRequest 构建请求')
  }

  async prepareGenerateRequest(config: AIConfig, record: ImageGenerationRecord): Promise<ProviderRequest> {
    const settings = this.core.settingsOf(config)
    const workflow = this.core.loadWorkflow(settings)
    const autoFill = settings.autoFill !== false

    const prompt = (record.prompt || '').trim()
    const negativePrompt = (settings.negativePrompt || '').trim()
    const dims = parseImageSize(record.size)
    const width = Number(settings.width) > 0 ? Number(settings.width) : dims.width
    const height = Number(settings.height) > 0 ? Number(settings.height) : dims.height
    const seed = Math.floor(Math.random() * 2 ** 48)
    const refs = parseRefs(record.referenceImages)

    const uploads = new Map<string, string>()
    const upload = async (value: string) => {
      if (!uploads.has(value)) uploads.set(value, await this.core.uploadMedia(config, settings, value, 'image'))
      return uploads.get(value)!
    }

    const used = collectPlaceholders(workflow)
    const vars: Record<string, string | number> = {
      prompt, negative_prompt: negativePrompt, width, height, seed, model: record.model || config.model || '',
    }
    if (used.has('image')) {
      if (!refs[0]) throw new Error('工作流使用了 {{image}}，但本次任务没有参考图')
      vars.image = await upload(refs[0])
    }
    for (const name of used) {
      const m = name.match(/^image_(\d+)$/)
      if (!m) continue
      const ref = refs[Number(m[1]) - 1]
      if (!ref) throw new Error(`工作流使用了 {{${name}}}，但本次任务只有 ${refs.length} 张参考图`)
      vars[name] = await upload(ref)
    }
    substitutePlaceholders(workflow, vars)

    if (autoFill) {
      const imagesByPlaceholder = [...used].some((n) => n === 'image' || /^image_\d+$/.test(n))
      let promptHandled = used.has('prompt')
      let imagesHandled = imagesByPlaceholder

      for (const id of Object.keys(workflow)) {
        const node = workflow[id]
        const type = node.class_type || ''
        if (!node.inputs) continue
        if (type === 'TextEncodeQwenImage21') {
          if (!used.has('prompt') && prompt) node.inputs.prompt = prompt
          if (!used.has('negative_prompt') && 'negative_prompt' in node.inputs) node.inputs.negative_prompt = negativePrompt
          promptHandled = true
          if (!imagesByPlaceholder) {
            const names = await Promise.all(refs.slice(0, 16).map(upload))
            wireAutogrow(workflow, id, 'images.image_', 'LoadImage', 'image', names, 1)
            imagesHandled = true
          }
        } else if (/^TextEncodeQwenImageEdit/.test(type)) {
          if (!used.has('prompt') && prompt && typeof node.inputs.prompt === 'string') node.inputs.prompt = prompt
          promptHandled = true
          if (!imagesByPlaceholder) {
            for (let i = 1; i <= 3; i++) {
              wireOptionalImage(workflow, id, `image${i}`, refs[i - 1] ? await upload(refs[i - 1]) : '')
            }
            imagesHandled = true
          }
        }
        if (/^Empty.*Latent/i.test(type) && typeof node.inputs.width === 'number' && typeof node.inputs.height === 'number') {
          if (!used.has('width')) node.inputs.width = width
          if (!used.has('height')) node.inputs.height = height
        }
      }

      if (!promptHandled || (!used.has('negative_prompt') && negativePrompt)) {
        const { positive, negative } = findTextEncodeNodes(workflow)
        if (!promptHandled && prompt && positive) workflow[positive].inputs!.text = prompt
        if (!used.has('negative_prompt') && negativePrompt && negative) workflow[negative].inputs!.text = negativePrompt
      }

      if (!imagesHandled && refs.length) {
        const loaders = findLoaderNodes(workflow, 'image')
        for (let i = 0; i < loaders.length && i < refs.length; i++) {
          workflow[loaders[i]].inputs!.image = await upload(refs[i])
        }
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
      headers: { 'Content-Type': 'application/json', ...this.core.authHeaders(config, settings) },
      body: { prompt: workflow, client_id: settings.clientId || `huobao-drama-image-${record.id}` },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const { isAsync, taskId } = this.core.parseGenerateResponse(result)
    return { isAsync, taskId }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return this.core.buildPollRequest(config, taskId)
  }

  parsePollResponse(result: any, config?: AIConfig): ImagePollResponse {
    const entry: any = result && typeof result === 'object' ? Object.values(result)[0] : null
    if (!entry || typeof entry !== 'object') return { status: 'processing' }
    const status = entry.status || {}
    if (status.status_str === 'error') return { status: 'failed', error: describeExecutionError(status.messages) }
    const done = status.completed === true || status.status_str === 'success'
      || (!entry.status && entry.outputs && Object.keys(entry.outputs).length > 0)
    if (!done) return { status: 'processing' }
    const imageUrl = this.extractImageUrl(result, config)
    if (!imageUrl) {
      return { status: 'failed', error: 'ComfyUI 执行完成但没有找到图片输出：请确认工作流包含 SaveImage 节点，且输出 png / jpg / webp' }
    }
    return { status: 'completed', imageUrl }
  }

  extractImageUrl(result: any, config?: AIConfig): string | null {
    if (!config) return null
    const entry: any = result && typeof result === 'object' ? Object.values(result)[0] : null
    const outputs: Record<string, any> = entry?.outputs || {}
    const settings = this.core.settingsOf(config)
    const candidates: { filename: string; subfolder?: string; type?: string; score: number }[] = []
    for (const [id, out] of Object.entries<any>(outputs)) {
      for (const item of Array.isArray(out?.images) ? out.images : []) {
        if (!item?.filename || !IMAGE_EXTS.has(path.extname(String(item.filename)).toLowerCase())) continue
        // 指定输出节点优先；SaveImage（type=output）优先于 PreviewImage（type=temp）
        const score = (id === settings.outputNode ? 100 : 0) + (item.type === 'output' ? 10 : 0)
        candidates.push({ filename: item.filename, subfolder: item.subfolder, type: item.type, score })
      }
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

  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }
}
