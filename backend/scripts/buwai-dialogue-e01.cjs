/**
 * 《簿外良缘》E01 换成台词驱动版剧本，并拆成上下两集（2026-11-08 用户确认）
 * - 备份 E01 现有分镜、场记和集信息到 data/backups/
 * - E01（episode 14）改为「上」：SC001 煎饼摊 + SC002 天庭；旧分镜软删除、场记清空（视频文件不动）
 * - 新建「下」：SC003 物业办公室 + SC004 窗口；原第 2 集起的集号顺延 +1
 * - 项目 metadata 加 dub_only_characters（只配音不对口型的角色）
 * 剧本原文放在 data/backups/buwai-dialogue/（不进仓库）
 * 用法：node scripts/buwai-dialogue-e01.cjs
 */
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const DRAMA = 10
const EP = 14
const db = new Database(process.env.SQLITE_PATH || path.join(__dirname, '../../data/huobao.sqlite3'))
const now = () => new Date().toISOString()
const read = (f) => fs.readFileSync(path.join(__dirname, '../../data/backups/buwai-dialogue', f), 'utf8').replace(/\r\n/g, '\n')

const ep = db.prepare('select * from episodes where id = ?').get(EP)
if (!ep || ep.drama_id !== DRAMA) throw new Error('episode 14 not found')
if (/（上）/.test(ep.title)) { console.log('already imported'); process.exit(0) }

const ts = now()
const backup = {
  episode: ep,
  storyboards: db.prepare('select * from storyboards where episode_id = ? and deleted_at is null').all(EP),
  storyboard_characters: db.prepare('select sc.* from storyboard_characters sc join storyboards s on s.id = sc.storyboard_id where s.episode_id = ? and s.deleted_at is null').all(EP),
  storyboard_props: db.prepare('select sp.* from storyboard_props sp join storyboards s on s.id = sp.storyboard_id where s.episode_id = ? and s.deleted_at is null').all(EP),
  scene_continuity: db.prepare('select * from scene_continuity where episode_id = ?').all(EP),
}
const backupFile = path.join(__dirname, '../../data/backups', `buwai-e01-before-dialogue-${ts.replace(/[:.]/g, '-')}.json`)
fs.mkdirSync(path.dirname(backupFile), { recursive: true })
fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2))

const up = read('EP001-上.md')
const down = read('EP001-下.md')
const links = (episodeId, table, col, ids) => {
  db.prepare(`delete from ${table} where episode_id = ?`).run(episodeId)
  for (const id of ids) db.prepare(`insert into ${table} (episode_id, ${col}, created_at) values (?, ?, ?)`).run(episodeId, id, ts)
}

db.transaction(() => {
  db.prepare('update storyboards set deleted_at = ?, updated_at = ? where episode_id = ? and deleted_at is null').run(ts, ts, EP)
  db.prepare('delete from scene_continuity where episode_id = ?').run(EP)
  db.prepare(`update episodes set title = ?, content = ?, script_content = ?, description = ?, duration = 0, video_url = null, updated_at = ? where id = ?`)
    .run('业绩倒数第一（上）', up, up, '阿缘从天而降砸中陆衍，看见他腕上断掉的红线；倒叙天庭考核垫底、被贬下凡。', ts, EP)
  // 原第 2 集起顺延（先挪到负数避免撞号，再加回）
  const later = db.prepare('select id, episode_number from episodes where drama_id = ? and deleted_at is null and episode_number >= 2').all(DRAMA)
  for (const e of later) db.prepare('update episodes set episode_number = ? where id = ?').run(-(e.episode_number + 1), e.id)
  for (const e of later) db.prepare('update episodes set episode_number = ?, updated_at = ? where id = ?').run(e.episode_number + 1, ts, e.id)
  const info = db.prepare(`insert into episodes (drama_id, episode_number, title, content, script_content, description, duration, status,
      image_config_id, video_config_id, resolution, created_at, updated_at) values (?, 2, ?, ?, ?, ?, 0, 'draft', ?, ?, ?, ?, ?)`)
    .run(DRAMA, '业绩倒数第一（下）', down, down, '物业经理竟是太白金星，第 99 对是线已断的陆衍；簿簿登场；窗口与陆衍对视。',
      ep.image_config_id, ep.video_config_id, ep.resolution, ts, ts)
  const downId = Number(info.lastInsertRowid)
  // 上：阿缘、陆衍、老马、线团团、太白金星·天庭；煎饼摊、天庭月老部；陆衍的旧手表
  links(EP, 'episode_characters', 'character_id', [34, 35, 47, 39, 37])
  links(EP, 'episode_scenes', 'scene_id', [55, 54])
  links(EP, 'episode_props', 'prop_id', [16])
  // 下：阿缘、太白金星·物业、簿簿、陆衍、老马；物业办公室、煎饼摊；平板、工作机
  links(downId, 'episode_characters', 'character_id', [34, 36, 38, 35, 47])
  links(downId, 'episode_scenes', 'scene_id', [56, 55])
  links(downId, 'episode_props', 'prop_id', [15, 18])
  const drama = db.prepare('select metadata, total_episodes from dramas where id = ?').get(DRAMA)
  const meta = JSON.parse(drama.metadata || '{}')
  meta.dub_only_characters = ['簿簿', '线团团']
  db.prepare('update dramas set metadata = ?, total_episodes = ?, updated_at = ? where id = ?')
    .run(JSON.stringify(meta), (drama.total_episodes || 0) + 1, ts, DRAMA)
  console.log('down episode id', downId)
})()
console.log('backup', backupFile)
