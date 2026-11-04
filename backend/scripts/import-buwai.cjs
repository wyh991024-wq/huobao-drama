/**
 * 导入《簿外良缘》剧本资产包：角色/场景/道具（素材图提示词）+ 分镜（分镜/*.json + *.md 的 H3 提示词）+ 细纲
 * 用法：node scripts/import-buwai.cjs <资产包目录> [起始集] [结束集]
 * 视频提示词里的 <Picture N> 换成 @资产名，生成时由前端按实际参考图顺序编号。
 */
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const ROOT = process.argv[2]
const FROM = Number(process.argv[3] || 1)
const TO = Number(process.argv[4] || 10)
if (!ROOT) { console.error('usage: node scripts/import-buwai.cjs <dir> [from] [to]'); process.exit(1) }
const db = new Database(process.env.SQLITE_PATH || path.join(__dirname, '../../data/huobao.sqlite3'))
const now = () => new Date().toISOString()
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')
const TITLE = '簿外良缘'
const STYLE_VALUE = 'buwai-pixar'
const STYLE_PROMPT = '3D animated urban-fantasy rom-com look in a soft Pixar-like style, appealing characters with expressive eyes, warm cozy color palette, clean medium-detail rendering, gentle cinematic lighting'
const SIZE_ZH = { ECU: '大特写', CU: '特写', MCU: '近景', MS: '中景', MWS: '中全景', WS: '全景', EWS: '大远景' }
// 群演按集分组（素材图提示词 C19-A/B/C）
const EXTRA_BY_EP = { 2: 'C19-A', 9: 'C19-B', 10: 'C19-C' }

// ---------- 素材图提示词 ----------
const assetMd = read(fs.readdirSync(ROOT).find(f => /^素材图提示词-.*\d\.md$/.test(f)))
const assets = {} // code -> { kind, name, prompt, note, english }
{
  let kind = '', cur = null, label = null, inBlock = false, buf = []
  for (const line of assetMd.split('\n')) {
    if (line.startsWith('```')) {
      if (inBlock) {
        const text = buf.join('\n').trim()
        if (cur) {
          // 独立资产的子条目（S08-B 走廊反打、C19-A/B/C 群演分组）单独建；其余子条目（C05-A 等）只取第一张当本体
          const separate = label && /^(C19-[A-Z]|S\d+-[A-Z])$/.test(label.code)
          const code = separate ? label.code : cur.code
          const name = !separate ? cur.name : label.code.startsWith('C19') ? `群演${label.code.slice(-1)}` : label.name
          if (!assets[code]) assets[code] = { ...cur, code, prompt: text, name }
        }
        buf = []; label = null
      }
      inBlock = !inBlock; continue
    }
    if (inBlock) { buf.push(line); continue }
    if (/^## 一、角色/.test(line)) kind = 'character'
    else if (/^## 二、场景/.test(line)) kind = 'scene'
    else if (/^## 三、道具/.test(line)) kind = 'prop'
    else if (/^## /.test(line)) kind = ''
    const h = line.match(/^### ((?:C|S|P)\d+(?:-[A-Z])?)\s+(.+)$/)
    if (h && kind) { cur = { kind, code: h[1], name: h[2].replace(/[（(].*$/, '').trim(), note: '' }; continue }
    const l = line.match(/^((?:C|S|P)\d+-[A-Z])\s+(.+)$/)
    if (l && cur) { label = { code: l[1], name: l[2].replace(/[（(].*$/, '').trim() }; continue }
    if (cur && /^要点：/.test(line)) cur.note = line.replace(/^要点：/, '')
  }
  for (const a of Object.values(assets)) {
    const m = a.prompt.match(/Character: ([A-Z][A-Za-z]+)/)
    if (m) a.english = m[1]
  }
}

// ---------- 细纲 ----------
const outline = read(fs.readdirSync(ROOT).find(f => /^05-前10集细纲-\d/.test(f)))
function outlineOf(n) {
  const tag = `E${String(n).padStart(2, '0')}`
  const m = outline.match(new RegExp(`^## ${tag}《[\\s\\S]*?(?=^## )`, 'm'))
  return m ? m[0].trim() : ''
}

// ---------- 导入 ----------
if (db.prepare('select id from dramas where title=? and deleted_at is null').get(TITLE)) {
  console.error(`已存在项目「${TITLE}」，先删掉再导入`); process.exit(1)
}
const t = now()
db.prepare(`insert into style_presets (name, value, prompt, description, sort_order, is_active, created_at, updated_at)
  values (?, ?, ?, ?, 99, 1, ?, ?) on conflict(value) do update set prompt=excluded.prompt, updated_at=excluded.updated_at`)
  .run('簿外良缘 · 软萌 3D', STYLE_VALUE, STYLE_PROMPT, '《簿外良缘》画风句（gen.py 的 V）', t, t)

const tx = db.transaction(() => {
  const dramaId = db.prepare(`insert into dramas (title, description, genre, style, aspect_ratio, total_episodes, status, created_at, updated_at)
    values (?, ?, ?, ?, '9:16', 60, 'draft', ?, ?)`).run(TITLE,
    '被贬下凡的小月老阿缘要在一年内凑满 99 对，第 99 对锁定了不信爱情的离婚律师陆衍——他手上的红线是断的。',
    '都市奇幻爱情喜剧', STYLE_VALUE, t, t).lastInsertRowid

  const ids = {} // code -> db id
  let order = 0
  for (const a of Object.values(assets)) {
    order++
    if (a.kind === 'character') {
      ids[a.code] = db.prepare(`insert into characters (drama_id, name, role, description, appearance, final_prompt, sort_order, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(dramaId, a.name, ['C01', 'C02'].includes(a.code) ? 'main' : 'supporting',
        a.note, a.prompt, a.prompt, order, t, t).lastInsertRowid
    } else if (a.kind === 'scene') {
      ids[a.code] = db.prepare(`insert into scenes (drama_id, location, time, prompt, final_prompt, created_at, updated_at)
        values (?, ?, '', ?, ?, ?, ?)`).run(dramaId, a.name, a.prompt, a.prompt, t, t).lastInsertRowid
    } else if (a.kind === 'prop') {
      ids[a.code] = db.prepare(`insert into props (drama_id, name, type, description, prompt, final_prompt, created_at, updated_at)
        values (?, ?, 'prop', ?, ?, ?, ?, ?)`).run(dramaId, a.name, a.note, a.prompt, a.prompt, t, t).lastInsertRowid
    }
  }
  const resolveCode = (code, ep) => code === 'C19' ? (EXTRA_BY_EP[ep] || 'C19-A') : code
  const nameOf = (code, ep) => assets[resolveCode(code, ep)]?.name

  const sbDir = path.join(ROOT, '分镜')
  const report = []
  for (let ep = FROM; ep <= TO; ep++) {
    const tag = `E${String(ep).padStart(2, '0')}`
    const jf = fs.readdirSync(sbDir).find(f => f.startsWith(tag + '-') && f.endsWith('.json'))
    const md = fs.readFileSync(path.join(sbDir, jf.replace(/\.json$/, '.md')), 'utf8').replace(/\r\n/g, '\n')
    const data = JSON.parse(fs.readFileSync(path.join(sbDir, jf), 'utf8'))

    // 说话人编号 → 名字；表格画面描述；每镜提示词与参考图
    const speakers = {}
    for (const m of (md.match(/^说话人：(.+)$/m)?.[1] || '').matchAll(/S(\d+)\s+([^，；。\s]+)/g)) speakers['S' + m[1]] = m[2]
    const rows = {}
    for (const m of md.matchAll(/^\| (E\d+-\d+) \| [^|]* \| [^|]* \| [^|]* \| ([^|]*) \| ([^|]*) \|/gm)) rows[m[1]] = { picture: m[2].trim(), dialogue: m[3].trim() }
    const prompts = {}
    for (const m of md.matchAll(/^### (E\d+-\d+)（[^）]*）参考图：(.*)\n```\n([\s\S]*?)\n```/gm)) {
      const refs = {}
      for (const r of m[2].matchAll(/图(\d+)=((?:C|S|P)\d+(?:-[A-Z])?)/g)) refs[r[1]] = r[2]
      prompts[m[1]] = m[3].replace(/<Picture (\d+)>/g, (x, n) => refs[n] ? '@' + nameOf(refs[n], ep) : x)
    }

    const shots = data.shots
    const duration = shots.reduce((s, x) => s + x.duration_sec, 0)
    const story = outlineOf(ep)
    const epId = db.prepare(`insert into episodes (drama_id, episode_number, title, content, script_content, description, duration, status, resolution, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, 'draft', '720p', ?, ?)`).run(dramaId, ep, data.title, story, story, story.split('\n')[1] || '', duration, t, t).lastInsertRowid

    const epChars = new Set(), epScenes = new Set()
    const sceneByCode = {}
    for (const sc of data.scenes) sceneByCode[sc.scene_id] = sc
    shots.forEach((s, i) => {
      const sceneCode = s.scene_asset.split(/\s+/)[0]
      const sceneId = ids[sceneCode] ?? null
      if (sceneId) epScenes.add(sceneId)
      else report.push(`${s.shot_id} 找不到场景 ${s.scene_asset}`)
      const scene = sceneByCode[s.scene_id] || {}
      const row = rows[s.shot_id] || {}
      const speaker = s.dialogue ? (speakers[s.dialogue.speaker_id] || '') : ''
      const spec = {
        shot_id: s.shot_id, scene_code: s.scene_id, shot_size: s.shot_size, camera_move: s.camera_move, move_speed: s.move_speed,
        start_frame: s.start_frame, end_frame: s.end_frame, action: s.action,
        dialogue: s.dialogue ? { speaker_id: s.dialogue.speaker_id, speaker, text: s.dialogue.text, tone: s.dialogue.tone } : null,
        continuity_in: s.continuity_in, purpose: s.purpose, thread_pov: !!s.thread_pov,
      }
      const desc = [row.picture, row.dialogue ? `对白：${row.dialogue}` : ''].filter(Boolean).join('\n')
      const sbId = db.prepare(`insert into storyboards (episode_id, scene_id, storyboard_number, title, location, time, shot_type, movement, result, atmosphere,
        video_prompt, description, duration, status, shot_spec, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(epId, sceneId, i + 1, s.shot_id,
        nameOf(sceneCode, ep) || s.scene_asset, scene.time_and_lighting || '', SIZE_ZH[s.shot_size] || s.shot_size, s.camera_move,
        s.end_frame, scene.time_and_lighting || '', prompts[s.shot_id] || '', desc, s.duration_sec, JSON.stringify(spec), t, t).lastInsertRowid
      for (const label of s.characters) {
        const cid = ids[resolveCode(label.split(/\s+/)[0], ep)]
        if (!cid) { report.push(`${s.shot_id} 找不到角色 ${label}`); continue }
        epChars.add(cid)
        db.prepare('insert or ignore into storyboard_characters (storyboard_id, character_id) values (?, ?)').run(sbId, cid)
      }
      if (!prompts[s.shot_id]) report.push(`${s.shot_id} 没有提示词`)
    })
    for (const cid of epChars) db.prepare('insert into episode_characters (episode_id, character_id, created_at) values (?, ?, ?)').run(epId, cid, t)
    for (const sid of epScenes) db.prepare('insert into episode_scenes (episode_id, scene_id, created_at) values (?, ?, ?)').run(epId, sid, t)

    // 场记：分镜 JSON 的 scenes，角色外观按英文名对到本场出场的角色
    for (const sc of data.scenes) {
      const codes = new Set(shots.filter(s => s.scene_id === sc.scene_id).flatMap(s => s.characters.map(c => resolveCode(c.split(/\s+/)[0], ep))))
      const characters_state = {}
      for (const look of Object.values(sc.characters_state || {})) {
        const first = String(look).match(/^[A-Za-z]+/)?.[0]
        const code = [...codes].find(c => assets[c]?.english === first) || [...codes].find(c => String(look).includes(`(${Object.keys(speakers).find(k => speakers[k] === assets[c]?.name)})`))
        if (code) characters_state[assets[code].name] = { outfit: look }
      }
      const sceneCode = sc.location.split(/\s+/)[0]
      const state = { scene_code: sc.scene_id, scene_id: ids[sceneCode] ?? null, location: nameOf(sceneCode, ep) || sc.location,
        time_of_day: sc.time_and_lighting, lighting: sc.time_and_lighting, characters_state }
      db.prepare('insert into scene_continuity (episode_id, scene_code, state, created_at, updated_at) values (?, ?, ?, ?, ?)').run(epId, sc.scene_id, JSON.stringify(state), t, t)
    }
    console.log(`${tag} ${data.title}: ${shots.length} 镜 ${duration}s，角色 ${epChars.size}，场景 ${epScenes.size}，场记 ${data.scenes.length}`)
  }
  console.log('drama_id', dramaId, '资产', Object.values(assets).reduce((m, a) => (m[a.kind] = (m[a.kind] || 0) + 1, m), {}))
  if (report.length) console.log('问题：\n' + report.join('\n'))
})
tx()
