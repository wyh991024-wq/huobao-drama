/**
 * FFmpeg 多镜头拼接 — 将所有生成后的镜头视频拼接为一集
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db, getInsertId, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { cutWindows, parseShotSpec } from './director.js'
import type { VoiceTrack } from './tts.js'

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

/**
 * 拼接一集的镜头视频。
 * 优先使用视频生成产物，兼容历史的 composedVideoUrl 数据。
 * 传入 storyboardIds 时只拼接所选镜头（仍按镜号顺序）。
 */
export async function mergeEpisodeVideos(episodeId: number, dramaId: number, storyboardIds?: number[]): Promise<number> {
  let storyboards = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  storyboards = storyboards.filter(sb => !sb.deletedAt)

  if (storyboardIds?.length) {
    const allow = new Set(storyboardIds.map(Number))
    storyboards = storyboards.filter(sb => allow.has(sb.id))
  }

  // 允许部分拼接:按镜号顺序拼接已生成的镜头,未生成的跳过
  const clips = storyboards
    .map(sb => ({ sb, url: sb.videoUrl || sb.composedVideoUrl }))
    .filter(c => Boolean(c.url)) as { sb: typeof storyboards[number]; url: string }[]

  if (clips.length === 0) throw new Error('所选镜头还没有可拼接的视频')

  // 拼接前探测 ffmpeg：二进制损坏时 fluent-ffmpeg 的同步 EFTYPE 会崩掉整个进程，
  // 这里提前拦截并给出可操作的修复指引（路由层会作为 400 返回前端）
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法拼接视频（常见于 node_modules 跨平台拷贝或 ffmpeg-static 下载损坏）。请删除 node_modules 后在本机重新 npm install，或设置 FFMPEG_BIN 指向有效的 ffmpeg 可执行文件后重启服务')
  }

  // 校验视频文件真实存在:DB 里的 video_url 可能指向已被清理的文件,
  // 直接拼会得到 ffmpeg 的 "No such file or directory" 晦涩报错
  const missing = clips.filter(c => !fs.existsSync(toAbsPath(c.url)))
  if (missing.length > 0) {
    const nums = missing.map(c => `S${c.sb.storyboardNumber}`).join('、')
    throw new Error(`镜头 ${nums} 的视频文件已丢失（本地文件不存在），请重新生成这些镜头的视频，或在拼接时取消勾选`)
  }

  const videos = clips.map(c => c.url)
  const post = clips.map(c => postOf(c.sb))

  logTaskStart('MergeTask', 'episode-merge', { episodeId, dramaId, clips: videos.length })

  // 创建 merge 记录
  const ts = now()
  const res = await db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: `Episode ${episodeId} Merge`,
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'processing',
    scenes: JSON.stringify(videos),
    createdAt: ts,
  })
  const mergeId = getInsertId(res)

  // 异步执行
  doMerge(mergeId, episodeId, videos, post).catch(async err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: err.message })
    console.error(`[Merge] Failed:`, err)
    await db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: err.message })
      .where(eq(schema.videoMerges.id, mergeId))
  })

  return mergeId
}

async function doMerge(mergeId: number, episodeId: number, videos: string[], post: ClipPost[] = []) {
  // 生成 concat 列表文件
  const listDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(listDir, { recursive: true })
  const listPath = path.join(listDir, `${uuid()}.txt`)

  // 有后期配音或画面文字时，先逐镜混音、叠字（全部镜头统一重编码，保证 concat 参数一致）
  const temps: string[] = []
  let inputs = videos.map(toAbsPath)
  if (post.some(p => p.voices.length || p.texts.length)) {
    inputs = []
    for (const [i, v] of videos.entries()) {
      const out = path.join(listDir, `dub-${uuid()}.mp4`)
      await dubClip(toAbsPath(v), post[i] || { voices: [], texts: [] }, out)
      temps.push(out)
      inputs.push(out)
    }
  }

  const listContent = inputs
    .map(v => `file '${v}'`)
    .join('\n')
  fs.writeFileSync(listPath, listContent, 'utf-8')

  // 输出文件
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-fflags', '+genpts',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()

  })

  // 清理临时文件
  fs.unlinkSync(listPath)
  for (const t of temps) fs.rmSync(t, { force: true })

  // 获取时长
  const duration = await getVideoDuration(outputPath)

  const mergedRelative = `static/merged/${outputFilename}`

  // 成片海报帧（导出页封面用）
  await extractVideoPoster(mergedRelative)

  // 更新 merge 记录
  await db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, completedAt: now() })
    .where(eq(schema.videoMerges.id, mergeId))

  // 更新 episode
  await db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))

  logTaskSuccess('MergeTask', 'episode-merge', { mergeId, episodeId, output: mergedRelative, duration, clips: videos.length })
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(metadata.format.duration || 0))
    })
  })
}

// ─── 后期配音与画面文字 ──────────────────────────────────────

export interface ClipPost {
  /** 后期配音（VO/OS/DUB），对口型台词由视频自带 */
  voices: { file: string; at?: number; chars: number }[]
  /** 名条与画面文字；段模式下带所在镜头的起止秒数，只在那个镜头里显示 */
  texts: { text: string; start?: number; end?: number }[]
  /** 本镜对口型台词字数：配音默认排在它说完之后 */
  lipChars?: number
}

const countChars = (t: string) => t.replace(/[^一-鿿A-Za-z0-9]/g, '').length

function postOf(sb: { shotSpec: string | null; voiceTracks?: string | null; duration?: number | null }): ClipPost {
  const spec = parseShotSpec(sb.shotSpec)
  let tracks: VoiceTrack[] = []
  try { tracks = JSON.parse(sb.voiceTracks || '[]') } catch {}
  return {
    voices: tracks.filter(t => t.kind !== 'LIP' && t.url && fs.existsSync(toAbsPath(t.url)))
      .map(t => ({ file: toAbsPath(t.url!), at: t.at, chars: countChars(t.text) })),
    texts: spec?.cuts?.length
      ? cutWindows(spec, sb.duration || 15)
        .flatMap(w => (w.onscreen_text || []).map(t => ({ text: String(t).trim(), start: w.start, end: w.end })))
        .filter(t => t.text)
      : (spec?.onscreen_text || []).map(t => ({ text: String(t).trim() })).filter(t => t.text),
    lipChars: spec?.dialogue?.text ? countChars(spec.dialogue.text) : 0,
  }
}

/** drawtext 的文件路径参数：统一正斜杠，冒号转义（Windows 盘符） */
const ffEscapePath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:')

function subtitleFont(): string | null {
  const candidates = [process.env.SUBTITLE_FONT, 'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf',
    '/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc']
  return candidates.find(f => f && fs.existsSync(f)) || null
}

function probe(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, md) => {
      if (err) { resolve({ duration: 0, hasAudio: false }); return }
      resolve({ duration: Number(md.format.duration) || 0, hasAudio: md.streams.some(s => s.codec_type === 'audio') })
    })
  })
}

/** 一镜：视频原声 + 配音（adelay 排好时间）混音；名条叠在左下前 3.5 秒，其余画面文字整镜叠在上方 */
export async function dubClip(input: string, post: ClipPost, output: string) {
  const { duration, hasAudio } = await probe(input)
  const cmd = ffmpeg().input(input)
  const filters: string[] = []
  const tempTexts: string[] = []
  if (!hasAudio) {
    cmd.input('anullsrc=channel_layout=stereo:sample_rate=48000').inputOptions(['-f', 'lavfi', '-t', String(duration || 5)])
  }
  let audioIdx = hasAudio ? 1 : 2
  const base = hasAudio ? '[0:a]' : '[1:a]'
  // 配音默认排在对口型台词说完后（每秒约 3.5 字），没有对口型台词从 0.3 秒开始，句与句之间留 0.2 秒
  let cursor = post.lipChars ? post.lipChars / 3.5 + 0.6 : 0.3
  const mixIn = [`${base}aformat=sample_rates=48000:channel_layouts=stereo,volume=0.8[a0]`]
  const labels = ['[a0]']
  for (const [i, v] of post.voices.entries()) {
    cmd.input(v.file)
    const at = v.at ?? cursor
    const { duration: len } = await probe(v.file)
    cursor = at + (len || v.chars / 3.5) + 0.2
    mixIn.push(`[${audioIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}[v${i}]`)
    labels.push(`[v${i}]`)
    audioIdx++
  }
  if (cursor > duration + 0.1 && post.voices.length) {
    logTaskError('MergeTask', 'dub-overflow', { input: path.basename(input), voiceEnds: cursor.toFixed(1), clip: duration.toFixed(1) })
  }
  filters.push(...mixIn, `${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0[aout]`)

  const font = subtitleFont()
  let videoOut = '0:v'
  if (post.texts.length && font) {
    const fontArg = ffEscapePath(font)
    const chain: string[] = []
    let top = 0
    for (const { text: raw, start, end } of post.texts) {
      const isName = /^名条[：:]/.test(raw)
      const text = raw.replace(/^(名条|画面文字|大屏|平板|屏幕)[：:]\s*/, '')
      const tf = path.join(path.dirname(output), `txt-${uuid()}.txt`)
      fs.writeFileSync(tf, text, 'utf-8')
      tempTexts.push(tf)
      const tfArg = ffEscapePath(tf)
      chain.push(isName
        ? `drawtext=fontfile='${fontArg}':textfile='${tfArg}':fontsize=h/26:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18:x=w*0.06:y=h*0.72:enable='between(t,${(start ?? 0) + 0.5},${Math.min((start ?? 0) + 4, end ?? 1e9)})'`
        : `drawtext=fontfile='${fontArg}':textfile='${tfArg}':fontsize=h/30:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=14:x=(w-text_w)/2:y=h*0.08+${top}*h*0.06${start !== undefined ? `:enable='between(t,${start},${end})'` : ''}`)
      if (!isName) top++
    }
    filters.push(`[0:v]${chain.join(',')}[vout]`)
    videoOut = '[vout]'
  }

  try {
    await new Promise<void>((resolve, reject) => {
      cmd.complexFilter(filters)
        .outputOptions(['-map', videoOut, '-map', '[aout]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
          '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-t', String(duration || 5)])
        .output(output)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  } finally {
    for (const t of tempTexts) fs.rmSync(t, { force: true })
  }
}
