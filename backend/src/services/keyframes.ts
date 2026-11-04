/**
 * 关键帧流程（漫剧流水线升级第二步，方案 8.1 节）
 *
 * 1. 每个分镜按 shot_spec 的起止画面 + 场记表 + 角色/场景/道具参考图生成首帧（需要时生成尾帧）候选图
 * 2. 候选图不自动覆盖分镜，由人挑选（关卡 3）
 * 3. 视频生成时有首帧就走 H3 首尾帧模式（comfyui 适配器按 settings.keyframeWorkflow 自动切换）
 * 4. 下一镜首帧以上一镜选中的尾帧（没有尾帧时用首帧）为额外参考，保证衔接
 */
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { generateImage } from './generation.js'
import { getDramaStylePrompt } from './style-preset.js'
import { continuityAtShot, parseShotSpec, type SceneState, type ShotSpec } from './director.js'

export type KeyframeKind = 'first' | 'last'
const FRAME_TYPE: Record<KeyframeKind, string> = { first: 'first_frame', last: 'last_frame' }
const SHOT_SIZE_ZH: Record<string, string> = { CU: '特写', MCU: '近景', MS: '中景', MWS: '中全景', WS: '全景', EWS: '大远景' }
const SIZE_BY_RATIO: Record<string, string> = { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1024x1024', '4:3': '1440x1080', '3:4': '1080x1440' }

function stateLines(state: SceneState | null, characterNames: string[]): string[] {
  if (!state) return []
  const lines: string[] = []
  for (const name of characterNames) {
    const c: any = state.characters_state?.[name]
    if (!c) continue
    const parts = [
      c.outfit && `服装：${c.outfit}`,
      c.position && `位置：${c.position}`,
      c.holding && `手持：${c.holding}`,
      c.emotion && `神态：${c.emotion}`,
      c.facing && `朝向：${c.facing}`,
      c.note && `状态：${c.note}`,
    ].filter(Boolean)
    if (parts.length) lines.push(`- ${name}：${parts.join('；')}`)
  }
  return lines
}

async function episodeShots(episodeId: number) {
  return (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => !sb.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
}

/** 组装某个分镜首帧/尾帧的生图提示词与参考图 */
export async function buildKeyframeRequest(storyboardId: number, kind: KeyframeKind) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb || sb.deletedAt) throw new Error('分镜不存在')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId))
  const spec = parseShotSpec(sb.shotSpec)

  const charIds = (await db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, sb.id))).map(l => l.characterId)
  const propIds = (await db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, sb.id))).map(l => l.propId)
  const chars = (await db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId))).filter(c => charIds.includes(c.id) && !c.deletedAt)
  const props = (await db.select().from(schema.props).where(eq(schema.props.dramaId, ep.dramaId))).filter(p => propIds.includes(p.id) && !p.deletedAt)
  const [scene] = sb.sceneId ? await db.select().from(schema.scenes).where(eq(schema.scenes.id, sb.sceneId)) : []

  // 场记：首帧取本镜开始时的状态，尾帧再叠加本镜 end_state
  const shots = await episodeShots(sb.episodeId)
  const idx = shots.findIndex(x => x.id === sb.id)
  let continuity: SceneState | null = null
  if (spec?.scene_code) {
    const [row] = await db.select().from(schema.sceneContinuity)
      .where(and(eq(schema.sceneContinuity.episodeId, sb.episodeId), eq(schema.sceneContinuity.sceneCode, spec.scene_code)))
    const base = row ? JSON.parse(row.state) as SceneState : undefined
    const previous = shots.slice(0, idx).map(x => parseShotSpec(x.shotSpec)).filter((p): p is ShotSpec => !!p && p.scene_code === spec.scene_code)
    continuity = continuityAtShot(base, kind === 'last' ? [...previous, spec] : previous)
  }

  // 参考图：本镜首帧（生成尾帧时）/ 上一镜尾帧（生成首帧且同场时）→ 角色 → 场景 → 道具
  const references: string[] = []
  const push = (url?: string | null) => { if (url && !references.includes(url)) references.push(url) }
  if (kind === 'last') push(sb.firstFrameImage)
  const prev = shots[idx - 1]
  const prevSpec = prev ? parseShotSpec(prev.shotSpec) : null
  if (kind === 'first' && prev && prevSpec?.scene_code && prevSpec.scene_code === spec?.scene_code) push(prev.lastFrameImage || prev.firstFrameImage)
  for (const c of chars) push(c.imageUrl)
  push(scene?.imageUrl)
  for (const p of props) push(p.imageUrl)

  const style = await getDramaStylePrompt(ep.dramaId)
  const frameText = kind === 'first' ? (spec?.start_frame || sb.description || '') : (spec?.end_frame || sb.result || '')
  const ratio = drama?.aspectRatio || '16:9'
  const refNote = references.length
    ? `参考图依次为：${[
      kind === 'last' && sb.firstFrameImage ? '本镜首帧（保持人物、服装、光线一致）' : '',
      kind === 'first' && prev && references[0] === (prev.lastFrameImage || prev.firstFrameImage) ? '上一镜结束画面（保持衔接）' : '',
      ...chars.filter(c => c.imageUrl).map(c => `${c.name}的定妆图`),
      scene?.imageUrl ? `场景「${scene.location}」` : '',
      ...props.filter(p => p.imageUrl).map(p => `道具「${p.name}」`),
    ].filter(Boolean).join('、')}。`
    : ''
  const prompt = [
    style,
    `电影分镜关键帧（${kind === 'first' ? '镜头开始' : '镜头结束'}的一帧），${SHOT_SIZE_ZH[spec?.shot_size || ''] || '中景'}构图，画幅 ${ratio}。`,
    `画面：${frameText}`,
    continuity ? `场景：${continuity.location || scene?.location || ''}，${continuity.time_of_day || scene?.time || ''}；光线：${continuity.lighting || scene?.lighting || ''}` : (scene ? `场景：${scene.location}，${scene.time || ''}` : ''),
    ...(continuity ? ['人物状态：', ...stateLines(continuity, chars.map(c => c.name))] : []),
    refNote,
    '人物的脸、发型、服装与定妆图一致，场景与参考图一致。单一画面的电影剧照，构图清晰；不要拼图、分格或三视图，不要任何文字、字幕或水印。',
  ].filter(Boolean).join('\n')

  return { storyboard: sb, dramaId: ep.dramaId, prompt, references: references.slice(0, 6), size: SIZE_BY_RATIO[ratio] || '1920x1080' }
}

/** 生成候选关键帧（不覆盖分镜已选的关键帧） */
export async function generateKeyframeCandidates(storyboardId: number, kind: KeyframeKind, count: number, opts: { configId?: number; model?: string } = {}) {
  const req = await buildKeyframeRequest(storyboardId, kind)
  const n = Math.min(4, Math.max(1, Math.round(count || 2)))
  const ids: number[] = []
  for (let i = 0; i < n; i++) {
    ids.push(await generateImage({
      storyboardId,
      dramaId: req.dramaId,
      prompt: req.prompt,
      model: opts.model,
      size: req.size,
      referenceImages: req.references,
      frameType: FRAME_TYPE[kind],
      keyframeCandidate: true,
      configId: opts.configId,
    }))
  }
  return { task_ids: ids, prompt: req.prompt, references: req.references }
}

/** 某分镜的候选关键帧与当前选择 */
export async function listKeyframes(storyboardId: number) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const tasks = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.storyboardId, storyboardId), eq(schema.sysTask.type, 'image')))
    .orderBy(desc(schema.sysTask.id))
  const candidates = tasks.map(t => {
    let params: any = {}
    try { params = JSON.parse(t.params || '{}') } catch {}
    const kind = params.frameType === 'first_frame' ? 'first' : params.frameType === 'last_frame' ? 'last' : null
    return kind && params.keyframeCandidate ? { task_id: t.id, kind, status: t.status, image: t.localPath, error: t.errorMsg, created_at: t.createdAt } : null
  }).filter(Boolean)
  return { first_frame_image: sb.firstFrameImage, last_frame_image: sb.lastFrameImage, candidates }
}

/** 选定（或清除）某分镜的首帧/尾帧 */
export async function selectKeyframe(storyboardId: number, kind: KeyframeKind, image: string | null) {
  const field = kind === 'first' ? { firstFrameImage: image } : { lastFrameImage: image }
  await db.update(schema.storyboards).set({ ...field, updatedAt: now() }).where(eq(schema.storyboards.id, storyboardId))
}

/** 整集批量：首帧给所有分镜；尾帧只给有运镜或明显动作的分镜（camera_move 不是 STATIC） */
export async function batchKeyframes(episodeId: number, kind: KeyframeKind, count: number, opts: { configId?: number; model?: string; onlyMissing?: boolean } = {}) {
  const shots = await episodeShots(episodeId)
  const targets = shots.filter(sb => {
    if (opts.onlyMissing !== false && (kind === 'first' ? sb.firstFrameImage : sb.lastFrameImage)) return false
    if (kind === 'last') return (parseShotSpec(sb.shotSpec)?.camera_move || 'STATIC') !== 'STATIC'
    return true
  })
  const started: number[] = []
  for (const sb of targets) {
    await generateKeyframeCandidates(sb.id, kind, count, opts)
    started.push(sb.id)
  }
  return { storyboard_ids: started }
}

