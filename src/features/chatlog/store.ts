/** 群友原话簿：按群按日、一字不改的原始消息流水。
 *
 * 与记忆库的分工：
 * - 记忆库（memory feature）存的是**蒸馏后的结构化记录**（事实与偏好），原话在
 *   抽取时被丢掉；
 * - 本模块补的是中间那层：**干净的原话，按群按日，按人可查，一个字不改**。
 *   它保证「三天前谁怎么说的」翻得出来，不依赖蒸馏判断。
 *
 * 不蒸馏意味着不做摘要、不改口气、不判断真假。原话是料，不是结论：
 * 某人开玩笑说「我明天就退群」，记下来是原话，不许当成承诺引用。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export interface ChatLogEntry {
  /** 群号或私聊对方 QQ */
  readonly room: number
  readonly isGroup: boolean
  readonly qq: number
  readonly nick: string
  /** 本地时刻 HH:MM */
  readonly hhmm: string
  /** 本地日期 YYYY-MM-DD */
  readonly day: string
  readonly text: string
  /** 回的是谁的哪条（可空） */
  readonly replyTo?: string
}

export interface ChatLogOptions {
  /** 原话簿根目录，通常是 <workspace>/memory/chatlog */
  readonly dir: string
  /** 单条最多留多少字，超了截断并标注。0 或负数表示不截。 */
  readonly maxChars: number
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function localClock(d = new Date()): { day: string; hhmm: string } {
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/** 文件名里不能有的字符一律换掉，昵称常常带表情与斜杠。 */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\n\r\t]/g, '_').slice(0, 40)
}

/** 这一天这一间的原话文件。群按群号分目录，私聊按人分目录。 */
export function chatLogFile(dir: string, room: number, isGroup: boolean, day: string): string {
  const kind = isGroup ? 'group' : 'dm'
  return path.join(dir, kind, String(room), `${day}.md`)
}

/** 只是占位、没有原话的行（纯图片、纯表情、空消息）不该占纸。 */
export function isPlaceholder(text: string): boolean {
  const t = text.trim()
  if (t === '') return true
  return /^(\[[^\]]{1,12}\])+$/.test(t)
}

/** 一行原话：日期 时刻 昵称(QQ)：原话（回 谁） */
export function formatEntry(e: ChatLogEntry, maxChars: number): string {
  let text = e.text.replace(/\r/g, '').replace(/\n+/g, ' ⏎ ').trim()
  if (maxChars > 0 && text.length > maxChars) {
    text = `${text.slice(0, maxChars)}（后略 ${text.length - maxChars} 字，原文在归档）`
  }
  const back = e.replyTo !== undefined && e.replyTo !== '' ? `（回 ${e.replyTo}）` : ''
  return `${e.day} ${e.hhmm} ${e.nick}(${e.qq})：${text}${back}`
}

/** 追加一条。写失败不抛，交给调用方记日志：原话簿坏了不能拖垮回复。 */
export async function appendChatLog(opts: ChatLogOptions, entry: ChatLogEntry): Promise<boolean> {
  const file = chatLogFile(opts.dir, entry.room, entry.isGroup, entry.day)
  const line = formatEntry(entry, opts.maxChars)
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    // 新文件先写一行日期抬头，翻旧账时一眼知道是哪天。
    let header = ''
    try {
      await fs.access(file)
    } catch {
      header = `# ${entry.isGroup ? `群 ${entry.room}` : `私聊 ${entry.room}`} · ${entry.day}\n\n`
    }
    await fs.appendFile(file, `${header}${line}\n`, 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 某天某间房的一行发言（供摘要工具用）。 */
export interface DigestMessage {
  readonly time: string
  readonly nick: string
  readonly qq: string
  readonly text: string
}

/** 摘要工具解析原话簿行的正则：日期 时刻 昵称(QQ)：正文（回 …） */
const LINE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (.+?)\((\d+|我)\)：(.+)$/

/** 读某群某天的原话，解析成发言列表（按时间升序）。 */
export async function readDay(dir: string, roomId: string, day: string): Promise<DigestMessage[]> {
  const file = path.join(dir, 'group', roomId, `${day}.md`)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const messages: DigestMessage[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    const m = LINE_RE.exec(line)
    if (m === null) continue
    const body = (m[5] ?? '').replace(/（回 [^）]*）$/, '').trim()
    if (isPlaceholder(body)) continue
    messages.push({ time: `${m[1] ?? ''} ${m[2] ?? ''}`, nick: m[3] ?? '', qq: m[4] ?? '', text: body.slice(0, 200) })
  }
  return messages
}

/** 列出原话簿里已有的群目录 id（按目录名）。 */
export async function listGroupIds(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(dir, 'group'), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}