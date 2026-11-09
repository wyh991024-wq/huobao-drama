/**
 * 按顺序生成整集视频（段模式配套）：同一场内，上一段出完后截它的最后一帧，接到下一段开头。
 *
 * - first_frame：末帧当真正的首帧（H3 首尾帧工作流 FL2VA），衔接最准；但该工作流不带角色参考图和音色参考音频，
 *   开口说话的音色不受角色音色样本约束
 * - reference：末帧作为第 1 张参考图，提示词要求从这个构图开场（H3 参考生视频 Ref2VA），角色参考图和音色参考都保留，衔接稍松
 *
 * 每段的参考图与 @名字 → @图片N 的替换规则与工作台 genVid 一致（场景 → 角色 → 道具，最多 9 张）。
 * 进程内任务状态，重启后丢失；已出完的段在分镜上有 video_url，重跑时默认跳过。
 */
import fs from 'fs'
import path from 'path'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { getAbsolutePath } from '../utils/storage.js'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { parseShotSpec } from './director.js'
import tasksApp from '../routes/tasks.js'

export type ChainMode = 'first_frame' | 'reference'
export interface ChainOptions {
  mode?: ChainMode
  /** 只出前几段（试拍用） */
  limit?: number
  /** 从第几号分镜开始（含） */
  from?: number
  /** 已有视频的段也重出 */
  force?: boolean
  configId?: number
  model?: string
}
export interface ChainJob {
  status: 'running' | 'done' | 'error' | 'stopped'
  mode: ChainMode
  total: number
  done: number
  current?: number
  started_at: string
  finished_at?: string
  error?: string
  log: string[]
}

const REF_LIMIT = 9
const jobs = new Map<number, ChainJob>()
const stopFlags = new Set<number>()

type Storyboard = typeof schema.storyboards.$inferSelect
const sceneKey = (sb: Storyboard) => parseShotSpec(sb.shotSpec)?.scene_code || (sb.sceneId != null ? `scene-${sb.sceneId}` : '')

/** 截视频最后一帧存成 static/images/chain-*.png，返回相对路径 */
export async function extractLastFrame(videoRel: string, sbId: number): Promise<string> {
  const { ffmpeg: ok } = await checkFfmpegSuite()
  if (!ok) throw new Error('FFmpeg 不可用，无法截取末帧')
  const rel = `images/chain-sb${sbId}-${Date.now()}.png`
  fs.mkdirSync(path.join(STORAGE_ROOT, 'images'), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    ffmpeg(getAbsolutePath(videoRel))
      .inputOptions(['-sseof', '-0.15'])
      .outputOptions(['-frames:v', '1', '-q:v', '2'])
      .output(path.join(STORAGE_ROOT, rel))
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
  return `static/${rel}`
}

/** 与工作台一致：场景 → 角色 → 道具的参考图，以及 @名字 → @图片N */
async function referencesFor(sb: Storyboard, dramaId: number) {
  const charIds = (await db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, sb.id))).map(r => r.characterId)
  const propIds = (await db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, sb.id))).map(r => r.propId)
  const [scene] = sb.sceneId ? await db.select().from(schema.scenes).where(eq(schema.scenes.id, sb.sceneId)) : []
  const chars = (await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId)))
    .filter(c => !c.deletedAt && charIds.includes(c.id))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id)
  const props = (await db.select().from(schema.props).where(eq(schema.props.dramaId, dramaId))).filter(p => !p.deletedAt && propIds.includes(p.id))
  const ordered: { name: string; url: string }[] = []
  const push = (name: string, url?: string | null) => {
    if (url && !ordered.some(o => o.url === url) && ordered.length < REF_LIMIT) ordered.push({ name, url })
  }
  push(scene?.location || '', scene?.imageUrl)
  for (const c of chars) push(c.name, c.imageUrl)
  for (const p of props) push(p.name, p.imageUrl)
  return ordered
}

function resolveRefs(prompt: string, ordered: { name: string; url: string }[], offset: number) {
  const map: Record<string, number> = {}
  ordered.forEach((o, i) => { if (o.name && !(o.name in map)) map[o.name] = i + 1 + offset })
  const names = Object.keys(map).sort((a, b) => b.length - a.length)
  return prompt.replace(/@([^\s@#]+)/g, (m, raw: string) => {
    for (const n of names) if (raw.startsWith(n)) return `@图片${map[n]}${n}${raw.slice(n.length)}`
    return m
  })
}

/** 参考模式：在 detailed_description 开头插一句「从图片1 的构图开场」 */
function anchorToPicture1(prompt: string) {
  const line = 'The video opens on exactly the composition shown in @图片1 (the last frame of the previous clip): same camera position, same framing, every character in the same place and pose, then continues from there.'
  return /detailed_description:\s*\n/.test(prompt)
    ? prompt.replace(/detailed_description:\s*\n/, m => `${m}${line}\n`)
    : `${line}\n${prompt}`
}

async function latestVideoTask(sbId: number) {
  const [t] = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, sbId)))
    .orderBy(desc(schema.sysTask.id)).limit(1)
  return t
}

async function waitTask(id: number, episodeId: number): Promise<typeof schema.sysTask.$inferSelect> {
  const deadline = Date.now() + 40 * 60_000
  while (Date.now() < deadline) {
    if (stopFlags.has(episodeId)) throw new Error('已手动停止')
    const [t] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (t?.status === 'completed') return t
    if (t?.status === 'failed') throw new Error(`任务 ${id} 失败：${t.errorMsg || '未知错误'}`)
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error(`任务 ${id} 超过 40 分钟没有完成`)
}

async function runChain(episodeId: number, opts: ChainOptions, job: ChainJob) {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId))
  const all = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => !sb.deletedAt).sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  let targets = all.filter(sb => sb.storyboardNumber >= (opts.from || 1))
  if (opts.limit) targets = targets.slice(0, opts.limit)
  job.total = targets.length
  const aspect = drama?.aspectRatio || '9:16'
  const log = (m: string) => { job.log.push(`${new Date().toLocaleTimeString()} ${m}`); logTaskProgress('Chain', 'step', { episodeId, msg: m }) }

  for (const sb of targets) {
    if (stopFlags.has(episodeId)) throw new Error('已手动停止')
    job.current = sb.storyboardNumber
    const fresh = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)))[0]
    if (!opts.force && fresh?.videoUrl && fs.existsSync(getAbsolutePath(fresh.videoUrl))) {
      log(`#${sb.storyboardNumber} 已有视频，跳过`)
      job.done++
      continue
    }
    if (!fresh?.videoPrompt?.trim()) throw new Error(`#${sb.storyboardNumber} 没有视频提示词`)

    // 同一场的上一段：截它的末帧
    const idx = all.findIndex(x => x.id === sb.id)
    const prev = idx > 0 ? all[idx - 1] : null
    let lastFrame = ''
    if (prev && sceneKey(prev) && sceneKey(prev) === sceneKey(sb)) {
      const [p] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, prev.id))
      if (!p?.videoUrl || !fs.existsSync(getAbsolutePath(p.videoUrl))) throw new Error(`#${sb.storyboardNumber} 要接上一段 #${prev.storyboardNumber}，但上一段还没有视频`)
      lastFrame = await extractLastFrame(p.videoUrl, sb.id)
      log(`#${sb.storyboardNumber} 截取 #${prev.storyboardNumber} 末帧 → ${lastFrame}`)
    } else {
      log(`#${sb.storyboardNumber} 本场第一段，只用参考图`)
    }
    await db.update(schema.storyboards).set({ firstFrameImage: lastFrame || null, updatedAt: now() }).where(eq(schema.storyboards.id, sb.id))

    const refs = await referencesFor(fresh, ep.dramaId)
    const useFirstFrame = !!lastFrame && opts.mode !== 'reference'
    const asReference = !!lastFrame && opts.mode === 'reference'
    let prompt = resolveRefs(fresh.videoPrompt, refs, asReference ? 1 : 0)
    if (asReference) prompt = anchorToPicture1(prompt)
    const body: Record<string, unknown> = {
      type: 'video', storyboard_id: sb.id, drama_id: ep.dramaId, prompt,
      duration: Number(fresh.duration || 10), aspect_ratio: aspect, generate_audio: true,
      model: opts.model || undefined, config_id: opts.configId ?? ep.videoConfigId ?? undefined,
      reference_image_urls: asReference ? [lastFrame, ...refs.map(r => r.url)].slice(0, REF_LIMIT) : refs.map(r => r.url),
      force_new: true,
      // 段与段衔接用的首帧，不受项目「关键帧」开关影响
      chain_first_frame: useFirstFrame,
      ...(useFirstFrame ? { first_frame_url: lastFrame } : {}),
    }
    const resp = await tasksApp.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data: any = await resp.json().catch(() => ({}))
    const taskId = Number(data?.data?.id)
    if (!resp.ok || !taskId) throw new Error(`#${sb.storyboardNumber} 提交失败：${data?.message || resp.status}`)
    log(`#${sb.storyboardNumber} 已提交任务 ${taskId}（${useFirstFrame ? '首帧衔接' : asReference ? '末帧作参考图' : '参考图'}）`)
    await waitTask(taskId, episodeId)
    job.done++
    log(`#${sb.storyboardNumber} 完成`)
  }
}

export function startEpisodeChain(episodeId: number, opts: ChainOptions = {}) {
  if (jobs.get(episodeId)?.status === 'running') return { started: false }
  stopFlags.delete(episodeId)
  const job: ChainJob = { status: 'running', mode: opts.mode || 'first_frame', total: 0, done: 0, started_at: new Date().toISOString(), log: [] }
  jobs.set(episodeId, job)
  logTaskStart('Chain', 'episode', { episodeId, ...opts })
  runChain(episodeId, opts, job)
    .then(() => { job.status = 'done'; logTaskSuccess('Chain', 'episode', { episodeId, done: job.done }) })
    .catch(e => {
      job.status = stopFlags.has(episodeId) ? 'stopped' : 'error'
      job.error = e.message
      logTaskError('Chain', 'episode', { episodeId, error: e.message })
    })
    .finally(() => { job.finished_at = new Date().toISOString(); job.current = undefined })
  return { started: true }
}

export function getEpisodeChainStatus(episodeId: number) {
  return jobs.get(episodeId) || null
}

/** 停止顺序生成：不再提交新段；正在跑的那一段由用户在任务列表里取消 */
export function stopEpisodeChain(episodeId: number) {
  if (jobs.get(episodeId)?.status !== 'running') return { stopped: false }
  stopFlags.add(episodeId)
  return { stopped: true }
}
