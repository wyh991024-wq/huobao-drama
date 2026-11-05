/**
 * 成片增强：对已生成的分镜视频做超分＋补帧（ComfyUI enhanceWorkflow，默认 SeedVR2 + RIFE，见 docs/comfyui.md）
 *
 * 增强结果作为该分镜的一条新视频任务（referenceMode=enhance）落库，完成后照常回写分镜视频；原片保留在任务历史里。
 * 很慢（4090 上 5 秒镜头约 4-5 分钟），适合镜头定稿后再做，不对草稿批量跑。
 */
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { generateVideo } from './generation.js'

function parseJson(raw: string | null | undefined): any {
  try { return raw ? JSON.parse(raw) : {} } catch { return {} }
}

/** 带 enhanceWorkflow 的 ComfyUI 视频配置：优先原片所用配置，其次任一启用中的 */
async function enhanceConfigId(preferredId?: number | null): Promise<number> {
  const rows = (await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, 'video')))
    .filter(r => r.provider === 'comfyui' && r.isActive !== false && parseJson(r.settings).enhanceWorkflow)
  const hit = rows.find(r => r.id === preferredId) || rows.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
  if (!hit) throw new Error('没有配置成片增强工作流：请在 ComfyUI 视频配置的 settings 里设置 enhanceWorkflow')
  return hit.id
}

/** 分镜当前最新的成片视频任务（已完成且有本地文件） */
async function latestCompletedVideo(storyboardId: number) {
  const [task] = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, storyboardId), eq(schema.sysTask.status, 'completed')))
    .orderBy(desc(schema.sysTask.id)).limit(1)
  return task && task.localPath ? task : null
}

export async function enhanceStoryboardVideo(storyboardId: number, opts: { configId?: number } = {}) {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb || sb.deletedAt) throw new Error('分镜不存在')
  const source = await latestCompletedVideo(storyboardId)
  if (!source) throw new Error('该分镜还没有生成完成的视频')
  const params = parseJson(source.params)
  if (params.referenceMode === 'enhance') throw new Error('该分镜的最新视频已经增强过')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  const configId = opts.configId || await enhanceConfigId(source.configId)
  const id = await generateVideo({
    storyboardId,
    dramaId: source.dramaId ?? ep?.dramaId,
    prompt: `成片增强（超分＋补帧）：源任务 #${source.id}`,
    referenceMode: 'enhance',
    referenceVideoUrls: [source.localPath!],
    duration: params.duration ?? sb.duration ?? undefined,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    generateAudio: true,
    configId,
    forceNew: true,
  })
  return { task_id: id, source_task_id: source.id }
}

/** 整集：给最新视频还没增强过的分镜逐个提交增强 */
export async function enhanceEpisodeVideos(episodeId: number, opts: { configId?: number } = {}) {
  const shots = (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => !sb.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const started: { storyboard_id: number; task_id: number }[] = []
  const skipped: { storyboard_id: number; reason: string }[] = []
  for (const sb of shots) {
    try {
      const r = await enhanceStoryboardVideo(sb.id, opts)
      started.push({ storyboard_id: sb.id, task_id: r.task_id })
    } catch (e: any) {
      skipped.push({ storyboard_id: sb.id, reason: e.message })
    }
  }
  return { started, skipped }
}
