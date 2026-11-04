/**
 * 导演规则与场记表（漫剧流水线升级第一步）
 *
 * - shot_spec：每个分镜的结构化导演参数（景别、运镜、起止画面、主动作、台词、衔接、叙事作用）
 * - scene_continuity：每场的场记状态（服装、位置、手持物、情绪、光线方向、道具状态），
 *   按镜头的 end_state 逐镜累加，生成提示词时注入，减少跳戏
 * - checkStoryboardRules：能自动判定的导演规则检查，供分镜 agent 自查与分镜审阅关卡展示
 */

export const SHOT_SIZES = ['CU', 'MCU', 'MS', 'MWS', 'WS', 'EWS'] as const
export type ShotSize = typeof SHOT_SIZES[number]

/** 运镜模板库：每镜只选一个，H3 提示词使用对应英文写法 */
export const CAMERA_MOVES: Record<string, { name: string; h3: string; use: string }> = {
  STATIC: { name: '固定', h3: 'camera locked', use: '对白、表演为主' },
  PUSH_SLOW: { name: '慢推', h3: 'slow push-in from medium to close-up', use: '情绪积累、内心变化' },
  PUSH_FAST: { name: '急推', h3: 'fast push-in to extreme close-up', use: '揭示、震惊' },
  PULL: { name: '拉远', h3: 'slow pull-back revealing the room', use: '孤独、揭示环境' },
  TRUCK: { name: '横移', h3: 'camera trucks left alongside her', use: '跟随行走、展示空间' },
  FOLLOW: { name: '背跟', h3: 'camera follows behind her at shoulder height', use: '进入新空间' },
  CRANE_UP: { name: '升', h3: 'camera cranes up and away', use: '结尾、抽离' },
  CRANE_DOWN: { name: '降', h3: 'camera cranes down into the scene', use: '开场建立' },
  ORBIT: { name: '半环绕', h3: 'slow half orbit around them', use: '关系确立、高光时刻' },
  TILT: { name: '摇', h3: 'slow tilt up from her shoes to her face', use: '角色登场' },
  RACK: { name: '变焦点', h3: 'rack focus from foreground object to her face', use: '信息转移' },
  HANDHELD: { name: '手持', h3: 'subtle handheld shake', use: '紧张、混乱' },
  WHIP: { name: '甩镜', h3: 'quick whip pan to the right', use: '转场、喜剧节奏' },
  DOLLY_ZOOM: { name: '希区柯克变焦', h3: 'dolly zoom', use: '只用于全集最大反转' },
}

export const PURPOSES = ['建立', '推进', '反应', '揭示', '转场', '情绪落点'] as const

export interface ShotSpec {
  shot_id?: string
  scene_code?: string
  shot_size?: string
  camera_move?: string
  move_speed?: 'slow' | 'medium' | 'fast' | string
  start_frame?: string
  end_frame?: string
  action?: string
  dialogue?: { speaker_id?: string; speaker?: string; text?: string; tone?: string } | null
  continuity_in?: string
  purpose?: string
  /** 本镜结束时人物/道具状态的变化，按角色名写，未写的保持不变 */
  end_state?: { characters?: Record<string, Partial<CharacterState>>; props?: Record<string, string> }
}

export interface CharacterState { outfit?: string; position?: string; holding?: string; emotion?: string; facing?: string; note?: string }
export interface SceneState {
  scene_code: string
  scene_id?: number | null
  location?: string
  time_of_day?: string
  lighting?: string
  characters_state?: Record<string, CharacterState>
  props_state?: Record<string, string>
}

export function parseShotSpec(raw: unknown): ShotSpec | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw as ShotSpec
  try {
    const v = JSON.parse(String(raw))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/** 模型常附带的说明字段，不是角色/道具名 */
const NOTE_KEYS = new Set(["reason", "note", "notes", "说明", "备注"])

/** 某个镜头开始时的场记 = 场景初始状态 + 本场此前各镜 end_state 依次叠加 */
export function continuityAtShot(scene: SceneState | undefined, previousSpecs: ShotSpec[]): SceneState | null {
  if (!scene) return null
  const state: SceneState = JSON.parse(JSON.stringify(scene))
  state.characters_state ||= {}
  state.props_state ||= {}
  for (const spec of previousSpecs) {
    for (const [name, change] of Object.entries(spec.end_state?.characters || {})) {
      if (NOTE_KEYS.has(name)) continue
      // 模型偶尔把变化写成一句话：保留为备注，不丢信息
      const patch = change && typeof change === "object" ? change : { note: String(change) }
      state.characters_state[name] = { ...(state.characters_state[name] || {}), ...patch }
    }
    for (const [name, value] of Object.entries(spec.end_state?.props || {})) {
      if (NOTE_KEYS.has(name)) continue
      state.props_state[name] = typeof value === "string" ? value : JSON.stringify(value)
    }
  }
  return state
}

export interface RuleShot {
  id?: number
  n: number
  duration: number
  spec: ShotSpec | null
}
export interface RuleViolation { shot?: number; rule: string; message: string }

const isDialogue = (spec: ShotSpec | null) => !!spec?.dialogue?.text?.trim()
const speakerOf = (spec: ShotSpec | null) => (spec?.dialogue?.speaker_id || spec?.dialogue?.speaker || '').trim()

/**
 * 自动检查导演规则（能从结构化字段判定的部分）。
 * 轴线、视线匹配需要看画面，交给分镜 agent 自觉遵守和人工审阅。
 * pov=true（剧本拍摄要求为第一视角）时，不要求以全景建立空间。
 */
export function checkStoryboardRules(shots: RuleShot[], opts: { pov?: boolean } = {}): RuleViolation[] {
  const out: RuleViolation[] = []
  const sorted = [...shots].sort((a, b) => a.n - b.n)
  let hasReveal = false

  sorted.forEach((shot, i) => {
    const spec = shot.spec
    const prev = sorted[i - 1]
    const next = sorted[i + 1]
    const sameSceneAsPrev = !!prev && (prev.spec?.scene_code || '') === (spec?.scene_code || '')
    const lastInScene = !next || (next.spec?.scene_code || '') !== (spec?.scene_code || '')

    if (!spec) { out.push({ shot: shot.n, rule: '结构化', message: '缺少导演参数（shot_spec）' }); return }

    // 规则 1：一镜一个主动作、一种运镜
    if (!spec.camera_move || !CAMERA_MOVES[spec.camera_move]) {
      out.push({ shot: shot.n, rule: '运镜', message: `运镜「${spec.camera_move || '空'}」不在模板库内，只能从 ${Object.keys(CAMERA_MOVES).join('/')} 中选一个` })
    }
    if (!spec.action?.trim()) out.push({ shot: shot.n, rule: '主动作', message: '缺少本镜的单一主动作' })
    if (!spec.start_frame?.trim() || !spec.end_frame?.trim()) out.push({ shot: shot.n, rule: '起止画面', message: '缺少 start_frame 或 end_frame' })

    // 规则 2：景别轮换；每场以 WS/MWS 建立空间
    if (spec.shot_size && !(SHOT_SIZES as readonly string[]).includes(spec.shot_size)) {
      out.push({ shot: shot.n, rule: '景别', message: `景别「${spec.shot_size}」不在 ${SHOT_SIZES.join('/')} 内` })
    }
    if (sameSceneAsPrev && prev.spec?.shot_size && prev.spec.shot_size === spec.shot_size) {
      out.push({ shot: shot.n, rule: '景别轮换', message: `与上一镜景别相同（${spec.shot_size}）` })
    }
    if (!sameSceneAsPrev && !opts.pov && spec.shot_size && !['WS', 'MWS', 'EWS'].includes(spec.shot_size)) {
      out.push({ shot: shot.n, rule: '建立镜头', message: `本场第一镜应以 WS 或 MWS 建立空间，当前为 ${spec.shot_size}` })
    }

    // 规则 3：对话要有反应镜头，不连续两镜同一人说话
    if (sameSceneAsPrev && isDialogue(spec) && isDialogue(prev.spec) && speakerOf(spec) && speakerOf(spec) === speakerOf(prev.spec)) {
      out.push({ shot: shot.n, rule: '反应镜头', message: `连续两镜都是 ${speakerOf(spec)} 说话，中间应插入对方的反应镜头` })
    }

    // 规则 6：衔接
    if (sameSceneAsPrev && !spec.continuity_in?.trim()) {
      out.push({ shot: shot.n, rule: '动作衔接', message: '缺少 continuity_in（与上一镜 end_frame 一致的要素）' })
    }

    // 规则 7：时长 4-8 秒；对白镜时长 ≥ 字数 × 0.25 + 1
    if (shot.duration < 4 || shot.duration > 8) out.push({ shot: shot.n, rule: '时长', message: `时长 ${shot.duration} 秒，应在 4-8 秒` })
    if (isDialogue(spec)) {
      const chars = spec.dialogue!.text!.replace(/[\s，。！？、…,.!?「」"'“”]/g, '').length
      const need = Math.ceil(chars * 0.25 + 1)
      if (shot.duration < need) out.push({ shot: shot.n, rule: '对白时长', message: `台词 ${chars} 字需要至少 ${need} 秒，当前 ${shot.duration} 秒` })
    }

    // 规则 8：每场结尾给情绪落点，不以对白直接切场
    if (lastInScene && isDialogue(spec)) {
      out.push({ shot: shot.n, rule: '情绪落点', message: '本场最后一镜是对白，应补一镜 CU 表情或意象空镜作为情绪落点' })
    }

    // 规则 9：揭示镜头
    if (spec.purpose === '揭示' && ['PUSH_SLOW', 'PUSH_FAST', 'DOLLY_ZOOM'].includes(spec.camera_move || '')) hasReveal = true
  })

  if (sorted.length && !hasReveal) {
    out.push({ rule: '揭示镜头', message: '全集缺少揭示镜头：反转处应有一镜 purpose=揭示、运镜为 PUSH_SLOW 或 PUSH_FAST 推到 CU' })
  }
  return out
}

/** 剧本「【拍摄要求】」写了第一视角/主观镜头 */
export function isPovScript(script: string | null | undefined): boolean {
  const m = String(script || '').match(/【拍摄要求】[^\n]*/)
  return !!m && /第一视角|主观镜头|POV/i.test(m[0])
}
