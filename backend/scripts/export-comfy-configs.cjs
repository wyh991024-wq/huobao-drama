// 导出本机的 ComfyUI 视频/图片配置（名称、模型、工作流等 settings），不含任何 API Key。
// 用法：node scripts/export-comfy-configs.cjs <输出文件.json>     配合 docs/server/deploy_demo.sh 导入体验版
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const out = process.argv[2]
if (!out) { console.error('用法：node scripts/export-comfy-configs.cjs <输出文件.json>'); process.exit(1) }
const db = new Database(process.env.SQLITE_PATH || path.join(__dirname, '../../data/huobao.sqlite3'), { readonly: true })
const rows = db.prepare("select service_type, provider, name, model, priority, settings from ai_service_configs where provider='comfyui' and is_active=1").all()
const configs = rows.map(r => ({
  service_type: r.service_type, provider: r.provider, name: r.name,
  model: JSON.parse(r.model || '[]'), priority: r.priority || 0,
  settings: r.settings ? JSON.parse(r.settings) : undefined,
}))
fs.writeFileSync(out, JSON.stringify(configs, null, 1))
console.log(`导出 ${configs.length} 条 ComfyUI 配置 → ${out}`)
