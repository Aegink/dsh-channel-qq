/**
 * Report (and optionally purge) placeholder entries from the live learned-phrase
 * library. Read-only unless run with `--purge`.
 *
 * The `[图片]` entry that started this was deleted by hand; this checks whether
 * other non-text placeholders are still in the file and, with `--purge`, removes
 * them plus backs the file up first.
 *
 *   /opt/node22/bin/node /root/purge-learn-placeholders.mjs            # report
 *   /opt/node22/bin/node /root/purge-learn-placeholders.mjs --purge    # clean
 */

import { promises as fs } from 'node:fs'

const FILE = `${process.env.WORKSPACE ?? '/path/to/workspace'}/learned-phrases.json`
const purge = process.argv.includes('--purge')

// Same shapes `parseInbound` can emit, plus the raw CQ form.
const PLACEHOLDER = /\[(?:图片|语音|视频|动画表情|表情(?::\d+)?|文件[：:][^\]]*|文件|回复|合并转发|音乐|位置|链接|卡片|小程序|JSON|XML|CQ:[^\]]*)\]/

const raw = await fs.readFile(FILE, 'utf8')
const data = JSON.parse(raw)
const phrases = Array.isArray(data.phrases) ? data.phrases : []
const bad = phrases.filter((p) => PLACEHOLDER.test(String(p.text ?? '')))

console.log(`文件: ${FILE}`)
console.log(`总条数: ${phrases.length}`)
console.log(`占位符脏数据: ${bad.length}`)
for (const b of bad) {
  console.log(`  ${JSON.stringify(b.text)}  count=${b.count}  group=${b.groupId}  note=${JSON.stringify(String(b.note ?? '').slice(0, 30))}`)
}

if (bad.length === 0) {
  console.log('无需清理。')
  process.exit(0)
}

if (!purge) {
  console.log('（只读模式；加 --purge 才会真的删）')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${FILE}.bak-${stamp}`
await fs.copyFile(FILE, backup)
const kept = phrases.filter((p) => !PLACEHOLDER.test(String(p.text ?? '')))
await fs.writeFile(FILE, JSON.stringify({ ...data, phrases: kept }, null, 1), 'utf8')
console.log(`已删 ${phrases.length - kept.length} 条，剩 ${kept.length} 条。备份：${backup}`)
