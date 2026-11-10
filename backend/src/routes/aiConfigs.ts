import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { isOfficialProvider, parseConfigSettings, parseConfigTemperature } from '../services/ai.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

/** 归一化 temperature 入参：null=未设置；合法值 0~2；非法抛错 */
function normalizeTemperature(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('invalid temperature')
  return n
}

/** API Key 不回传明文：只给前 3 位和后 4 位，防止任何能打开页面的人把 Key 拿走 */
export function maskKey(key?: string | null): string {
  if (!key) return ''
  return key.length <= 8 ? '****' : `${key.slice(0, 3)}****${key.slice(-4)}`
}
const isMasked = (v: unknown) => typeof v === 'string' && v.includes('****')

/** 把 settings JSON 中的 temperature 透出为顶层字段，便于前端直接读写；settings 本身以对象形式返回 */
function withParsedFields(r: any) {
  return {
    ...toSnakeCase(r),
    api_key: maskKey(r.apiKey),
    model: r.model ? JSON.parse(r.model) : [],
    temperature: parseConfigTemperature(r.settings),
    settings: parseConfigSettings(r.settings),
  }
}

/**
 * 合并 settings 补丁：body.settings 为对象时逐键覆盖，值为 null 的键删除。
 * temperature 单独处理（保持原有顶层字段语义）。返回 null 表示 settings 应清空。
 */
function mergeSettings(existingRaw: string | null | undefined, patch: unknown): Record<string, any> {
  const settings: Record<string, any> = parseConfigSettings(existingRaw) || {}
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === null || value === undefined) delete settings[key]
      else settings[key] = value
    }
  }
  return settings
}

/** ComfyUI 工作流必须是「导出 (API)」格式：{ "<节点id>": { class_type, inputs } } */
function validateComfyWorkflow(settings: Record<string, any>): string | null {
  let wf = settings.workflow
  if (typeof wf === 'string') {
    try { wf = JSON.parse(wf) } catch { return 'ComfyUI 工作流不是合法 JSON' }
    settings.workflow = wf
  }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return '请粘贴 ComfyUI「导出 (API)」格式的工作流 JSON'
  const hasNode = Object.values(wf).some((n: any) => n && typeof n === 'object' && typeof n.class_type === 'string')
  if (!hasNode) {
    return Array.isArray((wf as any).nodes)
      ? '粘贴的是 ComfyUI 界面格式工作流，请在 ComfyUI 开启开发者模式后使用「导出 (API)」'
      : 'ComfyUI 工作流中没有任何节点（缺少 class_type）'
  }
  return null
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
  const p = provider.toLowerCase()
  const m = model || ''

  if (p === 'gemini') {
    // 探针统一走 generateContent:文本运行时(AI SDK)走的就是它,官方与中转站都支持;
    // interactions 端点很多中转站未配置,探它会误报 500。
    // 用最小合法请求体而非空体——空体在部分中转站会触发上游认证失败的误报
    const modelName = m || 'gemini-3.1-pro-preview'
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${modelName}:generateContent`))
    if (apiKey) url.searchParams.set('key', apiKey)
    return {
      method: 'POST',
      url: url.toString(),
      headers: geminiHeaders(apiKey, true),
      body: { contents: [{ parts: [{ text: 'hi' }] }] },
    }
  }

  if (p === 'openai') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'volcengine') {
    const path = serviceType === 'video'
      ? '/contents/generations/tasks'
      : serviceType === 'text'
        ? '/chat/completions'
        : '/images/generations'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v3', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'minimax') {
    // MiniMax 仅提供视频服务，空请求体探测鉴权/端点连通性
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/v2', '/video_generation'),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'aliyun') {
    // Wan 3.0 仅支持异步提交；空请求体不会创建计费任务，仅用于验证地域端点与鉴权是否可达。
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis'),
      headers: {
        ...bearerHeaders(apiKey, true),
        'X-DashScope-Async': 'enable',
      },
      body: {},
    }
  }

  if (p === 'comfyui') {
    // ComfyUI 无鉴权时 /system_stats 直接返回设备与版本信息，用于确认地址可达
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '', '/system_stats'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', m ? `/${m}` : '/'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = await db.select().from(schema.aiServiceConfigs)
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(withParsedFields)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, '需要 service_type 与 provider')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const settings = mergeSettings(null, body.settings)
  if ('temperature' in body) {
    try {
      const temperature = normalizeTemperature(body.temperature)
      if (temperature === null) delete settings.temperature
      else settings.temperature = temperature
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
  }
  if (String(body.provider).toLowerCase() === 'comfyui') {
    const problem = validateComfyWorkflow(settings)
    if (problem) return badRequest(c, problem)
  }

  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: body.base_url || '',
    apiKey: body.api_key || '',
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    settings: Object.keys(settings).length ? JSON.stringify(settings) : null,
    createdAt: ts,
    updatedAt: ts,
  })

  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, getInsertId(res)))

  return created(c, withParsedFields(row))
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  if (!body.service_type || !body.provider || !body.base_url) {
    return badRequest(c, '需要 service_type、provider 与 base_url')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const model = Array.isArray(body.model) ? body.model[0] : body.model
  // 表单里是打码后的 Key（没改过）：换回库里同一条配置的真实 Key 再测试
  let apiKey: string | undefined = body.api_key
  if (isMasked(apiKey)) {
    const rows = await db.select().from(schema.aiServiceConfigs)
    const hit = rows.find(r => (body.id ? r.id === Number(body.id) : r.provider === body.provider && r.baseUrl === body.base_url) && maskKey(r.apiKey) === apiKey)
      || rows.find(r => maskKey(r.apiKey) === apiKey)
    apiKey = hit?.apiKey || ''
  }
  const probe = buildProbe(body.service_type, body.provider, body.base_url, model, apiKey)
  const probeUrl = redactUrl(probe.url)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType: body.service_type,
    provider: body.provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const resp = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body ? JSON.stringify(probe.body) : undefined,
    })
    const text = await resp.text()
    const reachable = [200, 204, 400, 401, 403].includes(resp.status)
    const payload = {
      ok: resp.ok,
      reachable,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      message: reachable
        ? (resp.ok ? '端点可访问，认证与路径基本正常' : '端点已响应，请根据状态码判断认证或路径是否正确')
        : '端点未按预期响应，请检查 Base URL 和代理前缀',
      response_preview: text.slice(0, 240),
    }
    if (reachable) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-failed', {
      provider: body.provider,
      url: probeUrl,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      message: error.message || '请求失败',
      response_preview: '',
    })
  }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!row) return notFound(c)
  return success(c, withParsedFields(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!existing) return notFound(c)

  const serviceType = 'service_type' in body ? body.service_type : existing.serviceType
  const provider = 'provider' in body ? body.provider : existing.provider
  if (!isOfficialProvider(serviceType, provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const updates: Record<string, any> = { updatedAt: now() }

  if ('service_type' in body) updates.serviceType = body.service_type
  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  // 打码后的 Key 原样传回 = 没改，保留库里的
  if ('api_key' in body && !isMasked(body.api_key)) updates.apiKey = body.api_key
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active
  if ('temperature' in body || 'settings' in body) {
    // 与已有 settings 合并：settings 补丁逐键覆盖（null 删除），清空的 temperature 从 JSON 中移除
    const settings = mergeSettings(existing.settings, body.settings)
    if ('temperature' in body) {
      try {
        const temperature = normalizeTemperature(body.temperature)
        if (temperature === null) delete settings.temperature
        else settings.temperature = temperature
      } catch {
        return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
      }
    }
    if (String(provider).toLowerCase() === 'comfyui') {
      const problem = validateComfyWorkflow(settings)
      if (problem) return badRequest(c, problem)
    }
    updates.settings = Object.keys(settings).length ? JSON.stringify(settings) : null
  }

  await db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = await db.select().from(schema.aiServiceProviders)
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
