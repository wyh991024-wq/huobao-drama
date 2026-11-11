// 给角色自动设计音色样本：文本模型按角色资料写音色描述和一句试音台词 → ComfyUI 上的 Qwen3-TTS VoiceDesign 念出来 →
// 上传为角色音色（与在角色页手动上传音色完全一样）。之后重新生成视频提示词，有台词的角色会带上 #角色名，
// 生视频时这段音色作为 H3 的参考音频，说话更清楚、同一角色各镜音色一致。
//
// 用法（在 backend 目录）：
//   node scripts/design-voices.cjs --db ../data/huobao.sqlite3 --api http://127.0.0.1:5679 --comfy http://127.0.0.1:18188 [--drama 10] [--force] [--dry-run]
// 实例开了访问密码时加环境变量 ACCESS_PASSWORD。只读数据库，写入一律走实例的上传接口。
// 需要：ComfyUI 装了 1038lab/ComfyUI-QwenTTS（AILab_Qwen3TTSVoiceDesign）和 ComfyUI-IndexTTS2（IndexTTS2SaveAudio，存 wav）。
const path = require('path')
const Database = require('better-sqlite3')

const args = process.argv.slice(2)
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined }
const flag = name => args.includes('--' + name)
const dbPath = opt('db') || path.join(__dirname, '../../data/huobao.sqlite3')
const api = (opt('api') || 'http://127.0.0.1:5679').replace(/\/+$/, '')
const comfy = (opt('comfy') || 'http://127.0.0.1:18188').replace(/\/+$/, '')
const dramaId = opt('drama') ? Number(opt('drama')) : null
const auth = process.env.ACCESS_PASSWORD ? { Authorization: 'Basic ' + Buffer.from('script:' + process.env.ACCESS_PASSWORD).toString('base64') } : {}

const db = new Database(dbPath, { readonly: true })

function textConfig() {
  const rows = db.prepare("select * from ai_service_configs where service_type='text' and is_active=1 and lower(provider) in ('openai','volcengine') order by priority desc").all()
  const r = rows.find(x => x.api_key)
  if (!r) throw new Error('没有可用的 OpenAI 兼容文本配置（需要已填 Key 的文本服务）')
  const model = JSON.parse(r.model || '[]')[0]
  let base = r.base_url.replace(/\/+$/, '')
  if (!/\/v\d+$/.test(base) && !/\/api\/v3$/.test(base)) base += r.provider.toLowerCase() === 'volcengine' ? '/api/v3' : '/v1'
  return { url: base + '/chat/completions', key: r.api_key, model, name: r.name }
}

async function writeDescriptions(drama, chars) {
  const cfg = textConfig()
  const brief = chars.map(c => ({ name: c.name, role: c.role, description: c.description, personality: c.personality, appearance: c.appearance }))
  const prompt = [
    '你是短剧配音导演。为下面每个角色设计声音，交给语音合成模型（Qwen3-TTS VoiceDesign）按描述生成这个角色的音色样本。',
    '每个角色给两项：',
    '- instruct：音色描述，30-60 字中文，写清性别、大致年龄、音色质感（清亮/沙哑/浑厚/软糯……）、语速、说话习惯和情绪底色；只写声音，不写外貌和剧情',
    '- sample：一句试音台词，20-35 字，符合角色身份和说话方式，语气自然，用于生成样本',
    '同一部剧的角色声音要拉开差别。',
    `剧名：《${drama.title}》`,
    `角色资料：${JSON.stringify(brief)}`,
    '只输出 JSON 对象：{"角色名": {"instruct": "...", "sample": "..."}}，不要别的文字。',
  ].join('\n')
  const resp = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0.7 }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!resp.ok) throw new Error(`文本模型（${cfg.name} / ${cfg.model}）返回 HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`)
  const text = String((await resp.json())?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '')
  return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}')
}

async function designVoice(instruct, sample, stem) {
  const wf = {
    1: { class_type: 'AILab_Qwen3TTSVoiceDesign', inputs: { text: sample, instruct, model_size: '1.7B', language: 'Chinese', unload_models: true, seed: Math.floor(Math.random() * 2 ** 31) } },
    2: { class_type: 'IndexTTS2SaveAudio', inputs: { audio: ['1', 0], name: stem, format: 'wav' } },
  }
  const sub = await (await fetch(`${comfy}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'design-voices' }) })).json()
  if (!sub.prompt_id) throw new Error('提交 ComfyUI 失败：' + JSON.stringify(sub).slice(0, 300))
  const deadline = Date.now() + 20 * 60_000 // 队列里可能排着视频任务
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))
    const item = (await (await fetch(`${comfy}/history/${sub.prompt_id}`)).json())[sub.prompt_id]
    if (!item) continue
    if (item.status?.status_str === 'error') throw new Error('ComfyUI 执行失败：' + JSON.stringify(item.status.messages).slice(-300))
    const f = Object.values(item.outputs || {}).flatMap(o => o.audio || [])[0]
    if (!f) continue
    const u = new URL(`${comfy}/view`)
    u.searchParams.set('filename', f.filename); u.searchParams.set('subfolder', f.subfolder || ''); u.searchParams.set('type', f.type || 'output')
    return Buffer.from(await (await fetch(u)).arrayBuffer())
  }
  throw new Error('ComfyUI 20 分钟没有完成')
}

async function upload(charId, name, wav) {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), `${name}-音色.wav`)
  const resp = await fetch(`${api}/api/v1/characters/${charId}/voice`, { method: 'POST', headers: auth, body: form })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(`上传失败 HTTP ${resp.status}：${data.message || ''}`)
  return data.data?.voice_audio_url
}

;(async () => {
  const dramas = db.prepare('select id, title from dramas where deleted_at is null' + (dramaId ? ' and id=?' : '')).all(...(dramaId ? [dramaId] : []))
  for (const drama of dramas) {
    const chars = db.prepare('select * from characters where drama_id=? and deleted_at is null order by id').all(drama.id)
      .filter(c => flag('force') || !c.voice_audio_url)
    if (!chars.length) { console.log(`《${drama.title}》：所有角色都已有音色，跳过`); continue }
    console.log(`《${drama.title}》：${chars.length} 个角色要设计音色`)
    const desc = await writeDescriptions(drama, chars)
    for (const c of chars) {
      const d = desc[c.name]
      if (!d?.instruct || !d?.sample) { console.log(`  ${c.name}：文本模型没给出描述，跳过`); continue }
      console.log(`  ${c.name}：${d.instruct}｜试音：${d.sample}`)
      if (flag('dry-run')) continue
      try {
        const wav = await designVoice(d.instruct, d.sample, `voice-d${drama.id}-c${c.id}-${Date.now()}`)
        console.log(`    → ${await upload(c.id, c.name, wav)}（${Math.round(wav.length / 1024)} KB）`)
      } catch (e) { console.log(`    ✗ ${e.message}`) }
    }
  }
})().catch(e => { console.error(e.message); process.exit(1) })
