/**
 * 《簿外良缘》E01-01 拆镜：原镜 5 秒里要"从天而降 + 砸穿雨棚 + 压倒陆衍 + 面糊四溅"，视频模型拍不出连贯物理过程。
 * 拆成 起因（陆衍抬头）→ 冲击（阿缘砸穿雨棚）→ 结果（坐在他身上），每镜只有一个简单动作，人物只放画面里真的有的。
 * 原镜内容保存在新镜 shot_spec.original 里。用法：node scripts/buwai-split-e01-01.cjs <drama_id>
 */
const path = require('path')
const db = new (require('better-sqlite3'))(process.env.SQLITE_PATH || path.join(__dirname, '../../data/huobao.sqlite3'))
const dramaId = Number(process.argv[2])
const ep = db.prepare('select id from episodes where drama_id=? and episode_number=1').get(dramaId)
const shots = db.prepare('select * from storyboards where episode_id=? and deleted_at is null order by storyboard_number').all(ep.id)
const orig = shots[0]
const origSpec = JSON.parse(orig.shot_spec)
if (origSpec.shot_id !== 'E01-01') { console.error('第 1 镜不是 E01-01，可能已经拆过'); process.exit(1) }

// 从原提示词里取每个资产的定义句、画风句
const setup = orig.video_prompt.match(/^Reference setup\. (.*)$/m)[1]
const defs = {}
for (const m of setup.matchAll(/@(\S+) is (.*?)(?=\. @|\.$)/g)) defs[m[1]] = `@${m[1]} is ${m[2]}.`
const overall = orig.video_prompt.match(/^Overall scene: .*$/m)[0]
const charId = Object.fromEntries(db.prepare('select id, name from characters where drama_id=?').all(dramaId).map(c => [c.name, c.id]))
const LOC = '幸福里门口煎饼摊'

const prompt = (who, duration, body, sound, music) => [
  'integrated_multimodal_description:',
  `Reference setup. ${[...who, LOC].map(n => defs[n]).join(' ')}`,
  overall,
  '',
  `[Shot 1] 0.0s–${duration.toFixed(1)}s. ${body} Characters in this shot: ${who.map(n => `the character from @${n}`).join(', ')}; location: @${LOC}.`,
  '',
  `overall_soundscape: ${sound}`,
  '',
  `non_diegetic_music: ${music}`,
].join('\n')

const NEW = [
  {
    id: 'E01-01a', duration: 3, size: 'MWS', move: 'STATIC', who: ['陆衍', '老马'], purpose: 'hook',
    desc: '清晨煎饼摊，陆衍低头看手机等早饭，老马摊面糊；头顶传来一声尖叫，陆衍皱眉抬头',
    start: 'Lu Yan stands at the pancake cart looking at his phone while Old Ma spreads batter on the griddle',
    action: 'a faint scream comes from high above; Lu Yan frowns and slowly looks up toward the sky',
    end: 'Lu Yan looks straight up; Old Ma pauses with his ladle',
    body: 'Medium wide shot, camera locked. Starts on: Lu Yan stands at the pancake cart looking at his phone while Old Ma spreads batter on the griddle. Action: a faint scream comes from high above; Lu Yan frowns and slowly looks up toward the sky. Ends on: Lu Yan looks straight up; Old Ma pauses with his ladle.',
    sound: 'quiet morning street ambience, a sizzling griddle, a distant scream growing louder.',
    music: 'a light rising comic whistle, instrumental only.',
  },
  {
    id: 'E01-01b', duration: 3, size: 'MS', move: 'STATIC', who: ['阿缘'], purpose: 'hook',
    desc: '仰拍雨棚：阿缘尖叫着从天上掉下来，砸穿条纹雨棚',
    start: 'low angle from under the striped rain canopy, the canopy fabric against the bright morning sky',
    action: 'Ayuan, screaming with arms flailing, plunges down through the canopy and the fabric rips open around her',
    end: 'she drops out of the bottom of the frame, the torn canopy flapping',
    body: 'Medium shot from a low angle under the striped rain canopy, camera locked. Starts on: the underside of the striped canopy against the bright morning sky. Action: Ayuan, screaming with arms flailing, plunges down through the canopy and the fabric rips open around her. Ends on: she drops out of the bottom of the frame, the torn canopy flapping.',
    sound: 'a loud falling scream, fabric tearing.',
    music: 'a comic brass swell, instrumental only.',
  },
  {
    id: 'E01-01c', duration: 4, size: 'MWS', move: 'STATIC', who: ['阿缘', '陆衍', '老马'], purpose: 'hook',
    desc: '阿缘坐在仰面倒地的陆衍身上，头顶一个磕破的生鸡蛋，陆衍西装上溅了几道面糊；老马拿着勺子愣住',
    start: 'Ayuan sits dazed on top of Lu Yan, who lies flat on his back on the ground beside the cart; a cracked raw egg sits on her head and a few streaks of pancake batter mark his grey suit; Old Ma stands frozen behind the cart',
    action: 'Ayuan blinks in a daze; the torn canopy above them sways; Old Ma stays frozen holding his ladle',
    end: 'Ayuan looks down at Lu Yan with an awkward sheepish grin',
    body: 'Medium wide shot, camera locked. Starts on: Ayuan sits dazed on top of Lu Yan, who lies flat on his back on the ground beside the pancake cart; a cracked raw egg sits on her head and a few streaks of pancake batter mark his grey suit; Old Ma stands frozen behind the cart. Action: Ayuan blinks in a daze while the torn canopy above them sways and Old Ma stays frozen holding his ladle. Ends on: Ayuan looks down at Lu Yan with an awkward sheepish grin. Each person appears only once; the street is otherwise empty.',
    sound: 'a heavy thud, then sudden silence, egg dripping.',
    music: 'a comic brass sting, instrumental only.',
  },
]

const now = new Date().toISOString()
db.transaction(() => {
  // 后面的镜号整体后移 2
  db.prepare('update storyboards set storyboard_number = storyboard_number + 2, updated_at=? where episode_id=? and storyboard_number > 1 and deleted_at is null').run(now, ep.id)
  NEW.forEach((n, i) => {
    const spec = { ...origSpec, shot_id: n.id, shot_size: n.size, camera_move: n.move, move_speed: 'slow', start_frame: n.start, action: n.action, end_frame: n.end,
      continuity_in: i === 0 ? 'new scene' : 'cut on action', original: i === 0 ? origSpec : undefined }
    const values = [n.id, n.size === 'MS' ? '中景' : '中全景', n.move, n.end, prompt(n.who, n.duration, n.body, n.sound, n.music), n.desc, n.duration, JSON.stringify(spec), now]
    let id
    if (i === 0) {
      db.prepare(`update storyboards set title=?, shot_type=?, movement=?, result=?, video_prompt=?, description=?, duration=?, shot_spec=?, updated_at=?,
        first_frame_image=null, last_frame_image=null where id=?`).run(...values, orig.id)
      id = orig.id
      db.prepare('delete from storyboard_characters where storyboard_id=?').run(id)
    } else {
      id = db.prepare(`insert into storyboards (episode_id, scene_id, storyboard_number, location, time, atmosphere, title, shot_type, movement, result, video_prompt, description, duration, shot_spec, updated_at, created_at, status)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(ep.id, orig.scene_id, i + 1, orig.location, orig.time, orig.atmosphere, ...values, now).lastInsertRowid
    }
    for (const name of n.who) db.prepare('insert or ignore into storyboard_characters (storyboard_id, character_id) values (?, ?)').run(id, charId[name])
    console.log(n.id, '→ storyboard', id)
  })
})()
