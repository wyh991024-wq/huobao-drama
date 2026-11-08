/**
 * 台词配音（TTS）：每个角色固定一个音色，按句生成配音音频，存进分镜的 voice_tracks
 *
 * - 音色：角色的 voice_audio_url（5-15 秒参考人声）。同一个人不同造型（太白金星·天庭 / 太白金星·物业）共用一个音色，
 *   「线团团甲/乙」这类编号群角色用「线团团」的音色
 * - 引擎：ComfyUI 上的 IndexTTS2（snicolast/ComfyUI-IndexTTS2，见 docs/comfyui.md），复用视频配置的 ComfyUI 地址；
 *   视频配置 settings.ttsWorkflow 可以换成自己的 API 格式工作流，占位符 {{text}} {{audio}} {{name}}
 *   以及情绪向量 {{happy}} {{angry}} {{sad}} {{afraid}} {{disgusted}} {{melancholic}} {{surprised}} {{calm}}
 * - 对口型台词（shot_spec.dialogue）也生成：用于台词清单试听，以及以后用音频驱动 H3 对口型
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
    '3': { class_type: 'IndexTTS2Simple', inputs: { audio: ['1', 0], text: '{{text}}', emotion_control_weight: 0.6, emotion_vector: ['2', 0], use_fp16: true, output_gain: 1 } },
    '4': { class_type: 'IndexTTS2SaveAudio', inputs: { audio: ['3', 0], name: '{{name}}', format: 'wav' } },
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
  let workflow: Workflow = defaultWorkflow()
  if (settings.ttsWorkflow) workflow = typeof settings.ttsWorkflow === 'string' ? JSON.parse(settings.ttsWorkflow) : settings.ttsWorkflow
  const headers: Record<string, string> = {}
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  return { ep, baseUrl: cfg.baseUrl, headers, workflow }
}

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

/** 跑一句：提交工作流 → 轮询 → 下载第一个音频输出 */
async function synthesize(conf: Awaited<ReturnType<typeof comfyConfig>>, audioName: string, track: VoiceTrack, fileStem: string): Promise<string> {
  const wf: Workflow = JSON.parse(JSON.stringify(conf.workflow))
  const vars: Record<string, string | number> = { text: track.text, audio: audioName, name: fileStem, ...emotionFromTone(track.tone) }
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
    const rel = `tts/${fileStem}${ext}`
    fs.mkdirSync(path.join(STORAGE_ROOT, 'tts'), { recursive: true })
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

/**
 * 给一集生成配音。默认只补没生成过、或台词已改动的句子；force=true 全部重做。
 * 没上传音色的角色跳过并在结果里列出。
 */
export async function generateEpisodeVoices(episodeId: number, opts: { force?: boolean; storyboardIds?: number[] } = {}) {
  const conf = await comfyConfig(episodeId)
  if (!conf.ep) throw new Error('剧集不存在')
  const chars = await voiceCharacters(conf.ep.dramaId)
  const shots = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => !sb.deletedAt && (!opts.storyboardIds?.length || opts.storyboardIds.includes(sb.id)))
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const missingVoice = new Set<string>()
  const uploaded = new Map<string, string>()
  let done = 0, failed = 0
  logTaskStart('TTS', 'episode', { episodeId, shots: shots.length })
  for (const sb of shots) {
    let old: VoiceTrack[] = []
    try { old = JSON.parse(sb.voiceTracks || '[]') } catch {}
    const tracks: VoiceTrack[] = linesOfShot(parseShotSpec(sb.shotSpec)).map((line, i) => {
      const voice = findVoice(line.speaker, chars)
      const prev = old[i]
      const same = prev && prev.text === line.text && prev.speaker === line.speaker && prev.url && !opts.force
      return { ...line, character_id: voice?.id ?? null, ...(same ? { url: prev.url, seconds: prev.seconds, at: prev.at } : {}) }
    })
    for (const [i, t] of tracks.entries()) {
      if (t.url) continue
      const voice = chars.find(c => c.id === t.character_id)
      if (!voice?.voiceAudioUrl) { missingVoice.add(t.speaker || '（未写说话人）'); t.error = '角色没有音色'; continue }
      try {
        let audioName = uploaded.get(voice.voiceAudioUrl)
        if (!audioName) { audioName = await uploadAudio(conf.baseUrl, conf.headers, voice.voiceAudioUrl); uploaded.set(voice.voiceAudioUrl, audioName) }
        t.url = await synthesize(conf, audioName, t, `ep${episodeId}-sb${sb.id}-${i + 1}-${Date.now()}`)
        t.seconds = wavSeconds(t.url)
        delete t.error
        done++
        logTaskProgress('TTS', 'line', { storyboardId: sb.id, speaker: t.speaker, seconds: t.seconds })
      } catch (e: any) {
        t.error = e.message
        failed++
        logTaskError('TTS', 'line', { storyboardId: sb.id, speaker: t.speaker, error: e.message })
      }
    }
    await db.update(schema.storyboards).set({ voiceTracks: JSON.stringify(tracks), updatedAt: now() }).where(eq(schema.storyboards.id, sb.id))
  }
  logTaskSuccess('TTS', 'episode', { episodeId, done, failed, missingVoice: [...missingVoice].join(',') })
  return { generated: done, failed, missing_voice: [...missingVoice] }
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

export function startEpisodeVoices(episodeId: number, opts: { force?: boolean; storyboardIds?: number[] } = {}) {
  if (jobs.get(episodeId)?.status === 'running') return { started: false }
  const job: VoiceJob = { status: 'running', started_at: new Date().toISOString() }
  jobs.set(episodeId, job)
  generateEpisodeVoices(episodeId, opts)
    .then(result => { job.status = 'done'; job.result = result })
    .catch(e => { job.status = 'error'; job.error = e.message; logTaskError('TTS', 'episode', { episodeId, error: e.message }) })
    .finally(() => { job.finished_at = new Date().toISOString() })
  return { started: true }
}

export function getEpisodeVoicesStatus(episodeId: number) {
  return jobs.get(episodeId) || null
}
