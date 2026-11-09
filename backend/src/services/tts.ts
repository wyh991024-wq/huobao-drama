/**
 * 台词配音（TTS）：每个角色固定一个音色，按句生成配音音频，存进分镜的 voice_tracks
 *
 * - 音色：角色的 voice_audio_url（5-15 秒参考人声）。同一个人不同造型（太白金星·天庭 / 太白金星·物业）共用一个音色，
 *   「线团团甲/乙」这类编号群角色用「线团团」的音色
 * - 引擎：ComfyUI 上的 IndexTTS2（snicolast/ComfyUI-IndexTTS2，见 docs/comfyui.md），复用视频配置的 ComfyUI 地址；
 *   视频配置 settings.ttsWorkflow 可以换成自己的 API 格式工作流，占位符 {{text}} {{audio}} {{name}}
 *   以及情绪向量 {{happy}} {{angry}} {{sad}} {{afraid}} {{disgusted}} {{melancholic}} {{surprised}} {{calm}}
 * - 对口型台词（shot_spec.dialogue）也生成：用于台词清单试听，以及以后用音频驱动 H3 对口型
 * - 角色没有音色时自动设计：文本模型按角色资料和台词写音色描述（characters.voice_prompt），
 *   ComfyUI 上的 Qwen3-TTS VoiceDesign（1038lab/ComfyUI-QwenTTS）用它念一段本角色台词当参考人声；
 *   视频配置 settings.voiceDesignWorkflow 可替换，占位符 {{text}} {{instruct}} {{seed}} {{name}}
 */
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { getAbsolutePath } from '../utils/storage.js'
import { joinProviderUrl } from './adapters/url.js'
import { collectPlaceholders, substitutePlaceholders, describeExecutionError, type Workflow } from './adapters/comfyui-video.js'
import { parseShotSpec } from './director.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export interface VoiceTrack {
  /** LIP=对口型，VO=内心独白/旁白，OS=画外音，DUB=只配音的角色 */
  kind: 'LIP' | 'VO' | 'OS' | 'DUB' | string
  speaker: string
  character_id: number | null
  text: string
  tone?: string
  /** static/tts/... 生成后才有 */
  url?: string
  /** 音频秒数 */
  seconds?: number
  /** 在本镜里开始的秒数（合成成片时用）；不填按顺序自动排 */
  at?: number
  error?: string
}

const EMOTIONS = ['happy', 'angry', 'sad', 'afraid', 'disgusted', 'melancholic', 'surprised', 'calm'] as const
type Emotion = typeof EMOTIONS[number]

/** 表演提示 → IndexTTS2 情绪向量（合计 ≤ 1.5）；认不出的提示返回全 0，按参考音频的原始情绪说 */
export function emotionFromTone(tone = ''): Record<Emotion, number> {
  const v = Object.fromEntries(EMOTIONS.map(e => [e, 0])) as Record<Emotion, number>
  const rules: [RegExp, Partial<Record<Emotion, number>>][] = [
    [/慌|急|手忙脚乱|结巴|吓/, { afraid: 0.5, surprised: 0.3 }],
    [/惊|愣|震/, { surprised: 0.7 }],
    [/乐|笑|逗|调侃|得意|嘲/, { happy: 0.6 }],
    [/怒|气|吼|喊|凶/, { angry: 0.6 }],
    [/委屈|难过|哭|失落|沮丧/, { sad: 0.6, melancholic: 0.2 }],
    [/嫌|烦|不耐烦/, { disgusted: 0.4 }],
    [/面无表情|冷淡|平静|官腔|淡定|慢悠悠|抿/, { calm: 0.7 }],
  ]
  for (const [re, add] of rules) if (re.test(tone)) for (const [k, n] of Object.entries(add)) v[k as Emotion] += n!
  const sum = Object.values(v).reduce((a, b) => a + b, 0)
  if (sum > 1.5) for (const k of EMOTIONS) v[k] = Math.round((v[k] * 1.5 / sum) * 100) / 100
  return v
}

/** IndexTTS2 默认工作流：参考音色 → IndexTTS2 Simple（情绪向量）→ 保存 wav */
function defaultWorkflow(): Workflow {
  return {
    '1': { class_type: 'LoadAudio', inputs: { audio: '{{audio}}' } },
    '2': { class_type: 'IndexTTS2EmotionVector', inputs: Object.fromEntries(EMOTIONS.map(e => [e, `{{${e}}}`])) },
    // output_gain 重新生成时会在 0.97–1 之间微调：IndexTTS2 节点没有 seed，输入完全相同 ComfyUI 会直接返回缓存
    '3': { class_type: 'IndexTTS2Simple', inputs: { audio: ['1', 0], text: '{{text}}', emotion_control_weight: 0.6, emotion_vector: ['2', 0], use_fp16: true, output_gain: '{{gain}}' } },
    '4': { class_type: 'IndexTTS2SaveAudio', inputs: { audio: ['3', 0], name: '{{name}}', format: 'wav' } },
  }
}

/** 音色设计默认工作流：Qwen3-TTS VoiceDesign 按描述念一段台词 → 保存（当角色参考人声） */
function defaultVoiceDesignWorkflow(): Workflow {
  return {
    '1': { class_type: 'AILab_Qwen3TTSVoiceDesign', inputs: { text: '{{text}}', instruct: '{{instruct}}', model_size: '1.7B', language: 'Chinese', unload_models: true, seed: '{{seed}}' } },
    '2': { class_type: 'SaveAudio', inputs: { audio: ['1', 0], filename_prefix: 'huobao/{{name}}' } },
  }
}

const baseName = (name: string) => name.split('·')[0].replace(/[甲乙丙丁戊ABCD0-9]+$/, '').trim()

async function voiceCharacters(dramaId: number) {
  return (await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId)))
    .filter(c => !c.deletedAt)
}

/** 说话人名 → 有音色的角色（同名优先，其次同一个人的其他造型） */
function findVoice(speaker: string, chars: Awaited<ReturnType<typeof voiceCharacters>>) {
  const withVoice = chars.filter(c => c.voiceAudioUrl)
  return withVoice.find(c => c.name === speaker)
    || withVoice.find(c => baseName(c.name) === baseName(speaker))
    || null
}

/** 从分镜的 shot_spec 整理出本镜要说的台词（对口型在前，配音按顺序） */
export function linesOfShot(spec: ReturnType<typeof parseShotSpec>): Omit<VoiceTrack, 'character_id'>[] {
  const out: Omit<VoiceTrack, 'character_id'>[] = []
  if (spec?.dialogue?.text?.trim()) out.push({ kind: 'LIP', speaker: (spec.dialogue.speaker || '').trim(), text: spec.dialogue.text.trim(), tone: spec.dialogue.tone })
  for (const v of spec?.voiceover || []) {
    if (v?.text?.trim()) out.push({ kind: (v.kind || 'VO').toUpperCase(), speaker: (v.speaker || '').trim(), text: v.text.trim(), tone: v.tone })
  }
  return out
}

async function comfyConfig(episodeId: number) {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const rows = (await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, 'video')))
    .filter(r => r.provider === 'comfyui' && r.isActive !== false)
  const cfg = rows.find(r => r.id === ep?.videoConfigId) || rows.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
  if (!cfg) throw new Error('没有可用的 ComfyUI 视频配置（配音复用它的 ComfyUI 地址）')
  let settings: any = {}
  try { settings = JSON.parse(cfg.settings || '{}') || {} } catch {}
  const parse = (v: any, fallback: Workflow): Workflow => !v ? fallback : typeof v === 'string' ? JSON.parse(v) : v
  const workflow = parse(settings.ttsWorkflow, defaultWorkflow())
  const designWorkflow = parse(settings.voiceDesignWorkflow, defaultVoiceDesignWorkflow())
  const headers: Record<string, string> = {}
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  return { ep, baseUrl: cfg.baseUrl, headers, workflow, designWorkflow }
}
type ComfyConf = Awaited<ReturnType<typeof comfyConfig>>

async function uploadAudio(baseUrl: string, headers: Record<string, string>, rel: string): Promise<string> {
  const abs = getAbsolutePath(rel.replace(/^\//, ''))
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(fs.readFileSync(abs))]), path.basename(abs))
  form.append('overwrite', 'true')
  form.append('subfolder', 'huobao')
  const resp = await fetch(joinProviderUrl(baseUrl, '', '/upload/image'), { method: 'POST', headers, body: form, signal: AbortSignal.timeout(120_000) })
  if (!resp.ok) throw new Error(`上传音色到 ComfyUI 失败: HTTP ${resp.status}`)
  const data: any = await resp.json().catch(() => ({}))
  return `${data?.subfolder || 'huobao'}/${data?.name || path.basename(abs)}`
}

/** 跑一句：fresh=true 时微调音量绕开 ComfyUI 缓存，得到一条新的念法 */
function synthesize(conf: ComfyConf, audioName: string, track: VoiceTrack, fileStem: string, fresh = false): Promise<string> {
  const gain = fresh ? Math.round((0.97 + Math.random() * 0.03) * 1000) / 1000 : 1
  return runAudioWorkflow(conf, conf.workflow, { text: track.text, audio: audioName, name: fileStem, gain, ...emotionFromTone(track.tone) }, 'tts', fileStem)
}

/** 提交工作流 → 轮询 → 下载第一个音频输出到 static/<dir>/ */
async function runAudioWorkflow(conf: ComfyConf, workflow: Workflow, vars: Record<string, string | number>, dir: string, fileStem: string): Promise<string> {
  const wf: Workflow = JSON.parse(JSON.stringify(workflow))
  for (const key of collectPlaceholders(wf)) if (!(key in vars)) throw new Error(`配音工作流占位符 {{${key}}} 没有对应的值`)
  substitutePlaceholders(wf, vars)
  const submit = await fetch(joinProviderUrl(conf.baseUrl, '', '/prompt'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...conf.headers },
    body: JSON.stringify({ prompt: wf, client_id: 'huobao-tts' }), signal: AbortSignal.timeout(60_000),
  })
  const sub: any = await submit.json().catch(() => ({}))
  if (!submit.ok || !sub.prompt_id) throw new Error(`提交配音任务失败: ${describeExecutionError(sub?.node_errors || sub?.error) || submit.status}`)
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
    const h = await fetch(joinProviderUrl(conf.baseUrl, '', `/history/${sub.prompt_id}`), { headers: conf.headers }).then(r => r.json()).catch(() => ({}))
    const item = h?.[sub.prompt_id]
    if (!item) continue
    if (item.status?.status_str === 'error') throw new Error(`配音失败: ${describeExecutionError(item.status?.messages)}`)
    const files = Object.values(item.outputs || {}).flatMap((o: any) => o?.audio || []).filter((f: any) => f?.type !== 'input')
    if (!files.length) { if (item.status?.completed) throw new Error('配音工作流没有输出音频'); continue }
    const f: any = files[0]
    const url = new URL(joinProviderUrl(conf.baseUrl, '', '/view'))
    url.searchParams.set('filename', f.filename); url.searchParams.set('subfolder', f.subfolder || ''); url.searchParams.set('type', f.type || 'output')
    const resp = await fetch(url, { headers: conf.headers })
    if (!resp.ok) throw new Error(`下载配音失败: HTTP ${resp.status}`)
    const ext = path.extname(f.filename) || '.wav'
    const rel = `${dir}/${fileStem}${ext}`
    fs.mkdirSync(path.join(STORAGE_ROOT, dir), { recursive: true })
    fs.writeFileSync(path.join(STORAGE_ROOT, rel), Buffer.from(await resp.arrayBuffer()))
    return `static/${rel}`
  }
  throw new Error('配音超时（10 分钟）')
}

function wavSeconds(rel: string): number | undefined {
  try {
    const buf = fs.readFileSync(getAbsolutePath(rel))
    const rate = buf.readUInt32LE(28) // byte rate
    const dataIdx = buf.indexOf('data')
    if (rate > 0 && dataIdx > 0) return Math.round((buf.readUInt32LE(dataIdx + 4) / rate) * 100) / 100
  } catch {}
  return undefined
}

// ─── 自动设计音色 ─────────────────────────────────────────────

type Char = Awaited<ReturnType<typeof voiceCharacters>>[number]
export const AUTO_VOICE_NAME = '自动设计音色'

/** 文本模型给角色写音色描述。按优先级逐个试启用的 OpenAI 兼容文本配置（本地 vLLM 没开时自动落到下一个），全失败返回 {} */
async function writeVoicePrompts(dramaTitle: string, chars: Char[], linesBy: Map<string, string[]>): Promise<Record<string, string>> {
  const rows = (await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, 'text')))
    .filter(r => r.isActive && ['openai', 'volcengine'].includes((r.provider || '').toLowerCase()))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  const brief = chars.map(c => ({
    name: baseName(c.name), role: c.role, description: c.description, appearance: c.appearance, personality: c.personality,
    lines: (linesBy.get(baseName(c.name)) || []).slice(0, 6),
  }))
  const prompt = [
    '你是短剧配音导演。给下面每个角色写一句音色描述，交给语音合成模型（Qwen3-TTS VoiceDesign）按描述生成这个角色的声音。',
    '要求：',
    '- 每个角色 30–60 字，中文，写清性别、大致年龄、音色质感（清亮/沙哑/浑厚/软糯……）、语速、说话习惯和情绪底色；',
    '- 只写声音，不写外貌和剧情；',
    '- 非人角色（精怪、器物成精等）也要给出人能发出的声音，比如"七八岁小孩的奶声"；',
    '- 同一部剧里各角色的声音要拉开差别，不要撞音色。',
    `剧名：《${dramaTitle}》`,
    `角色资料：${JSON.stringify(brief)}`,
    '只输出一个 JSON 对象，键是角色名，值是音色描述，不要别的文字。',
  ].join('\n')
  for (const r of rows) {
    try {
      const model = JSON.parse(r.model || '[]')[0]
      if (!model) continue
      const prefix = (r.provider || '').toLowerCase() === 'volcengine' ? '/api/v3' : '/v1'
      const resp = await fetch(joinProviderUrl(r.baseUrl, prefix, '/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(r.apiKey ? { Authorization: `Bearer ${r.apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.7 }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data: any = await resp.json()
      const text = String(data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '')
      const out = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '')
      if (out && typeof out === 'object') {
        logTaskProgress('TTS', 'voice-prompts', { configId: r.id, count: Object.keys(out).length })
        return out
      }
    } catch (e: any) {
      logTaskProgress('TTS', 'voice-prompts-fallback', { configId: r.id, error: e.message })
    }
  }
  return {}
}

/** 设计音色时念的样句：本角色自己的台词凑 25–60 字，没有台词用通用句 */
function sampleText(name: string, lines: string[]) {
  let s = ''
  for (const l of lines) {
    if (s.length >= 25) break
    const t = l.replace(/\s+/g, '')
    s += /[。！？!?…]$/.test(t) ? t : `${t}。`
  }
  if (s.length < 12) s = `你好，我是${name}。这件事交给我吧，我一定会把它办好的，你就放心好了。`
  return s.slice(0, 60)
}

/**
 * 保证这些角色（按同人名分组）都有音色：没有就自动设计。redesign=true 时不管有没有都重新设计（换一个随机种子）。
 * 返回设计失败的角色名 → 原因
 */
async function ensureVoices(ctx: VoiceCtx, names: string[], redesign = false): Promise<Map<string, string>> {
  const errors = new Map<string, string>()
  const wanted = [...new Set(names.map(baseName).filter(Boolean))]
  for (const n of wanted) if (!ctx.chars.some(c => baseName(c.name) === n)) errors.set(n, '角色列表里没有这个人')
  const groups = wanted
    .map(name => ({ name, chars: ctx.chars.filter(c => baseName(c.name) === name) }))
    .filter(g => g.chars.length && (redesign || !g.chars.some(c => c.voiceAudioUrl)))
  if (!groups.length) return errors
  const needPrompt = groups.filter(g => !g.chars.some(c => c.voicePrompt?.trim()))
  const written = needPrompt.length ? await writeVoicePrompts(ctx.dramaTitle, needPrompt.map(g => g.chars[0]), ctx.linesBy) : {}
  for (const g of groups) {
    const instruct = g.chars.find(c => c.voicePrompt?.trim())?.voicePrompt?.trim()
      || String(written[g.name] || '').trim()
      || `${g.name}的声音，吐字清晰、自然的中文普通话，语气贴合角色。`
    try {
      const stem = `drama${ctx.conf.ep!.dramaId}-char${g.chars[0].id}-${Date.now()}`
      const url = await runAudioWorkflow(ctx.conf, ctx.conf.designWorkflow, {
        text: sampleText(g.name, ctx.linesBy.get(g.name) || []), instruct, seed: Math.floor(Math.random() * 2 ** 31), name: stem,
      }, 'voices', stem)
      for (const c of g.chars) {
        await db.update(schema.characters).set({ voiceAudioUrl: url, voiceAudioName: AUTO_VOICE_NAME, voicePrompt: instruct, updatedAt: now() }).where(eq(schema.characters.id, c.id))
        Object.assign(c, { voiceAudioUrl: url, voiceAudioName: AUTO_VOICE_NAME, voicePrompt: instruct })
      }
      logTaskProgress('TTS', 'voice-designed', { name: g.name, url })
    } catch (e: any) {
      errors.set(g.name, e.message)
      logTaskError('TTS', 'voice-design', { name: g.name, error: e.message })
    }
  }
  return errors
}

// ─── 逐镜配音 ─────────────────────────────────────────────

type Storyboard = typeof schema.storyboards.$inferSelect

interface VoiceCtx {
  conf: ComfyConf
  chars: Char[]
  dramaTitle: string
  /** 同人名 → 本集他的全部台词（写音色描述、念样句用） */
  linesBy: Map<string, string[]>
  uploaded: Map<string, string>
  shots: Storyboard[]
  done: number
  failed: number
}

async function voiceContext(episodeId: number): Promise<VoiceCtx> {
  const conf = await comfyConfig(episodeId)
  if (!conf.ep) throw new Error('剧集不存在')
  const chars = await voiceCharacters(conf.ep.dramaId)
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, conf.ep.dramaId))
  const shots = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => !sb.deletedAt).sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const linesBy = new Map<string, string[]>()
  for (const sb of shots) for (const l of linesOfShot(parseShotSpec(sb.shotSpec))) {
    const k = baseName(l.speaker)
    if (!linesBy.has(k)) linesBy.set(k, [])
    linesBy.get(k)!.push(l.text)
  }
  return { conf, chars, dramaTitle: drama?.title || '', linesBy, uploaded: new Map(), shots, done: 0, failed: 0 }
}

const sameLine = (t: VoiceTrack | undefined, line: Omit<VoiceTrack, 'character_id'>) =>
  !!t && t.text === line.text && t.speaker === line.speaker && (t.tone || '') === (line.tone || '')

/** 给一镜配音：台词、说话人、语气都没变且已有音频的句子保留，除非 redo 指定重做；fresh=true 让重做的句子换一种念法 */
async function voiceShot(ctx: VoiceCtx, sb: Storyboard, redo: (t: VoiceTrack, i: number) => boolean, fresh = false) {
  let old: VoiceTrack[] = []
  try { old = JSON.parse(sb.voiceTracks || '[]') } catch {}
  const tracks: VoiceTrack[] = linesOfShot(parseShotSpec(sb.shotSpec)).map((line, i) => {
    const t: VoiceTrack = { ...line, character_id: findVoice(line.speaker, ctx.chars)?.id ?? null }
    const prev = old[i]
    return prev?.url && sameLine(prev, line) && !redo(t, i) ? { ...t, url: prev.url, seconds: prev.seconds, at: prev.at } : t
  })
  for (const [i, t] of tracks.entries()) {
    if (t.url) continue
    const voice = ctx.chars.find(c => c.id === t.character_id)
    if (!voice?.voiceAudioUrl) { t.error = '角色没有音色'; ctx.failed++; continue }
    try {
      let audioName = ctx.uploaded.get(voice.voiceAudioUrl)
      if (!audioName) { audioName = await uploadAudio(ctx.conf.baseUrl, ctx.conf.headers, voice.voiceAudioUrl); ctx.uploaded.set(voice.voiceAudioUrl, audioName) }
      t.url = await synthesize(ctx.conf, audioName, t, `ep${sb.episodeId}-sb${sb.id}-${i + 1}-${Date.now()}`, fresh)
      t.seconds = wavSeconds(t.url)
      delete t.error
      ctx.done++
      logTaskProgress('TTS', 'line', { storyboardId: sb.id, speaker: t.speaker, seconds: t.seconds })
    } catch (e: any) {
      t.error = e.message
      ctx.failed++
      logTaskError('TTS', 'line', { storyboardId: sb.id, speaker: t.speaker, error: e.message })
    }
  }
  await db.update(schema.storyboards).set({ voiceTracks: JSON.stringify(tracks), updatedAt: now() }).where(eq(schema.storyboards.id, sb.id))
  return tracks
}

/**
 * 给一集生成配音。默认只补没生成过、或台词/语气已改动的句子；force=true 全部重做；
 * speakers 只重做这些人的句子（换音色后用）。没有音色的角色先自动设计。
 */
export async function generateEpisodeVoices(episodeId: number, opts: { force?: boolean; storyboardIds?: number[]; speakers?: string[] } = {}) {
  const ctx = await voiceContext(episodeId)
  const shots = ctx.shots.filter(sb => !opts.storyboardIds?.length || opts.storyboardIds.includes(sb.id))
  const only = opts.speakers?.length ? new Set(opts.speakers.map(baseName)) : null
  logTaskStart('TTS', 'episode', { episodeId, shots: shots.length })
  const speakers = shots.flatMap(sb => linesOfShot(parseShotSpec(sb.shotSpec)).map(l => l.speaker))
    .filter(s => (!only || only.has(baseName(s))) && !findVoice(s, ctx.chars))
  const designErrors = await ensureVoices(ctx, speakers)
  for (const sb of shots) {
    if (only && !linesOfShot(parseShotSpec(sb.shotSpec)).some(l => only.has(baseName(l.speaker)))) continue
    await voiceShot(ctx, sb, t => !!opts.force || !!only?.has(baseName(t.speaker)), !!only)
  }
  const missing = [...designErrors.entries()].map(([n, e]) => `${n}（${e}）`)
  logTaskSuccess('TTS', 'episode', { episodeId, done: ctx.done, failed: ctx.failed, missingVoice: missing.join(',') })
  return { generated: ctx.done, failed: ctx.failed, missing_voice: missing }
}

/** 重新生成一句；传了 text / tone 先改回分镜的 shot_spec（对口型台词改了字，视频口型不会跟着变） */
export async function regenerateLine(storyboardId: number, index: number, edit: { text?: string; tone?: string } = {}) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb || sb.deletedAt) throw new Error('分镜不存在')
  const spec = parseShotSpec(sb.shotSpec)
  if (!spec) throw new Error('这一镜没有结构化台词')
  const hasLip = !!spec.dialogue?.text?.trim()
  const slot: { text?: string | null; tone?: string | null } | undefined = index === 0 && hasLip
    ? spec.dialogue!
    : (spec.voiceover || []).filter(v => v?.text?.trim())[index - (hasLip ? 1 : 0)]
  if (!slot) throw new Error(`第 ${index + 1} 句不存在`)
  if (edit.text?.trim()) slot.text = edit.text.trim()
  if (edit.tone !== undefined) slot.tone = edit.tone.trim() || undefined
  sb.shotSpec = JSON.stringify(spec)
  await db.update(schema.storyboards).set({ shotSpec: sb.shotSpec, updatedAt: now() }).where(eq(schema.storyboards.id, sb.id))
  const ctx = await voiceContext(sb.episodeId)
  const speaker = linesOfShot(spec)[index]?.speaker || ''
  const designErrors = findVoice(speaker, ctx.chars) ? new Map<string, string>() : await ensureVoices(ctx, [speaker])
  const track = (await voiceShot(ctx, sb, (_t, i) => i === index, true))[index]
  if (!track?.url) throw new Error(track?.error || designErrors.get(baseName(speaker)) || '生成失败')
  return track
}

/** 换音色：重新设计这个人的音色（可同时改音色描述），然后重做本集他的全部台词。后台任务 */
export function startRedesignVoice(episodeId: number, characterId: number, opts: { voicePrompt?: string } = {}) {
  return startJob(episodeId, async () => {
    const ctx = await voiceContext(episodeId)
    const target = ctx.chars.find(c => c.id === characterId)
    if (!target) throw new Error('角色不存在')
    const name = baseName(target.name)
    const prompt = opts.voicePrompt?.trim()
    if (prompt) {
      for (const c of ctx.chars.filter(c => baseName(c.name) === name)) {
        await db.update(schema.characters).set({ voicePrompt: prompt, updatedAt: now() }).where(eq(schema.characters.id, c.id))
        c.voicePrompt = prompt
      }
    }
    const err = (await ensureVoices(ctx, [name], true)).get(name)
    if (err) throw new Error(`${name} 音色设计失败：${err}`)
    return generateEpisodeVoices(episodeId, { speakers: [name] })
  })
}

/** 配音面板数据：本集说话的角色（按同人名合并）和逐句列表 */
export async function episodeVoiceLines(episodeId: number) {
  const ctx = await voiceContext(episodeId)
  const lines: any[] = []
  const names: string[] = []
  for (const sb of ctx.shots) {
    let tracks: VoiceTrack[] = []
    try { tracks = JSON.parse(sb.voiceTracks || '[]') } catch {}
    linesOfShot(parseShotSpec(sb.shotSpec)).forEach((line, i) => {
      const t = tracks[i]
      const name = baseName(line.speaker)
      if (name && !names.includes(name)) names.push(name)
      lines.push({
        storyboard_id: sb.id, storyboard_number: sb.storyboardNumber, index: i, ...line,
        url: t?.url || null, seconds: t?.seconds ?? null, error: t?.error || null,
        /** 台词或语气改过，音频还是旧的 */
        stale: !!t?.url && !sameLine(t, line),
      })
    })
  }
  const characters = names.map(name => {
    const group = ctx.chars.filter(c => baseName(c.name) === name)
    const withVoice = group.find(c => c.voiceAudioUrl)
    return {
      name,
      character_id: (withVoice || group[0])?.id ?? null,
      voice_audio_url: withVoice?.voiceAudioUrl || null,
      voice_prompt: group.find(c => c.voicePrompt)?.voicePrompt || null,
      auto: withVoice?.voiceAudioName === AUTO_VOICE_NAME,
      lines: lines.filter(l => baseName(l.speaker) === name).length,
    }
  })
  return { characters, lines }
}

/** 按角色分好的台词清单（给 TTS / 真人配音用），markdown */
export async function episodeLineSheet(episodeId: number): Promise<string> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const shots = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => !sb.deletedAt).sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const KIND: Record<string, string> = { LIP: '对口型', VO: '内心独白', OS: '画外音', DUB: '配音' }
  const bySpeaker = new Map<string, string[]>()
  const order: string[] = []
  for (const sb of shots) {
    for (const t of linesOfShot(parseShotSpec(sb.shotSpec))) {
      const who = baseName(t.speaker) || '（未写说话人）'
      if (!bySpeaker.has(who)) bySpeaker.set(who, [])
      bySpeaker.get(who)!.push(`- 镜${sb.storyboardNumber}［${KIND[t.kind] || t.kind}］${t.tone ? `（${t.tone}）` : ''}${t.speaker !== who ? `${t.speaker}：` : ''}${t.text}`)
      order.push(`${sb.storyboardNumber}. ${t.speaker}［${KIND[t.kind] || t.kind}］：${t.text}`)
    }
  }
  const parts = [`# ${ep.title} 台词清单`, '', '## 按角色', '']
  for (const [who, lines] of bySpeaker) parts.push(`### ${who}（${lines.length} 句）`, ...lines, '')
  parts.push('## 按出场顺序', '', ...order, '')
  return parts.join('\n')
}

// ─── 整集配音后台任务（进程内状态，重启后丢失；结果已逐镜落库） ─────────────────

export interface VoiceJob { status: 'running' | 'done' | 'error'; started_at: string; finished_at?: string; result?: Awaited<ReturnType<typeof generateEpisodeVoices>>; error?: string }
const jobs = new Map<number, VoiceJob>()

/** 一集同时只跑一个配音任务（整集配音 / 换音色） */
function startJob(episodeId: number, run: () => Promise<Awaited<ReturnType<typeof generateEpisodeVoices>>>) {
  if (jobs.get(episodeId)?.status === 'running') return { started: false }
  const job: VoiceJob = { status: 'running', started_at: new Date().toISOString() }
  jobs.set(episodeId, job)
  run()
    .then(result => { job.status = 'done'; job.result = result })
    .catch(e => { job.status = 'error'; job.error = e.message; logTaskError('TTS', 'episode', { episodeId, error: e.message }) })
    .finally(() => { job.finished_at = new Date().toISOString() })
  return { started: true }
}

export function startEpisodeVoices(episodeId: number, opts: { force?: boolean; storyboardIds?: number[] } = {}) {
  return startJob(episodeId, () => generateEpisodeVoices(episodeId, opts))
}

export function getEpisodeVoicesStatus(episodeId: number) {
  return jobs.get(episodeId) || null
}
