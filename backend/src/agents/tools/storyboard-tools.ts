/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { and, eq, isNull } from 'drizzle-orm'
import { CAMERA_MOVES, SHOT_SIZES, checkStoryboardRules, continuityAtShot, isPovScript, parseShotSpec, type SceneState, type ShotSpec } from '../../services/director.js'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId } from '../context.js'
import { resolveVoiceMentions } from '../../services/character-voice-references.js'

async function validateVideoPromptVoices(prompt: string | undefined, dramaId: number, characterIds: number[] = []) {
  if (!prompt?.includes('#')) return
  const characters = await db.select({ id: schema.characters.id, name: schema.characters.name, voiceAudioUrl: schema.characters.voiceAudioUrl }).from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
  // Validate the model's references, but persist the original editable #tokens.
  resolveVoiceMentions(prompt, characters.map(c => ({ ...c, bound: characterIds.includes(c.id) })))
}

async function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  await db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))


  const uniqueIds = [...new Set(characterIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    await db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    })
  }
}

async function syncStoryboardProps(storyboardId: number, propIds: number[]) {
  await db.delete(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))

  const uniqueIds = [...new Set(propIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const propId of uniqueIds) {
    await db.insert(schema.storyboardProps).values({
      storyboardId,
      propId,
    })
  }
}

async function getEpisodeSceneIds(episodeId: number) {
  const links = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  return new Set(links.map(link => link.sceneId))
}

async function getEpisodeCharacterIds(episodeId: number) {
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  return new Set(links.map(link => link.characterId))
}

async function getEpisodePropIds(episodeId: number) {
  const links = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  return new Set(links.map(link => link.propId))
}

async function validateStoryboardBindings(episodeId: number, dramaId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[] | undefined) {
  const episodeSceneIds = await getEpisodeSceneIds(episodeId)
  const episodeCharacterIds = await getEpisodeCharacterIds(episodeId)
  const episodePropIds = await getEpisodePropIds(episodeId)

  // 场景/角色/道具属于本剧但尚未关联到当前集时，自动补关联（拆分时即完成绑定）
  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
    if (!scene || scene.dramaId !== dramaId || scene.deletedAt) {
      throw new Error(`scene_id ${sceneId} 不属于当前项目`)
    }
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: now() })
  }

  const uniqueCharacterIds = [...new Set((characterIds || []).filter(Boolean))]
  for (const characterId of uniqueCharacterIds) {
    if (episodeCharacterIds.has(characterId)) continue
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
    if (!character || character.dramaId !== dramaId || character.deletedAt) {
      throw new Error(`character_id ${characterId} 不属于当前项目`)
    }
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: now() })
  }

  const uniquePropIds = [...new Set((propIds || []).filter(Boolean))]
  for (const propId of uniquePropIds) {
    if (episodePropIds.has(propId)) continue
    const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
    if (!prop || prop.dramaId !== dramaId || prop.deletedAt) {
      throw new Error(`prop_id ${propId} 不属于当前项目`)
    }
    await db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: now() })
  }
}

type ToolContext = ToolExecutionContext | undefined

const characterStateSchema = z.object({
  outfit: z.string().optional(),
  position: z.string().optional(),
  holding: z.string().optional(),
  emotion: z.string().optional(),
  facing: z.string().optional().describe('朝向/视线方向，如「面向画右」'),
})

/** 导演参数（漫剧流水线升级 4.1 节） */
const dialogueSchema = z.object({ speaker_id: z.string().optional(), speaker: z.string().optional(), text: z.string().optional(), tone: z.string().optional() }).nullable().optional()
  .describe('对口型台词：画面里正在张嘴说话的那一个人。一镜只能有一个人对口型')
const voiceoverSchema = z.array(z.object({
  speaker: z.string().optional(),
  kind: z.string().optional().describe('VO=内心独白/旁白，OS=人在现场但不入镜，DUB=只配音不对口型的角色（簿簿、线团团等）'),
  text: z.string().optional(),
  tone: z.string().optional(),
})).nullable().optional().describe('后期配音的台词，按说出顺序排列，可叠在任何镜头上；不写进 video_prompt')
const onscreenSchema = z.array(z.string()).nullable().optional().describe('剧本 [画面文字] 和名条（如「陆衍｜离婚律师」「大屏：阿缘 0 对」）：后期叠加，不写进 video_prompt')

/** 段内一个镜头 */
const cutSchema = z.object({
  seconds: z.number().describe('本镜头秒数，段内各镜头相加 = 段的 duration'),
  shot_size: z.string().describe('CU|MCU|MS|MWS|WS|EWS'),
  camera_move: z.string().describe('运镜模板 ID，只能选一个'),
  move_speed: z.string().optional(),
  action: z.string().describe('本镜头的单一主动作'),
  start_frame: z.string().optional(),
  end_frame: z.string().optional(),
  dialogue: dialogueSchema,
  voiceover: voiceoverSchema,
  onscreen_text: onscreenSchema,
  purpose: z.string().optional().describe('建立/推进/反应/揭示/转场/情绪落点'),
})

const shotSpecSchema = z.object({
  shot_id: z.string().optional().describe('如 E01-S02-05'),
  scene_code: z.string().describe('所属场，如 E01-S02，必须与 save_scene_continuity 中的 scene_code 一致'),
  shot_size: z.string().optional().describe('CU|MCU|MS|MWS|WS|EWS（段模式写在 cuts 里）'),
  camera_move: z.string().optional().describe('运镜模板 ID，只能选一个（段模式写在 cuts 里）'),
  move_speed: z.string().optional().describe('slow|medium|fast'),
  start_frame: z.string().describe('开始时：谁在什么位置、什么姿势、看向哪里（段模式 = 第一个镜头的开头）'),
  end_frame: z.string().describe('结束时：同上（段模式 = 最后一个镜头的结尾，下一段的首帧就从这一帧截）'),
  action: z.string().optional().describe('镜头内的单一主动作（段模式写在 cuts 里，这里可写本段一句话概要）'),
  dialogue: dialogueSchema,
  voiceover: voiceoverSchema,
  onscreen_text: onscreenSchema,
  cuts: z.array(cutSchema).nullable().optional().describe('段模式：本段（≤15 秒、一次生成）内按顺序切的 2-4 个镜头；有 cuts 时景别/运镜/动作/台词都写在镜头里'),
  continuity_in: z.string().optional().describe('必须与上一镜（段）end_frame 一致的要素'),
  purpose: z.string().optional().describe('建立/推进/反应/揭示/转场/情绪落点'),
  // 宽松接收：模型偶尔把状态写成字符串或嵌套对象，不能因此整批保存失败
  end_state: z.object({
    characters: z.record(z.string(), z.any()).optional(),
    props: z.record(z.string(), z.any()).optional(),
  }).passthrough().optional().describe('本镜结束时人物/道具状态的变化（按角色名），用于更新场记表'),
})

async function sceneStates(episodeId: number): Promise<Map<string, SceneState>> {
  const rows = await db.select().from(schema.sceneContinuity).where(eq(schema.sceneContinuity.episodeId, episodeId))
  const map = new Map<string, SceneState>()
  for (const r of rows) {
    try { map.set(r.sceneCode, JSON.parse(r.state)) } catch { /* 跳过损坏记录 */ }
  }
  return map
}

/** 本集全部分镜的规则检查结果（agent 自查与分镜审阅共用） */
export async function checkEpisodeStoryboards(episodeId: number) {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const rows = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => !sb.deletedAt)
  const [drama] = ep ? await db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)) : []
  let meta: any = {}
  try { meta = JSON.parse(drama?.metadata || '{}') || {} } catch {}
  const script = ep?.scriptContent || ep?.content
  const violations = checkStoryboardRules(
    rows.map(sb => ({ id: sb.id, n: sb.storyboardNumber, duration: sb.duration || 0, spec: parseShotSpec(sb.shotSpec), sceneId: sb.sceneId })),
    {
      pov: isPovScript(script), maxEpisodeSeconds: Number(meta.max_episode_seconds) || undefined, script,
      dubOnly: Array.isArray(meta.dub_only_characters) ? meta.dub_only_characters : undefined,
    },
  )
  return { shots: rows.length, violations }
}

async function dubOnlyCharacters(dramaId: number): Promise<string[]> {
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  try {
    const list = JSON.parse(drama?.metadata || '{}')?.dub_only_characters
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

/** 项目是否按段拆分镜（metadata.segment_mode：一条分镜 = 一段 ≤15 秒、段内 2-4 个镜头、一次生成） */
export async function segmentMode(dramaId: number): Promise<boolean> {
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  try { return JSON.parse(drama?.metadata || '{}')?.segment_mode === true } catch { return false }
}

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

const readStoryboardContext = createTool({
  id: 'read_storyboard_context',
  description: 'Read the screenplay, characters, scenes, and props for storyboard breakdown.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: 'Episode not found' }
    const script = ep.scriptContent || ep.content
    if (!script) return { error: 'Episode has no script' }

    const charLinks = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const sceneLinks = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const propLinks = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))

    const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
    const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))
    const linkedPropIds = new Set(propLinks.map(link => link.propId))

    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId))
    const prps = await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId))
    const existingStoryboards = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const continuityMap = await sceneStates(episodeId)
    const liveSorted = existingStoryboards.filter(sb => !sb.deletedAt).sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    const continuityFor = (sbId: number) => {
      const idx = liveSorted.findIndex(x => x.id === sbId)
      const spec = parseShotSpec(liveSorted[idx]?.shotSpec)
      if (!spec?.scene_code) return null
      const previous = liveSorted.slice(0, idx).map(x => parseShotSpec(x.shotSpec)).filter((p): p is ShotSpec => !!p && p.scene_code === spec.scene_code)
      return continuityAtShot(continuityMap.get(spec.scene_code), previous)
    }

    const characters = chars
      .filter(c => !c.deletedAt)
      .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
      .map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        styling: c.styling || '',
        image_url: c.imageUrl || '',
        reference_images: c.referenceImages || '',
        has_voice: Boolean(c.voiceAudioUrl?.trim()),
        voice_reference: c.voiceAudioUrl?.trim() ? `#${c.name}` : null,
      }))
      // 说话人编号全剧固定：按角色在项目中的创建顺序 S1、S2…
      .map((c) => ({ ...c, speaker_id: `S${chars.filter(x => !x.deletedAt).sort((a, b) => a.id - b.id).findIndex(x => x.id === c.id) + 1}` }))

    const scenes = scns
      .filter(s => !s.deletedAt)
      .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
      .map(s => ({
        id: s.id,
        location: s.location,
        time: s.time,
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        image_url: s.imageUrl || '',
        storyboard_count: s.storyboardCount || 0,
      }))

    const props = prps
      .filter(p => !p.deletedAt)
      .filter(p => !linkedPropIds.size || linkedPropIds.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        image_url: p.imageUrl || '',
      }))

    const existingStoryboardPayload = await Promise.all(existingStoryboards
      .filter(sb => !sb.deletedAt)
      .map(async (sb) => {
        const links = await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
        const sbPropLinks = await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, sb.id))
        return {
          id: sb.id,
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          scene_id: sb.sceneId,
          character_ids: links.map(link => link.characterId),
          available_voice_references: characters
            .filter(c => c.has_voice && links.some(link => link.characterId === c.id))
            .map(c => ({ character_id: c.id, name: c.name, voice_reference: c.voice_reference })),
          prop_ids: sbPropLinks.map(link => link.propId),
          shot_type: sb.shotType || '',
          duration: sb.duration || 0,
          description: sb.description || '',
          atmosphere: sb.atmosphere || '',
          video_prompt: sb.videoPrompt || '',
          shot_spec: parseShotSpec(sb.shotSpec),
          continuity_at_start: continuityFor(sb.id),
        }
      }))

    const payload = {
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      script,
      characters,
      scenes,
      props,
      existing_storyboards: existingStoryboardPayload,
      scene_continuity: [...continuityMap.values()],
      camera_moves: Object.entries(CAMERA_MOVES).map(([id, m]) => ({ id, name: m.name, h3: m.h3, use: m.use })),
      pov_script: isPovScript(script),
      // 只配音不对口型的角色：台词一律写进 shot_spec.voiceover（kind=DUB）
      dub_only_characters: await dubOnlyCharacters(dramaId),
      // true 时按「段」拆：每条分镜 ≤15 秒，shot_spec.cuts 里写段内 2-4 个镜头（见提示词「段模式」）
      segment_mode: await segmentMode(dramaId),
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      existingStoryboards: payload.existing_storyboards.length,
      scriptLength: script.length,
    })
    return payload
  },
})

const storyboardFields = z.object({
  shot_number: z.number(),
  title: z.string().optional(),
  shot_type: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  location: z.string().optional(),
  time: z.string().optional(),
  description: z.string().optional(),
  result: z.string().optional(),
  atmosphere: z.string().optional(),
  image_prompt: z.string().optional(),
  video_prompt: z.string().optional(),
  bgm_prompt: z.string().optional(),
  sound_effect: z.string().optional(),
  duration: z.number().optional(),
  scene_id: z.number().nullable().optional(),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
  shot_spec: shotSpecSchema.optional(),
})

// 段模式：列表里显示各镜头景别/运镜串起来，如 WS→MCU→CU
const specColumns = (spec: any, fallback: { shot_type?: string; movement?: string }) => {
  if (!spec) return {}
  const move = (s: any) => s.camera_move ? `${s.camera_move}${s.move_speed ? '/' + s.move_speed : ''}` : ''
  const cuts: any[] = Array.isArray(spec.cuts) ? spec.cuts : []
  return {
    shotSpec: JSON.stringify(spec),
    shotType: (cuts.length ? cuts.map(c => c.shot_size).filter(Boolean).join('→') : spec.shot_size) || fallback.shot_type,
    movement: (cuts.length ? cuts.map(move).filter(Boolean).join('→') : move(spec)) || fallback.movement,
  }
}

const saveStoryboards = createTool({
  id: 'save_storyboards',
  description: 'Save storyboards for this episode. Call in batches of at most 8 storyboards: the first batch must set replace_existing: true (clears all old storyboards for the episode, then writes), every following batch omits replace_existing (appends). Rows are upserted by shot_number, so overlapping batches and retries never create duplicates.',
  inputSchema: z.object({
    replace_existing: z.boolean().optional(),
    storyboards: z.array(storyboardFields),
  }),
  execute: async ({ storyboards, replace_existing }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const ts = now()
    logTaskProgress('StoryboardTool', 'save-begin', {
      episodeId,
      dramaId,
      replaceExisting: replace_existing === true,
      count: storyboards.length,
      shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
    })
    // Check all voice references before replace_existing can remove the previous storyboards.
    for (const sb of storyboards) {
      await validateVideoPromptVoices(sb.video_prompt, dramaId, sb.character_ids)
    }
    if (replace_existing === true) {
      const existingStoryboardRows = await db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
      for (const storyboardId of existingStoryboardRows.map(sb => sb.id)) {
        await db.delete(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
        await db.delete(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, storyboardId))
      }
      await db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
    }

    // shot_number → id 索引（含本次调用内新增的行），保证按分镜号幂等 upsert
    const existingRows = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const shotToId = new Map<number, number>(
      existingRows.filter(sb => !sb.deletedAt).map(sb => [sb.storyboardNumber, sb.id]),
    )

    for (const sb of storyboards) {
      await validateStoryboardBindings(episodeId, dramaId, sb.scene_id, sb.character_ids, sb.prop_ids)
      const existingId = shotToId.get(sb.shot_number)
      if (existingId !== undefined) {
        await db.update(schema.storyboards).set({
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere, imagePrompt: sb.image_prompt,
          videoPrompt: sb.video_prompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          ...specColumns(sb.shot_spec, sb),
          updatedAt: ts,
        }).where(eq(schema.storyboards.id, existingId))
        await syncStoryboardCharacters(existingId, sb.character_ids || [])
        await syncStoryboardProps(existingId, sb.prop_ids || [])
      } else {
        const res = await db.insert(schema.storyboards).values({
          episodeId,
          storyboardNumber: sb.shot_number,
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere, imagePrompt: sb.image_prompt,
          videoPrompt: sb.video_prompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          ...specColumns(sb.shot_spec, sb),
          createdAt: ts, updatedAt: ts,
        })
        const newId = getInsertId(res)
        shotToId.set(sb.shot_number, newId)
        await syncStoryboardCharacters(newId, sb.character_ids || [])
        await syncStoryboardProps(newId, sb.prop_ids || [])
      }
    }

    // 整集时长 = 当前全部存活分镜时长之和（分批保存时不能再按单批累加）
    const allRows = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const totalDuration = allRows
      .filter(sb => !sb.deletedAt)
      .reduce((sum, sb) => sum + (sb.duration || 0), 0)

    await db.update(schema.episodes)
      .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
      .where(eq(schema.episodes.id, episodeId))

    logTaskSuccess('StoryboardTool', 'save-complete', {
      episodeId,
      count: storyboards.length,
      totalDuration,
    })
    return { message: `Saved ${storyboards.length} storyboards`, count: storyboards.length, total_duration: totalDuration }
  },
})

const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Update a specific storyboard shot.',
  inputSchema: z.object({
    storyboard_id: z.number(),
    title: z.string().optional(),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional(),
    location: z.string().optional(),
    time: z.string().optional(),
    result: z.string().optional(),
    atmosphere: z.string().optional(),
    image_prompt: z.string().optional(),
    video_prompt: z.string().optional(),
    bgm_prompt: z.string().optional(),
    sound_effect: z.string().optional(),
    description: z.string().optional(),
    scene_id: z.number().nullable().optional(),
    character_ids: z.array(z.number()).optional(),
    prop_ids: z.array(z.number()).optional(),
    duration: z.number().optional(),
    shot_spec: shotSpecSchema.optional(),
  }),
  execute: async ({ storyboard_id, ...fields }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id))
    if (!storyboard || storyboard.episodeId !== episodeId || storyboard.deletedAt) return { error: `Storyboard ${storyboard_id} not found in this episode` }

    // 过滤模型回传的垃圾值：视频提示词 Agent 常把整行字段回传，
    // 拿不准的字符串字段写成 "null"/"undefined"，直接覆盖会毁掉已有内容
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const v = fields[key]
      if (typeof v === 'string' && (v === 'null' || v === 'undefined' || v === 'NULL' || v === 'Null')) {
        delete fields[key]
      }
    }

    logTaskProgress('StoryboardTool', 'update-begin', {
      episodeId,
      storyboardId: storyboard_id,
      fields: Object.keys(fields),
    })

    const currentCharacterIds = 'character_ids' in fields
      ? fields.character_ids
      : (await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)))
          .map(link => link.characterId)

    const currentPropIds = 'prop_ids' in fields
      ? fields.prop_ids
      : (await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, storyboard_id)))
          .map(link => link.propId)

    await validateVideoPromptVoices(fields.video_prompt, dramaId, currentCharacterIds)
    await validateStoryboardBindings(
      episodeId,
      dramaId,
      'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
      currentCharacterIds,
      currentPropIds,
    )

    const updates: Record<string, any> = { updatedAt: now() }
    if ('title' in fields) updates.title = fields.title
    if ('shot_type' in fields) updates.shotType = fields.shot_type
    if ('angle' in fields) updates.angle = fields.angle
    if ('movement' in fields) updates.movement = fields.movement
    if ('location' in fields) updates.location = fields.location
    if ('time' in fields) updates.time = fields.time
    if ('result' in fields) updates.result = fields.result
    if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
    if ('image_prompt' in fields) updates.imagePrompt = fields.image_prompt
    if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt
    if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
    if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
    if ('description' in fields) updates.description = fields.description
    if ('scene_id' in fields) updates.sceneId = fields.scene_id
    if ('duration' in fields) updates.duration = fields.duration
    if (fields.shot_spec) Object.assign(updates, specColumns(fields.shot_spec, {}))
    await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id))
    if ('character_ids' in fields) await syncStoryboardCharacters(storyboard_id, fields.character_ids || [])
    if ('prop_ids' in fields) await syncStoryboardProps(storyboard_id, fields.prop_ids || [])
    logTaskSuccess('StoryboardTool', 'update-complete', {
      episodeId,
      storyboardId: storyboard_id,
      updatedFields: Object.keys(updates),
      characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      propIds: 'prop_ids' in fields ? (fields.prop_ids || []).join(',') : undefined,
    })
    return { message: `Storyboard ${storyboard_id} updated` }
  },
})

const saveSceneContinuity = createTool({
  id: 'save_scene_continuity',
  description: 'Save the continuity log (场记表) for each scene of this episode: location, time of day, lighting direction, and every character\'s outfit/position/holding/emotion at the start of the scene, plus prop states. Call before save_storyboards. Upserts by scene_code.',
  inputSchema: z.object({
    scenes: z.array(z.object({
      scene_code: z.string().describe('如 E01-S02'),
      scene_id: z.number().nullable().optional(),
      location: z.string().optional(),
      time_of_day: z.string().optional(),
      lighting: z.string().describe('光源方向、色调，如「主光来自画左的台灯，暖黄；窗外冷蓝」'),
      characters_state: z.record(z.string(), z.any()).describe('按角色名：服装、位置、手持物、情绪、朝向'),
      props_state: z.record(z.string(), z.any()).optional(),
    })),
  }),
  execute: async ({ scenes }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const ts = now()
    for (const scene of scenes) {
      const state = JSON.stringify(scene)
      const [existing] = await db.select().from(schema.sceneContinuity)
        .where(and(eq(schema.sceneContinuity.episodeId, ids.episodeId), eq(schema.sceneContinuity.sceneCode, scene.scene_code)))
      if (existing) await db.update(schema.sceneContinuity).set({ state, updatedAt: ts }).where(eq(schema.sceneContinuity.id, existing.id))
      else await db.insert(schema.sceneContinuity).values({ episodeId: ids.episodeId, sceneCode: scene.scene_code, state, createdAt: ts, updatedAt: ts })
    }
    logTaskSuccess('StoryboardTool', 'save-continuity', { episodeId: ids.episodeId, scenes: scenes.map(s => s.scene_code).join(',') })
    return { message: `Saved continuity for ${scenes.length} scenes` }
  },
})

const checkStoryboardRulesTool = createTool({
  id: 'check_storyboard_rules',
  description: 'Check all saved storyboards of this episode against the director rules (one camera move, shot-size rotation, establishing shot, reaction shots, continuity_in, 5-8s duration, dialogue duration, emotional ending per scene, reveal shot). Returns violations to fix with update_storyboard / save_storyboards.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const result = await checkEpisodeStoryboards(ids.episodeId)
    logTaskProgress('StoryboardTool', 'check-rules', { episodeId: ids.episodeId, shots: result.shots, violations: result.violations.length })
    return result
  },
})

const deleteStoryboard = createTool({
  id: 'delete_storyboard',
  description: 'Delete one storyboard shot of this episode (e.g. a redundant reaction shot or an emotional-ending shot that can be merged into the previous dialogue shot) to bring the episode under its total duration limit. Remaining shots are renumbered in order. Move any dialogue in the deleted shot into a neighbouring shot first.',
  inputSchema: z.object({ storyboard_id: z.number() }),
  execute: async ({ storyboard_id }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id))
    if (!sb || sb.episodeId !== ids.episodeId || sb.deletedAt) return { error: 'Storyboard not found in this episode' }
    const ts = now()
    await db.update(schema.storyboards).set({ deletedAt: ts, updatedAt: ts }).where(eq(schema.storyboards.id, storyboard_id))
    const rest = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, ids.episodeId)))
      .filter(s => !s.deletedAt)
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    for (const [i, s] of rest.entries()) {
      if (s.storyboardNumber !== i + 1) await db.update(schema.storyboards).set({ storyboardNumber: i + 1 }).where(eq(schema.storyboards.id, s.id))
    }
    const total = rest.reduce((t, s) => t + (s.duration || 0), 0)
    logTaskProgress('StoryboardTool', 'delete', { episodeId: ids.episodeId, storyboardId: storyboard_id, shots: rest.length, totalDuration: total })
    return { message: `Deleted shot ${storyboard_id}; ${rest.length} shots remain, total ${total}s` }
  },
})

export const storyboardTools = { readStoryboardContext, saveStoryboards, updateStoryboard, deleteStoryboard, saveSceneContinuity, checkStoryboardRules: checkStoryboardRulesTool }
