/**
 * 《簿外良缘》E01–E10 可拍性改写（依据资产包 07-可拍性审查-E01-E10-2026-11-04.md）
 * - 拆镜：一镜一个动作；坠落、碰撞、连环出糗拆成"起因 → 冲击 → 结果"
 * - 简化动作、动作对象入画、纸面文字留空、难画特效标注后期
 * - 2 秒镜头改 3 秒；台词镜头按字数补足时长（字数 × 0.25 + 1.5 秒，上限 10 秒）
 * - 补资产：阿缘·保洁装（E04 卧底）、簿簿·无脸（凡人视角）
 * - 清空视频提示词，交给提示词 agent 按新规则重写（E01-01a/b/c 是手工调好的，保留）
 * 改写前把全部分镜备份到 data/backups/。用法：node scripts/buwai-shootability-e01-e10.cjs <drama_id>
 */
const fs = require('fs')
const path = require('path')
const { restyle } = require('./buwai-style.cjs')
const db = new (require('better-sqlite3'))(process.env.SQLITE_PATH || path.join(__dirname, '../../data/huobao.sqlite3'))
const dramaId = Number(process.argv[2])
if (!dramaId) { console.error('usage: node scripts/buwai-shootability-e01-e10.cjs <drama_id>'); process.exit(1) }
const now = new Date().toISOString()

const episodes = db.prepare('select id, episode_number n from episodes where drama_id=? and deleted_at is null').all(dramaId)
const epByN = Object.fromEntries(episodes.map(e => [e.n, e.id]))
const loadShots = () => db.prepare(`select s.* from storyboards s join episodes e on e.id=s.episode_id where e.drama_id=? and s.deleted_at is null`).all(dramaId)

// 备份
const backupDir = path.join(__dirname, '../../data/backups')
fs.mkdirSync(backupDir, { recursive: true })
const backupFile = path.join(backupDir, `buwai-storyboards-before-shootability-${now.replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(backupFile, JSON.stringify({
  storyboards: loadShots(),
  storyboard_characters: db.prepare(`select sc.* from storyboard_characters sc join storyboards s on s.id=sc.storyboard_id join episodes e on e.id=s.episode_id where e.drama_id=?`).all(dramaId),
}, null, 1))

const chars = () => Object.fromEntries(db.prepare('select id, name from characters where drama_id=? and deleted_at is null').all(dramaId).map(c => [c.name, c.id]))
const SIZE_ZH = { ECU: '大特写', CU: '特写', MCU: '近景', MS: '中景', MWS: '中全景', WS: '全景', EWS: '大远景' }

function findShot(shotId) {
  const hit = loadShots().find(s => { try { return JSON.parse(s.shot_spec).shot_id === shotId } catch { return false } })
  if (!hit) throw new Error('找不到分镜 ' + shotId)
  return hit
}
function setChars(sbId, names) {
  const map = chars()
  db.prepare('delete from storyboard_characters where storyboard_id=?').run(sbId)
  for (const n of names) {
    if (!map[n]) throw new Error('找不到角色 ' + n)
    db.prepare('insert or ignore into storyboard_characters (storyboard_id, character_id) values (?, ?)').run(sbId, map[n])
  }
}
function describe(desc, spec) {
  return [desc, spec.dialogue?.text ? `对白：${spec.dialogue.speaker || ''}：${spec.dialogue.text}` : ''].filter(Boolean).join('\n')
}
/** 改一镜：p 里的 start/action/end/duration/size/desc/chars/dialogue/thread_pov 覆盖原值 */
function upd(shotId, p) {
  const sb = findShot(shotId)
  const spec = JSON.parse(sb.shot_spec)
  if (p.start) spec.start_frame = p.start
  if (p.action) spec.action = p.action
  if (p.end) spec.end_frame = p.end
  if (p.size) spec.shot_size = p.size
  if (p.dialogue !== undefined) spec.dialogue = p.dialogue
  if (p.thread_pov !== undefined) spec.thread_pov = p.thread_pov
  if (p.shot_id) spec.shot_id = p.shot_id
  spec.shootability = 'E01-E10 可拍性改写 2026-11-05'
  const desc = p.desc ? describe(p.desc, spec) : sb.description
  db.prepare(`update storyboards set shot_spec=?, description=?, duration=?, shot_type=?, result=?, title=?, video_prompt='', updated_at=? where id=?`)
    .run(JSON.stringify(spec), desc, p.duration ?? sb.duration, SIZE_ZH[spec.shot_size] || sb.shot_type, spec.end_frame, spec.shot_id, now, sb.id)
  if (p.chars) setChars(sb.id, p.chars)
  return sb.id
}
/** 拆镜：第一段沿用原分镜，其余插在后面，后续镜号顺延 */
function split(shotId, parts) {
  const sb = findShot(shotId)
  const base = JSON.parse(sb.shot_spec)
  db.prepare('update storyboards set storyboard_number = storyboard_number + ?, updated_at=? where episode_id=? and storyboard_number > ? and deleted_at is null')
    .run(parts.length - 1, now, sb.episode_id, sb.storyboard_number)
  const ids = []
  parts.forEach((p, i) => {
    const id = `${shotId}${'abcdefg'[i]}`
    if (i === 0) { ids.push(upd(shotId, { ...p, shot_id: id })); return }
    const spec = { ...base, shot_id: id, shot_size: p.size || base.shot_size, start_frame: p.start, action: p.action, end_frame: p.end,
      dialogue: p.dialogue ?? null, thread_pov: !!p.thread_pov, continuity_in: 'cut on action', shootability: 'E01-E10 可拍性改写 2026-11-05' }
    const newId = db.prepare(`insert into storyboards (episode_id, scene_id, storyboard_number, title, location, time, shot_type, movement, result, atmosphere,
      video_prompt, description, duration, status, shot_spec, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'pending', ?, ?, ?)`)
      .run(sb.episode_id, sb.scene_id, sb.storyboard_number + i, id, sb.location, sb.time, SIZE_ZH[spec.shot_size] || sb.shot_type, spec.camera_move,
        spec.end_frame, sb.atmosphere, describe(p.desc, spec), p.duration, JSON.stringify(spec), now, now).lastInsertRowid
    setChars(newId, p.chars)
    ids.push(newId)
  })
  return ids
}

const tx = db.transaction(() => {
  // ---------- 补资产 ----------
  const ayuan = db.prepare('select * from characters where drama_id=? and name=?').get(dramaId, '阿缘')
  const bubu = db.prepare('select * from characters where drama_id=? and name=?').get(dramaId, '簿簿')
  const addChar = (name, prompt, note, sort) => {
    if (chars()[name]) return
    db.prepare(`insert into characters (drama_id, name, role, description, appearance, final_prompt, sort_order, created_at, updated_at) values (?, ?, 'supporting', ?, ?, ?, ?, ?, ?)`)
      .run(dramaId, name, note, prompt, prompt, sort, now, now)
  }
  addChar('阿缘·保洁装', ayuan.final_prompt.replace(
    /wearing a faded red hoodie with front pockets and a canvas tote bag stuffed with balls of ordinary fuzzy red knitting yarn, matte and not glowing/,
    'disguised as an office cleaner: a plain grey-blue cleaning uniform with an apron, a white face mask pulled down under her chin, rubber gloves, the same messy bun with the strand of red yarn'),
    'E04 律所卧底扮保洁，脸和发型同阿缘', (ayuan.sort_order || 1) + 0.5)
  addChar('簿簿·无脸', restyle('Single 3D rendered prop on plain off-white background: the same small palm-sized worn old booklet with a fuzzy faded red cloth cover and a spine stitched with red thread, plain cover with no face and no markings, an ordinary shabby notebook, shown closed and half-open. Square 1:1. 3D animated urban-fantasy rom-com look in a soft Pixar-like style, appealing characters with expressive eyes, warm cozy color palette, clean medium-detail rendering, gentle cinematic lighting, no text, no logo, no watermark', true),
    '凡人视角下的簿簿：普通旧册子，没有墨迹脸', (bubu.sort_order || 5) + 0.5)
  const ep4Chars = db.prepare('select character_id from episode_characters where episode_id=?').all(epByN[4]).map(r => r.character_id)
  if (!ep4Chars.includes(chars()['阿缘·保洁装'])) db.prepare('insert into episode_characters (episode_id, character_id, created_at) values (?, ?, ?)').run(epByN[4], chars()['阿缘·保洁装'], now)
  if (!db.prepare('select 1 from episode_characters where episode_id=? and character_id=?').get(epByN[6], chars()['簿簿·无脸'])) db.prepare('insert into episode_characters (episode_id, character_id, created_at) values (?, ?, ?)').run(epByN[6], chars()['簿簿·无脸'], now)

  // ---------- E01 ----------
  upd('E01-03', { action: 'he absent-mindedly straightens his watch buckle out of habit, not looking at it, and the watch face slides over the spot on his left wrist', desc: '阿缘视角：他习惯性把表扣摆正，表盘恰好盖住手腕（断红线后期叠加）' })
  upd('E01-04', { action: 'the last row of the ranking screen flashes red; all the yarn-ball sprites turn their heads at once to stare at her', end: 'Ayuan stands alone in the middle, the yarn balls all staring at her', desc: '天庭月老部，线团团挤在考核大屏下，只有阿缘一个人形；最后一行亮红灯，线团团齐刷刷转头看她（大屏文字后期贴）' })
  upd('E01-10', { action: 'he slides a worn little booklet and an old smartphone across the desk toward the camera', end: 'the booklet and the phone stop at the near edge of the desk', desc: '太白金星把旧册子和工作机推过桌面，滑到画面近处的桌沿' })
  upd('E01-11', { start: "the worn booklet lying in Ayuan's hands, the ink eyes on its cover closed", action: 'the ink eyes on the cover slowly open and look her up and down', end: 'the ink eyes squint at her skeptically', desc: '册子在她手里，封面上的墨迹眼睛睁开，上下打量她——簿簿' })
  upd('E01-12', { action: 'he wipes batter off his sleeve while talking to Old Ma, then glances up toward a high window', end: 'he looks up toward the high window, unimpressed', desc: '陆衍边擦袖子上的面糊边对老马说话，然后抬头望向高处的窗户' })

  // ---------- E02 ----------
  upd('E02-01', { start: 'Ayuan standing in the residential courtyard, a few neighbors going about their business in the distance', action: 'she slowly turns her head from one side of the courtyard to the other, her eyes widening', end: "Ayuan's jaw drops", desc: '阿缘站在小区院子里环顾，远处几位街坊各忙各的；她越看眼睛瞪得越大（仙光后期叠加）' })
  upd('E02-05', { action: 'the two security-guard brothers push the pushy salesman out through the gate between them', end: 'the salesman stumbles out of the frame', desc: '门神兄弟一人一边把推销员推出大门，推销员踉跄出画' })
  upd('E02-06', { duration: 3 })
  upd('E02-15', { action: 'she snaps open a blank matchmaking sign-up sheet in front of Ayuan and grins smugly', desc: '土地婆婆从阿缘身后冒出来，抖开一张相亲大会报名表，得意地笑（报名表上的名字后期贴）' })

  // ---------- E03 ----------
  const e0306 = JSON.parse(findShot('E03-06').shot_spec).dialogue
  split('E03-06', [
    { start: "Ayuan's point of view through the narrow door gap: Su Qing and Fang Lei sit facing each other across the meeting table", action: 'Su Qing stares coldly at Fang Lei while he keeps his head down', end: 'the two of them in tense silence', duration: 3, size: 'MS', dialogue: null, thread_pov: true, chars: ['苏晴', '方磊'], desc: '阿缘视角越过门缝看会议桌两边的苏晴和方磊（两人手腕间的红线后期叠加）' },
    { start: 'Ayuan peeking through the door gap, the booklet held up beside her face', action: 'she whispers to the booklet with certainty', end: 'she nods firmly', duration: 7, size: 'MCU', dialogue: e0306, chars: ['阿缘', '簿簿'], desc: '阿缘在门缝边，对着簿簿笃定地低声说' },
  ])
  upd('E03-15', { start: 'Lu Yan back in his seat beside Su Qing', action: "he speaks low to her, glancing at Fang Lei's briefcase", end: 'Su Qing nods slowly', desc: '陆衍已回到苏晴身边坐下，压低声音交代，瞥了一眼方磊的公文包' })

  // ---------- E04（阿缘卧底，换保洁装） ----------
  upd('E04-01', { chars: ['阿缘·保洁装'] })
  upd('E04-03', { chars: ['阿缘·保洁装', '陆衍'] })
  upd('E04-04', { start: "over-the-shoulder from behind the cleaner's shoulder: Lu Yan faces her, the mop handle between them", action: 'he grabs the mop handle she is holding and leans in, eyes narrowing', end: 'he opens his mouth to finish', chars: ['陆衍', '阿缘·保洁装'], desc: '过肩镜头：前景是扮保洁的阿缘肩膀和拖把杆，陆衍伸手抓住拖把杆，凑近眯起眼' })
  upd('E04-05', { action: 'she yanks the mop free and dashes through the fire exit door', end: 'the fire exit door swings shut behind her', chars: ['阿缘·保洁装'], desc: '她一把夺回拖把，冲进消防门（保洁车留在走廊）' })
  upd('E04-07', { chars: ['阿缘·保洁装', '簿簿'] })

  // ---------- E05 ----------
  split('E05-04', [
    { start: "Fang Lei's briefcase on his lap", action: 'the briefcase tips sideways and a dented old tin biscuit box slides out and drops to the floor', end: 'the tin box lands on the floor', duration: 3, dialogue: null, thread_pov: true, chars: ['方磊'], desc: '方磊腿上的公文包一歪，旧铁皮饼干盒滑出来掉在地上（红线拽包后期叠加）' },
    { start: 'the dented tin box lying on the floor', action: 'its lid pops open and about thirty small yellow sticky notes spill out across the floor', end: 'the sticky notes scattered around the open box', duration: 3, size: 'CU', dialogue: null, thread_pov: false, chars: ['方磊'], desc: '盒盖弹开，三十来张黄便利贴散在地上（便利贴上的字后期贴）' },
  ])
  const e0507 = JSON.parse(findShot('E05-07').shot_spec).dialogue
  split('E05-07', [
    { start: 'Su Qing holds the mediation agreement', action: 'she tears it in half and turns to Lu Yan', end: 'she looks at Lu Yan with tears in her eyes', duration: 4, size: 'MS', dialogue: e0507, thread_pov: false, chars: ['苏晴', '陆衍'], desc: '苏晴把调解协议撕成两半，转向陆衍' },
    { start: 'Ayuan sitting on the bench outside the glass wall', action: 'she reaches out and gives a gentle hooking motion with one finger', end: 'she smiles softly', duration: 3, size: 'MS', dialogue: null, thread_pov: true, chars: ['阿缘'], desc: '玻璃墙外的长椅上，阿缘伸手轻轻一勾，然后微微一笑（红线打结后期叠加）' },
  ])
  upd('E05-09', { duration: 3 })
  upd('E05-10', { action: 'the ink eyes peek over the edge of the open page and stare at the phone, puzzled', desc: '簿簿翻开着，墨迹眼睛从页边探出来盯着手机，一脸疑惑' })
  upd('E05-14', { action: 'she tugs her sleeve down over her wrist', duration: 3, desc: '阿缘的手腕和口袋里露出的工作机，她把袖子往下拽盖住手腕（仙光闪烁、手机黄屏后期叠加）' })

  // ---------- E06 ----------
  upd('E06-04', { chars: ['陆衍', '阿缘', '簿簿·无脸'], desc: '陆衍站在她面前，在他眼里她手里的就是一本普通旧册子' })
  upd('E06-10', { duration: 3 })
  upd('E06-14', { action: 'he gestures to Ayuan as if introducing her', end: 'Lu Yan gives a cool nod', desc: '太白金星端着保温杯走过来，向陆衍介绍阿缘；陆衍冷淡地点头' })
  upd('E06-15', { start: 'Taibai turns to Ayuan beside him as Lu Yan walks away', chars: ['太白金星·物业', '阿缘'], desc: '陆衍走远，太白金星转向身边的阿缘，压低声音说' })

  // ---------- E07 ----------
  upd('E07-01', { action: 'he slaps a blank paper bill on the counter in front of Ayuan', desc: '老马把一张纸条拍在阿缘面前（金额后期贴）' })
  upd('E07-11', { action: 'Sister Liu walks away down the lane while Old Ma watches her go; Professor Zhou stands at the building door directly behind Old Ma, half hidden by him', end: 'all three hold their positions', desc: '刘姐沿巷子走远，老马目送；周教授站在老马正后方的楼门口，被他挡住一半（红线走向全部后期画）' })
  upd('E07-16', { duration: 3 })

  // ---------- E08 ----------
  split('E08-01', [
    { start: 'Ayuan standing by the pancake cart', action: 'she lifts one finger and gives a small hooking motion toward Sister Liu', end: 'she holds her breath', duration: 3, size: 'MCU', dialogue: null, thread_pov: true, chars: ['阿缘'], desc: '阿缘站在煎饼摊旁，朝刘姐的方向手指一勾，屏住呼吸' },
    { start: 'Sister Liu at the cart looking at Old Ma', action: 'she suddenly blushes and lowers her eyes while Old Ma freezes with his spatula in mid-air', end: 'Old Ma frozen, spatula raised', duration: 4, size: 'MS', dialogue: null, thread_pov: false, chars: ['刘姐', '老马'], desc: '刘姐看着老马突然脸红低下眼，老马铲子停在半空（硬打结后期叠加）' },
  ])
  upd('E08-02', { action: 'Old Ma flips a blackened pancake while Lu Yan on his stool chews a burnt one with a pained face', desc: '刘姐在摊前笑，老马手忙脚乱翻起一张焦黑的煎饼；陆衍坐在小凳上嚼着糊煎饼一脸痛苦' })
  upd('E08-03', { action: 'she pauses at the cart, blinks and looks confused', desc: '第二天早上，刘姐走到摊前，愣了一下眨眨眼（结崩开、线弹回周教授后期叠加）' })
  upd('E08-11', { action: 'he hands two pancakes over to them', desc: '老马看着刘姐和周教授，把两张煎饼递过去' })

  // ---------- E09 ----------
  upd('E09-02', { desc: '陆衍穿西装僵硬地站在人群边，胸前歪贴着一张名牌（名字后期贴），转头对身边的阿缘说' })
  split('E09-03', [
    { start: 'a blind-date woman sitting on stage holding a teacup across from Lu Yan', action: 'the teacup in her hands cracks with a sharp snap', end: 'she stares at the cracked cup', duration: 3, size: 'MCU', dialogue: null, chars: ['群演B'], desc: '台上相亲的女士手里的茶杯啪地裂开' },
    { start: 'Lu Yan and the woman sitting on stage, Granny Earth beaming beside them', action: "the woman's chair leg snaps; she stumbles up and walks off the stage", end: 'Lu Yan sits alone on stage with a blank face', duration: 4, size: 'MS', dialogue: null, chars: ['陆衍', '土地婆婆', '群演B'], desc: '女士的椅子腿一断，她踉跄起身下台，陆衍面无表情独坐台上（话筒啸叫用音效）' },
  ])
  split('E09-09', [
    { start: "Linlin's book slipping off her lap onto the ground", action: 'Ayuan picks it up and hands it to Xiao Zhou instead of Linlin', end: 'Xiao Zhou holds the book', duration: 4, size: 'MS', dialogue: null, thread_pov: false, chars: ['阿缘', '小周', '林林'], desc: '林林的书滑落，阿缘捡起来递给了小周' },
    { start: 'Xiao Zhou holding the book next to Linlin', action: 'he turns and hands it to Linlin; their eyes meet and they both smile', end: 'the two of them laughing together', duration: 4, size: 'MS', dialogue: null, thread_pov: true, chars: ['小周', '林林'], desc: '小周转身把书递给林林，两人相视一笑（红线打结后期叠加）' },
  ])
  upd('E09-10', { action: "two matched pairs on stage stand up at the same time and walk off in opposite directions while Granny Earth's smile collapses", end: 'Granny Earth alone on stage holding her clipboard', desc: '台上两对同时起身，各走各的；土地婆婆的笑容垮掉' })
  upd('E09-13', { action: 'her hand holding the phone trembles', duration: 3, desc: '阿缘握着手机的手在发抖（仙光狂闪、手机红屏后期叠加）' })

  // ---------- E10 ----------
  upd('E10-01', { start: 'the diner at night, a young couple holding hands by the window', action: "the young woman by the window yanks her hand out of her boyfriend's", duration: 3, desc: '闪前：窗边女孩猛地抽回手（全屋变灰后期调色）' })
  upd('E10-07', { action: 'the young woman yanks her hand away and the old couple slam down their chopsticks', desc: '全景：窗边女孩抽回手，老夫妻摔下筷子（全屋变灰后期调色）' })
  split('E10-08', [
    { start: 'Ayuan and Lu Yan facing each other across the table', action: 'they stare into each other\'s eyes without moving', end: 'both still holding the gaze', duration: 3, size: 'MCU', dialogue: null, chars: ['阿缘', '陆衍'], desc: '两人隔桌对视，一动不动（后期：全屋变灰，只留两人彩色）' },
    { start: 'the young couple by the window and the old couple at their table', action: "the young woman slowly takes her boyfriend's hand again and the old couple look at each other, confused", end: 'everyone back to normal, puzzled', duration: 3, size: 'MS', dialogue: null, chars: ['群演C'], desc: '颜色恢复：女孩慢慢重新牵起男友的手，老夫妻对视发愣' },
  ])
  upd('E10-12', { action: 'his tablet flashes red, the red yarn balls on the desk roll around in panic and Taibai jumps up from his chair', end: 'Taibai standing, staring at the tablet', duration: 5, desc: '夜里物业办公室，平板闪红，桌上的毛线球乱滚，太白金星猛地站起' })

  // ---------- 台词镜头按字数补足时长 ----------
  let extended = 0
  for (const sb of loadShots()) {
    const spec = JSON.parse(sb.shot_spec)
    const text = spec.dialogue?.text
    if (!text) continue
    const n = text.replace(/[^一-鿿A-Za-z0-9]/g, '').length
    const need = Math.min(10, Math.ceil(n * 0.25 + 1.5))
    if ((sb.duration || 0) < need) {
      db.prepare("update storyboards set duration=?, video_prompt='', updated_at=? where id=?").run(need, now, sb.id)
      extended++
    }
  }

  // ---------- 其余镜头的提示词也清空，按新规则统一重写（E01-01a/b/c 手工调好的保留） ----------
  const keep = new Set(['E01-01a', 'E01-01b', 'E01-01c'])
  let cleared = 0
  for (const sb of loadShots()) {
    if (keep.has(JSON.parse(sb.shot_spec).shot_id)) continue
    if (sb.video_prompt) { db.prepare("update storyboards set video_prompt='' where id=?").run(sb.id); cleared++ }
  }
  console.log('台词时长补足', extended, '镜；另清空提示词', cleared, '镜')
})
tx()

const after = loadShots()
const perEp = {}
for (const s of after) {
  const n = episodes.find(e => e.id === s.episode_id).n
  perEp[n] = perEp[n] || { shots: 0, sec: 0 }
  perEp[n].shots++; perEp[n].sec += s.duration || 0
}
console.log('备份：', backupFile)
console.log(Object.entries(perEp).sort((a, b) => a[0] - b[0]).map(([n, v]) => `E${String(n).padStart(2, '0')} ${v.shots}镜 ${v.sec}s`).join('  '))
console.log('总计', after.length, '镜')
