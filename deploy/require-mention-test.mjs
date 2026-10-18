/**
 * Behaviour test for the `requireMention` switch ("需要 @ 才回").
 *
 * Regression: the option was declared, defaulted to true, and rendered as an
 * admin toggle, but nothing read it — the bot spoke into groups on a talk-chance
 * roll even when nobody addressed it. That reads to members as a reply to the
 * wrong thing.
 *
 * The guarded path needs no live QQ connection: every network-touching step
 * before the guard short-circuits on empty input (`receiveFiles` with no files,
 * `fetchQuoted` with no reply, `attachImages` with recognition disabled), so the
 * bridge is driven directly with stub collaborators.
 *
 *   /opt/node22/bin/node /root/require-mention-test.mjs
 */
import { ConversationBridge, roomDirectiveFor } from '#lib/bridge.js'
import { resolveConfig } from '#lib/config.js'

const SELF = BOT_QQ
const GROUP = PRIMARY_GROUP
const MASTER = ADMIN_QQ

let pass = 0
const failures = []
const check = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log(`PASS  ${name}  ${detail}`) }
  else { failures.push(`${name} :: ${detail}`); console.log(`FAIL  ${name}  ${detail}`) }
}

const text = (t) => ({ type: 'text', data: { text: t } })
const atBot = { type: 'at', data: { qq: String(SELF) } }

const groupEvent = (segments) => ({
  post_type: 'message', message_type: 'group', self_id: SELF,
  group_id: GROUP, user_id: MASTER, time: 1760400000,
  message: segments, sender: { nickname: '主人', role: 'owner' },
})

const privateEvent = (segments) => ({
  post_type: 'message', message_type: 'private', self_id: SELF,
  user_id: MASTER, time: 1760400000,
  message: segments, sender: { nickname: '主人' },
})

function makeBridge(overrides) {
  const logs = []
  const config = resolveConfig({
    debug: true,
    imageRecognition: { enabled: false, maxPerMessage: 2 },
    ...overrides,
  })
  const bridge = new ConversationBridge(
    {},                                                     // ctx: untouched on the guarded path
    config,
    { selfId: SELF, call: async () => ({ status: 'ok', retcode: 0, data: {} }) },
    { push: async (fn) => await fn() },
    (line) => logs.push(line),
  )
  return { bridge, logs }
}

const IGNORED = (logs) => logs.some((l) => l.includes('ignored group message (requireMention, not called)'))

// ── 1. the announced behaviour ──────────────────────────────────────────────
{
  const { bridge, logs } = makeBridge({ requireMention: true })
  await bridge.handleEvent(groupEvent([text('今天天气不错')])).catch(() => {})
  check('requireMention=开，没被 @ 的群消息被忽略', IGNORED(logs),
    IGNORED(logs) ? '日志有忽略记录' : `日志：${JSON.stringify(logs.slice(0, 4))}`)
}

// ── 2. @ 了就必须处理 ───────────────────────────────────────────────────────
{
  const { bridge, logs } = makeBridge({ requireMention: true })
  await bridge.handleEvent(groupEvent([atBot, text('铃铃在吗')])).catch(() => {})
  check('requireMention=开，@ 了机器人照常处理', !IGNORED(logs), '没有忽略记录')
}

// ── 3. 关键词触发也算被叫到 ─────────────────────────────────────────────────
{
  const { bridge, logs } = makeBridge({ requireMention: true, keywordTriggers: ['铃铃'] })
  await bridge.handleEvent(groupEvent([text('铃铃帮我看下这个')])).catch(() => {})
  check('requireMention=开，命中唤醒关键词不算忽略', !IGNORED(logs), '关键词 "铃铃" 命中')
}

// ── 4. 私聊不受影响 ─────────────────────────────────────────────────────────
{
  const { bridge, logs } = makeBridge({ requireMention: true })
  await bridge.handleEvent(privateEvent([text('在么')])).catch(() => {})
  check('requireMention=开，私聊不受影响', !IGNORED(logs), '私聊没有忽略记录')
}

// ── 5. room directive: every turn must state where to send ──────────────────
// Regression: the intake line carried no room marker, so a DM question was
// answered into the main group. The directive is what makes the target explicit.
{
  const group = roomDirectiveFor(true, GROUP)
  const dm = roomDirectiveFor(false, MASTER)
  check('群聊房间指令写明群号和 isGroup=true/target', 
    group.includes('【这是群聊】') && group.includes(`群号 ${GROUP}`)
    && group.includes('isGroup=true') && group.includes(`target=${GROUP}`)
    && group.includes('不要发到私聊'),
    group.slice(0, 60))
  check('私聊房间指令写明对方 QQ 和 isGroup=false/target',
    dm.includes('【这是私聊】') && dm.includes(`对方 QQ ${MASTER}`)
    && dm.includes('isGroup=false') && dm.includes(`target=${MASTER}`)
    && dm.includes('不要发到任何群里'),
    dm.slice(0, 60))
  check('两种房间的指令互不相同（不会把私聊当成群聊）',
    group !== dm && !dm.includes('群号') && !group.includes('对方 QQ'),
    '群聊/私聊指令各自独立')
  // The target in the directive must be the room the message actually came from:
  // a DM turn must never advertise the group id.
  check('私聊指令里不出现主群号', !dm.includes(String(GROUP)), `dm 不含 ${GROUP}`)
}

// ── 6. 关掉开关要能恢复主动接话 ─────────────────────────────────────────────
{
  const { bridge, logs } = makeBridge({ requireMention: false })
  await bridge.handleEvent(groupEvent([text('今天天气不错')])).catch(() => {})
  check('requireMention=关，没被 @ 也不再忽略（回到主动接话）', !IGNORED(logs), '没有忽略记录')
}

// ── 7. 群聊总开关关闭时连记录都不该有 ───────────────────────────────────────
{
  const { bridge, logs } = makeBridge({ requireMention: true, groupEnabled: false })
  await bridge.handleEvent(groupEvent([text('随便说点什么')])).catch(() => {})
  check('groupEnabled=关，群消息直接返回', !IGNORED(logs), 'groupEnabled 的检查在前面')
}

console.log('')
if (failures.length > 0) {
  console.log(`==== ${pass}/${pass + failures.length} PASS，${failures.length} 项失败 ====`)
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log(`==== ${pass}/${pass} PASS ====`)
// Batching arms a timer on the unguarded paths; leave explicitly.
process.exit(0)