/**
 * 《簿外良缘》画风替换：软萌 Pixar 风 → 国漫 3D（角色/场景/道具提示词、分镜视频提示词、风格预设）
 * 用法：node scripts/buwai-style.cjs <drama_id>；导入脚本也复用这里的 restyle()
 */
const OLD_STYLE = '3D animated urban-fantasy rom-com look in a soft Pixar-like style, appealing characters with expressive eyes, warm cozy color palette, clean medium-detail rendering, gentle cinematic lighting'
const NEW_STYLE = 'high-end Chinese donghua 3D animation style (guoman 3D), semi-realistic refined CG characters with delicate handsome and beautiful East Asian facial features, slender elegant proportions, porcelain-smooth skin with soft subsurface scattering, finely rendered individual hair strands, detailed fabric textures, soft diffused cinematic lighting with gentle rim light, clean muted elegant color palette'
// 场景、道具、非人角色（簿簿、线团团）用不提人物五官的画风句，否则模型会往画面里加人
const OBJECT_STYLE = 'high-end Chinese donghua 3D animation style (guoman 3D), refined semi-realistic CG rendering, finely detailed textures and materials, soft diffused cinematic lighting with gentle rim light, clean muted elegant color palette'
const OLD_SHEET = '3D character turnaround sheet, three panels side by side on plain off-white background: full-body front view, side view, back view, identical scale, neutral standing pose, aspect ratio 16:9.'
const NEW_SHEET = 'Character design sheet on a plain white background, aspect ratio 16:9: on the left a large head-and-shoulders close-up portrait showing the face in fine detail; on the right three full-body views side by side (front view, side view, back view), identical scale, neutral standing pose.'
const restyle = (s, object = false) => s == null ? s : s.split(OLD_STYLE).join(object ? OBJECT_STYLE : NEW_STYLE).split(object ? NEW_STYLE : OBJECT_STYLE).join(object ? OBJECT_STYLE : NEW_STYLE).split(OLD_SHEET).join(NEW_SHEET)
// 非人角色：簿簿是本旧册子、线团团是毛线团
const isObjectCharacter = (text) => /\b(Bubu|Xiantuantuan)\b/.test(text || '')
module.exports = { restyle, isObjectCharacter, NEW_STYLE }

if (require.main === module) {
  const path = require('path')
  const db = new (require('better-sqlite3'))(process.env.SQLITE_PATH || path.join(__dirname, '../../data/huobao.sqlite3'))
  const dramaId = Number(process.argv[2])
  if (!dramaId) { console.error('usage: node scripts/buwai-style.cjs <drama_id>'); process.exit(1) }
  const count = {}
  db.transaction(() => {
    const up = (table, cols, where, args, object = () => false) => {
      for (const row of db.prepare(`select id, ${cols.join(', ')} from ${table} where ${where}`).all(...args)) {
        const next = cols.map(c => restyle(row[c], object(row)))
        if (next.some((v, i) => v !== row[cols[i]])) {
          db.prepare(`update ${table} set ${cols.map(c => `${c}=?`).join(', ')}, updated_at=? where id=?`).run(...next, new Date().toISOString(), row.id)
          count[table] = (count[table] || 0) + 1
        }
      }
    }
    up('characters', ['final_prompt', 'appearance'], 'drama_id=?', [dramaId], row => isObjectCharacter(row.final_prompt))
    up('scenes', ['final_prompt', 'prompt'], 'drama_id=?', [dramaId], () => true)
    up('props', ['final_prompt', 'prompt'], 'drama_id=?', [dramaId], () => true)
    up('storyboards', ['video_prompt'], 'episode_id in (select id from episodes where drama_id=?)', [dramaId])
    db.prepare("update style_presets set name='簿外良缘 · 国漫 3D', prompt=?, updated_at=? where value='buwai-pixar'").run(NEW_STYLE, new Date().toISOString())
  })()
  console.log(count)
}
