/**
 * Regression test: non-text placeholders must never count as content.
 *
 * Reported bug (by the bot itself, 2026-10-14): a picture message was learned as
 * group slang — the phrase library literally contained `[图片]`. Root cause was
 * `parseInbound` mixing display placeholders into `text`, which the learn store
 * (and the flood guard) then treated as words.
 *
 * Run on the server against the compiled output:
 *   /opt/node22/bin/node /root/media-placeholder-test.mjs
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseInbound, MEDIA_PLACEHOLDER_PATTERN } from '#lib/segments.js'
import { LearnStore } from '#lib/learn.js'

let pass = 0
const failures = []

async function check(name, fn) {
  try {
    const detail = await fn()
    pass += 1
    console.log(`PASS  ${name}  ${detail ?? ''}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}  ${error.message}`)
  }
}

/** A plausible OneBot v11 group message. */
function event(message, extra = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: BOT_QQ,
    group_id: PRIMARY_GROUP,
    user_id: ADMIN_QQ,
    time: 1760400000,
    message,
    ...extra,
  }
}

const P = (text) => ({ type: 'text', data: { text } })

// ── 1. parseInbound splits display rendering from real text ─────────────────

await check('图片单发：text 有占位符，plainText 为空', () => {
  const p = parseInbound(event([{ type: 'image', data: { url: 'http://x/1.png' } }]))
  if (p.text !== '[图片]') throw new Error('text 应为 [图片]，实际 ' + JSON.stringify(p.text))
  if (p.plainText !== '') throw new Error('plainText 应为空，实际 ' + JSON.stringify(p.plainText))
  if (p.imageUrls.length !== 1) throw new Error('没记下图片 url')
  return 'text="[图片]" plainText=""'
})

await check('图片配文：plainText 只留文字', () => {
  const p = parseInbound(event([{ type: 'image', data: { url: 'http://x/1.png' } }, P('好可爱')]))
  if (p.plainText !== '好可爱') throw new Error('plainText=' + JSON.stringify(p.plainText))
  if (!p.text.includes('[图片]')) throw new Error('text 丢了图片标记：' + p.text)
  if (p.text.includes('[图片]') && !p.text.includes('好可爱')) throw new Error('text 丢了正文')
  return `text=${JSON.stringify(p.text)} plainText=${JSON.stringify(p.plainText)}`
})

await check('表情 / 语音 / 文件 / 视频 都不进 plainText', () => {
  const p = parseInbound(event([
    P('你看这个'),
    { type: 'face', data: { id: '5' } },
    { type: 'record', data: { file: 'a.silk' } },
    { type: 'file', data: { file: 'demo.zip', file_size: 10240 } },
    { type: 'video', data: { url: 'http://x/v.mp4' } },
  ]))
  if (p.plainText !== '你看这个') throw new Error('plainText=' + JSON.stringify(p.plainText))
  for (const marker of ['[表情:5]', '[语音]', '[文件：demo.zip(10KB)]', '[视频]']) {
    if (!p.text.includes(marker)) throw new Error('text 缺少 ' + marker + '：' + p.text)
  }
  if (p.recordCount !== 1) throw new Error('recordCount 没数到语音')
  if (p.files.length !== 1 || p.files[0].name !== 'demo.zip') throw new Error('files 没解析出来')
  return `plainText=${JSON.stringify(p.plainText)}；text 含全部 4 个占位符`
})

await check('纯文字消息：plainText 与 text 一致', () => {
  const p = parseInbound(event([P('笑死我了')]))
  if (p.text !== '笑死我了' || p.plainText !== '笑死我了') {
    throw new Error(`text=${JSON.stringify(p.text)} plainText=${JSON.stringify(p.plainText)}`)
  }
  return '一致'
})

await check('字符串式 message 也能解析', () => {
  const p = parseInbound(event('早上好啊'))
  if (p.plainText !== '早上好啊') throw new Error('plainText=' + JSON.stringify(p.plainText))
  return 'ok'
})

// ── 2. the learn store refuses placeholders (defence in depth) ──────────────

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-learn-test-'))
const learnConfig = { enabled: true, autoCapture: true, minOccurrences: 3, file: null }
const logs = []
const store = new LearnStore(learnConfig, {
  workspacePath: home,
  dshHome: home,
  log: (line) => logs.push(line),
})

await check('把展示文本喂给学习器也学不到占位符', () => {
  // Exactly what regressed before: the display rendering reaching the learner.
  for (const poison of [
    '[图片]',
    '[表情:5]',
    '[语音]',
    '[视频]',
    '[文件：demo.zip(10KB)]',
    '[动画表情]',
    '[CQ:image,file=abc.jpg]',
    '[图片] [语音] [表情:12]',
  ]) {
    store.observe({ text: poison, userId: 1001, groupId: PRIMARY_GROUP })
  }
  const tracked = store.stats().tracked
  if (tracked !== 0) {
    const leaked = store.top(20).map((p) => p.text)
    throw new Error(`仍然学进了 ${tracked} 条：${JSON.stringify(leaked)}`)
  }
  return '8 种占位符全部被拒，tracked=0'
})

await check('占位符混在正文里时只学正文', () => {
  store.observe({ text: '[图片] 笑死我了', userId: 1001, groupId: PRIMARY_GROUP })
  const phrases = store.top(20).map((p) => p.text)
  if (phrases.length !== 1) throw new Error('预期 1 条，实际 ' + JSON.stringify(phrases))
  if (phrases[0] !== '笑死我了') throw new Error('学到的不是正文：' + JSON.stringify(phrases[0]))
  return `学到 ${JSON.stringify(phrases[0])}`
})

await check('正常口癖仍然学得到（防止修过头）', () => {
  store.observe({ text: '真的会谢', userId: 1002, groupId: PRIMARY_GROUP })
  store.observe({ text: '真的会谢', userId: 1003, groupId: PRIMARY_GROUP })
  const hit = store.top(20).find((p) => p.text === '真的会谢')
  if (hit === undefined) throw new Error('正常短句没学到：' + JSON.stringify(store.top(20).map((p) => p.text)))
  if (hit.count !== 2) throw new Error('次数不对：' + hit.count)
  if (hit.speakers.length !== 2) throw new Error('说话人没记全')
  return `count=${hit.count} speakers=${hit.speakers.length}`
})

// ── 3. the manual tool cannot be talked into learning a placeholder ─────────

for (const [label, poison] of [['图片', '[图片]'], ['语音', '[语音]'], ['文件', '[文件：x.zip]']]) {
  const name = `手动 remember('${label}占位符') 必须报错`
  try {
    await store.remember(poison, PRIMARY_GROUP)
    failures.push(`${name}: 没有报错`)
    console.log(`FAIL  ${name}  没有报错`)
  } catch (error) {
    pass += 1
    console.log(`PASS  ${name}  ${error.message.slice(0, 40)}`)
  }
}

await check('手动 remember 正常句子仍然可用', async () => {
  const phrase = await store.remember('绝了', PRIMARY_GROUP, '测试')
  if (phrase.text !== '绝了') throw new Error('记下的不是原句：' + JSON.stringify(phrase.text))
  return `记下 ${JSON.stringify(phrase.text)} count=${phrase.count}`
})

// ── 4. end-to-end: an image-only event cannot become a phrase ───────────────

await check('端到端：图片单发消息 → 学习器零产出', () => {
  const before = store.stats().tracked
  const parsed = parseInbound(event([{ type: 'image', data: { url: 'http://x/only.png' } }]))
  store.observe({ text: parsed.plainText, userId: 2001, groupId: PRIMARY_GROUP })
  const after = store.stats().tracked
  if (after !== before) throw new Error(`凭空多了 ${after - before} 条`)
  return '学习前后 tracked 不变'
})

await check('端到端：图片配文 → 只学正文', () => {
  const parsed = parseInbound(event([{ type: 'image', data: { url: 'http://x/2.png' } }, P('包浆了')]))
  store.observe({ text: parsed.plainText, userId: 2002, groupId: PRIMARY_GROUP })
  const phrases = store.top(20).map((p) => p.text)
  if (!phrases.includes('包浆了')) throw new Error('正文没学到：' + JSON.stringify(phrases))
  if (phrases.some((t) => t.includes('图片'))) throw new Error('学到了占位符：' + JSON.stringify(phrases))
  return JSON.stringify(phrases)
})

// ── 5. the shared pattern behaves (used by readers) ────────────────────────

await check('MEDIA_PLACEHOLDER_PATTERN 覆盖已知形态', () => {
  const samples = [
    '[图片]', '[语音]', '[视频]', '[表情:7]', '[表情]', '[文件：a.zip]',
    '[CQ:image,file=x.jpg]', '[回复]', '[合并转发]', '[动画表情]',
  ]
  const missed = samples.filter((s) => s.replace(MEDIA_PLACEHOLDER_PATTERN, '').trim() !== '')
  if (missed.length > 0) throw new Error('漏了：' + JSON.stringify(missed))
  // Must not eat real words that merely contain brackets.
  const keep = '【重点】这个[不是占位符]真好看'
  const kept = keep.replace(MEDIA_PLACEHOLDER_PATTERN, '')
  if (!kept.includes('【重点】') || !kept.includes('真好看')) throw new Error('误伤了正文：' + JSON.stringify(kept))
  return `${samples.length} 种全覆盖，且不误伤【全角括号】与[未知方括号]`
})

await fs.rm(home, { recursive: true, force: true }).catch(() => {})

console.log('')
if (failures.length > 0) {
  console.log(`==== ${pass}/${pass + failures.length} PASS，${failures.length} 项失败 ====`)
  for (const failure of failures) console.log('  - ' + failure)
  process.exit(1)
}
console.log(`==== ${pass}/${pass} PASS ====`)