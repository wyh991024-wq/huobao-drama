/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { TRANSIENT_ERROR } from '../services/extraction.js'
import { db, schema } from '../db/index.js'
import { and, eq, isNull } from 'drizzle-orm'
import { checkEpisodeStoryboards } from '../agents/tools/storyboard-tools.js'
import { validAgentTypes } from '../agents/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { mastra } from '../mastra/index.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// Mastra v1.17 的 ToolCallChunk / ToolResultChunk 结构：
// { type: 'tool-call', payload: { toolCallId, toolName, args } }
// { type: 'tool-result', payload: { toolCallId, toolName, result, isError } }
function normalizeToolName(entry: any) {
  return entry?.payload?.toolName
    || entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.payload?.result ?? entry?.result ?? entry?.payload?.output ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  const agent = mastra.getAgent(agentType)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent 不存在')
  }

  const requestContext = buildAgentRequestContext({
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: body.model || undefined,
    textConfigId: body.config_id || undefined,
  })

  const startTime = performance.now()

  try {
    // 中转站偶发「The request could not be processed」等临时错误：重试一次（保存类工具都是覆盖或去重写入）
    const runMessage = async (content: string) => {
      const run = () => agent.generate([{ role: 'user', content }], { maxSteps: 20, requestContext })
      try {
        return await run()
      } catch (err: any) {
        if (!TRANSIENT_ERROR.test(err?.message || '')) throw err
        logTaskError('Agent', `${agentType}-retry`, { error: err?.message })
        await new Promise((r) => setTimeout(r, 3000))
        return run()
      }
    }
    let result: any = await runMessage(message)

    // 分镜拆解：模型常在保存一两批后就结束。由后端续跑，直到它回复「全部完成」或不再新增分镜，
    // 最后再做一轮导演规则自查修正。工具调用记录合并返回。
    if (agentType === 'storyboard_breaker') {
      const countShots = async () => (await db.select({ id: schema.storyboards.id }).from(schema.storyboards)
        .where(and(eq(schema.storyboards.episodeId, Number(episode_id)), isNull(schema.storyboards.deletedAt)))).length
      const merged = { toolCalls: [...(result.toolCalls || [])], toolResults: [...(result.toolResults || [])] }
      const absorb = (r: any) => { merged.toolCalls.push(...(r.toolCalls || [])); merged.toolResults.push(...(r.toolResults || [])) }
      let shots = await countShots()
      for (let round = 1; round <= 8 && shots > 0 && !/全部完成/.test(result.text || ''); round++) {
        logTaskProgress('Agent', 'storyboard-continue', { round, shots })
        const next = await runMessage(`本集已保存 ${shots} 个分镜。请调用 read_storyboard_context 查看剧本与 existing_storyboards，只拆解尚未覆盖的剩余剧情，shot_number 从 ${shots + 1} 开始，用 save_storyboards 追加保存（不要传 replace_existing）。如果剧本已经全部覆盖，不要再保存，直接回复「全部完成」。`)
        absorb(next)
        result = next
        const after = await countShots()
        if (after === shots) break
        shots = after
      }
      const check = await checkEpisodeStoryboards(Number(episode_id))
      if (check.violations.length) {
        logTaskProgress('Agent', 'storyboard-fix-rules', { violations: check.violations.length })
        const fix = await runMessage(`导演规则检查发现 ${check.violations.length} 处问题：${JSON.stringify(check.violations).slice(0, 4000)}。请调用 read_storyboard_context 查看分镜，用 update_storyboard 逐个修正（需要插入新镜头时用 save_storyboards 追加并保持镜号顺序），修完调用 check_storyboard_rules 确认，最后回复「全部完成」。`)
        absorb(fix)
        result = { ...fix, toolCalls: merged.toolCalls, toolResults: merged.toolResults }
      } else {
        result = { ...result, toolCalls: merged.toolCalls, toolResults: merged.toolResults }
      }
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.payload?.args ?? tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent 执行失败')
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, '无效的 Agent 类型')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
