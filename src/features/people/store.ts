/** 人物档：按房间记录"一个人怎么说话"的线索。
 *
 * 原话簿存的是料（某人某天原样说了什么，不加工）；人物档存的是**判断**：
 * 从多天原话里攒出来的印象（谁爱用反问、谁忌讳被叫全名），一句一条，带日期。
 * 判断会错，所以每条带日期；错了能改，也看得出是哪天形成的。
 *
 * 一条规矩：人物档只用来认人和接话，不许当证据引用。「他上次说过 X」要引
 * 原话，不许拿这里的印象代替。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'

export interface PersonNote {
  /** 一句话一条，越具体越好：谁爱用反问、谁忌讳被叫全名 */
  readonly note: string
  /** 形成日期 YYYY-MM-DD */
  readonly day: string
}

export interface PersonFile {
  qq: number
  nick: string
  notes: PersonNote[]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function today(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 同一个人在不同群说话不一样，所以档案按群分开存。room 形如 group-… 或 dm-…。
 *  不给 room 时退回根目录那一份，兼容跨群的旧档。 */
export function personFile(dir: string, qq: number, room?: string): string {
  return room === undefined || room === ''
    ? path.join(dir, `${qq}.md`)
    : path.join(dir, room, `${qq}.md`)
}

/** 解析人物档 markdown：首行是昵称，其余每行 `- YYYY-MM-DD 内容`。 */
export function parsePersonFile(qq: number, text: string): PersonFile {
  const lines = text.split('\n')
  let nick = `QQ${qq}`
  const notes: PersonNote[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('# ')) {
      const m = /^#\s*(.+?)\s*(\(\d+\))?$/.exec(line)
      if (m !== null && m[1] !== undefined) nick = m[1]
      continue
    }
    if (!line.startsWith('- ')) continue
    const m = /^-\s*(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line)
    if (m === null) {
      notes.push({ note: line.slice(2).trim(), day: '' })
      continue
    }
    notes.push({ day: m[1] ?? '', note: (m[2] ?? '').trim() })
  }
  return { qq, nick, notes }
}

export function renderPersonFile(file: PersonFile): string {
  const head = `# ${file.nick}(${file.qq})\n\n`
  const body = file.notes.map(n => `- ${n.day} ${n.note}`).join('\n')
  return `${head}${body}\n`
}

/** 读一个人。没有档案返回 null。 */
export async function readPerson(dir: string, qq: number, room?: string): Promise<PersonFile | null> {
  const tries = room === undefined || room === ''
    ? [personFile(dir, qq)]
    : [personFile(dir, qq, room), personFile(dir, qq)]
  for (const file of tries) {
    try {
      const text = await fs.readFile(file, 'utf-8')
      return parsePersonFile(qq, text)
    } catch { /* 试下一处 */ }
  }
  return null
}

/** 追加一条线索（同文去重）。返回是否真写入。 */
export async function appendPersonNote(
  dir: string,
  qq: number,
  nick: string,
  note: string,
  day = today(),
  room?: string,
): Promise<boolean> {
  const clean = note.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (clean === '') return false
  const existing = await readPerson(dir, qq, room)
  const file: PersonFile = existing ?? { qq, nick, notes: [] }
  if (existing !== null && nick !== '' && nick !== existing.nick) file.nick = nick
  if (file.notes.some(n => n.note === clean)) return false
  file.notes.push({ note: clean, day })
  try {
    await atomicWriteFile(personFile(dir, qq, room), renderPersonFile(file))
    return true
  } catch {
    return false
  }
}

/** 列出所有人的档案（只读，不建目录）。 */
export async function listPeople(dir: string, room?: string): Promise<PersonFile[]> {
  if (room !== undefined && room !== '') {
    const sub = path.join(dir, room)
    const files = await fs.readdir(sub).catch(() => [] as string[])
    const out: PersonFile[] = []
    for (const f of files) {
      const m = /^(\d+)\.md$/.exec(f)
      if (m === null) continue
      const p = await readPerson(dir, Number(m[1]), room)
      if (p !== null) out.push(p)
    }
    return out.sort((a, b) => b.notes.length - a.notes.length)
  }
  let files: string[] = []
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: PersonFile[] = []
  for (const f of files) {
    const m = /^(\d+)\.md$/.exec(f)
    if (m === null) continue
    const qq = Number(m[1])
    if (!Number.isFinite(qq)) continue
    const p = await readPerson(dir, qq)
    if (p !== null) out.push(p)
  }
  return out.sort((a, b) => b.notes.length - a.notes.length)
}
