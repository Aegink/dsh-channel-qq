/** 情绪与能量（P7.1）：状态机本身 + 它接进组包器的那条缝。
 *
 * 两条性质是本文件的主角：
 *   1. **没有情绪面时组包产物不变**——`emotionHint` 这个槽位从前一直传空串，
 *      现在仍然可以是空串，且空串不进包（golden 盯着整条流水线）；
 *   2. **情绪坏掉不许拦住回话**——取值函数抛错只记一行日志，这一包照常组出来。
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { EmotionStore, ENERGY_BASELINE, MOOD_STALE_MS } = await import('../src/features/emotion/engine.js')
const { PacketComposer } = await import('../src/app/inbound/packet-composer.js')
const { emotionTools } = await import('../src/features/emotion/tools.js')

const HOME = mkdtempSync(path.join(tmpdir(), 'emotion-test-'))
process.on('exit', () => { rmSync(HOME, { recursive: true, force: true }) })

const BASE = Date.parse('2026-10-17T15:00:00+08:00')
const noop = (): void => {}

interface Cfg { enabled: boolean; decayPerHour: number; lowEnergy: number }

function cfg(over: Partial<Cfg> = {}): Cfg {
  return { enabled: true, decayPerHour: 6, lowEnergy: 30, ...over }
}

/** 在冻结时钟下跑一段（能量衰减全靠"距上次记账多久"，不冻结就没得断言）。 */
function frozen<T>(fn: () => T): T {
  mock.timers.enable({ apis: ['Date'], now: BASE })
  try {
    return fn()
  } finally {
    mock.timers.reset()
  }
}

function storeOf(over: Partial<Cfg> = {}): InstanceType<typeof EmotionStore> {
  return new EmotionStore(HOME, noop, () => cfg(over))
}

// ── 状态机 ──────────────────────────────────────────────────────────────────

test('触发词改变心情与能量：夸 → 得意且能量上升', () => {
  frozen(() => {
    const store = storeOf()
    store.observe('你也太厉害了吧')
    const snap = store.snapshot()
    assert.equal(snap.mood, '得意')
    assert.equal(snap.energy, ENERGY_BASELINE + 6)
    assert.equal(snap.lastEvent, '被夸了')
  })
})

test('没有触发词就什么都不变（不为没有变化的消息写盘）', () => {
  frozen(() => {
    const store = storeOf()
    store.observe('今天天气不错，出门走走')
    const snap = store.snapshot()
    assert.equal(snap.mood, '平静')
    assert.equal(snap.energy, ENERGY_BASELINE)
    assert.equal(snap.lastEvent, '')
  })
})

test('能量随时间向静息值靠拢（累了自己会缓过来）', () => {
  frozen(() => {
    const store = storeOf()
    store.observe('你个笨蛋')                       // 委屈 -8
    assert.equal(store.snapshot().energy, ENERGY_BASELINE - 8)
    mock.timers.tick(3_600_000)                     // 一小时，decayPerHour=6
    assert.equal(store.snapshot().energy, ENERGY_BASELINE - 2)
    mock.timers.tick(10 * 3_600_000)                // 再久一点就停在静息值
    assert.equal(store.snapshot().energy, ENERGY_BASELINE)
  })
})

test('心情过了保鲜期淡回平静，lastEvent 一起清掉', () => {
  frozen(() => {
    const store = storeOf()
    store.observe('你真聪明')                       // 得意
    assert.equal(store.snapshot().mood, '得意')
    mock.timers.tick(MOOD_STALE_MS)
    const snap = store.snapshot()
    assert.equal(snap.mood, '平静')
    assert.equal(snap.lastEvent, '')
  })
})

test('一个回合花掉力气（spend 扣能量）', () => {
  frozen(() => {
    const store = storeOf()
    store.spend()
    assert.equal(store.snapshot().energy, ENERGY_BASELINE - 2)
  })
})

test('提示按能量分档给方向（足 / 中 / 偏低 / 低）', () => {
  frozen(() => {
    const high = storeOf()
    for (let i = 0; i < 3; i++) high.observe('这个 bug 又来了')   // 兴奋 +8 ×3 → 84
    assert.match(high.hint(), /（足）——想多说就多说/)

    const mid = storeOf()
    assert.match(mid.hint(), /（中）——正常说/)

    const low = storeOf()
    for (let i = 0; i < 4; i++) low.observe('讨厌')               // 委屈 -8 ×4 → 28
    assert.match(low.hint(), /（偏低）——句子短一点/)

    const spent = storeOf()
    for (let i = 0; i < 5; i++) spent.observe('闭嘴')             // → 20
    assert.match(spent.hint(), /（低）——只回必要的话/)
  })
})

test('关掉情绪提示：hint 恒空串、能量恒为静息值、记账不改状态', () => {
  frozen(() => {
    const store = storeOf({ enabled: false })
    store.observe('你真厉害')
    store.spend()
    assert.equal(store.hint(), '')
    assert.equal(store.energy(), ENERGY_BASELINE)
    assert.equal(store.snapshot().mood, '平静')
  })
})

// ── 模型自己记账（qq_set_emotion） ──────────────────────────────────────────

test('book：心情被覆盖、能量按增减走、理由截断到 20 字', async () => {
  const store = storeOf()
  const result = await store.book('委屈', -10, '被说「你怎么这么笨」了，有点难受，不想说话')
  assert.equal(result.ok, true)
  assert.equal(result.mood, '委屈')
  const snap = store.snapshot()
  assert.equal(snap.mood, '委屈')
  assert.equal(snap.energy, ENERGY_BASELINE - 10)
  assert.equal(snap.lastEvent.length, 20, '理由要截断：它会进每一包的提示行')
})

test('book：不认识的心情被拒；关掉时不写状态', async () => {
  const store = storeOf()
  const bad = await store.book('暴躁', 5, 'x')
  assert.equal(bad.ok, false)
  assert.match(bad.note, /心情只能是/)
  assert.equal(store.snapshot().mood, '平静')

  const off = storeOf({ enabled: false })
  assert.equal((await off.book('开心', 5, 'x')).ok, false)
  assert.equal(off.snapshot().mood, '平静')
})

test('工具 qq_set_emotion：委派给引擎；没装情绪面时给出可读拒绝', async () => {
  const store = storeOf()
  const spec = emotionTools({ emotion: store } as never)[0]!
  assert.equal(spec.name, 'qq_set_emotion')
  const out = await spec.run({ mood: '得意', energy: 8, reason: '被夸' }) as { ok: boolean; mood: string }
  assert.equal(out.ok, true)
  assert.equal(out.mood, '得意')
  assert.equal(store.snapshot().energy, ENERGY_BASELINE + 8)

  const bare = emotionTools({} as never)[0]!
  const denied = await bare.run({ mood: '开心', reason: 'x' }) as { ok: boolean; note: string }
  assert.equal(denied.ok, false)
  assert.match(denied.note, /未启用/)
})

test('读盘：形状对就照用，形状不对退回初值', async () => {
  const file = path.join(HOME, 'emotion.json')
  // `updated` 用**现在**：衰减按「距上次记账多久」算，写成固定的过去时间会让这条
  // 断言变成「八天后心情早淡了、能量早回静息值了」——那是另一条测试的事。
  writeFileSync(file, JSON.stringify({ mood: '生气', energy: 20, lastEvent: '被凶了', updated: Date.now() }), 'utf8')
  const loaded = storeOf()
  await loaded.load()
  assert.equal(loaded.snapshot().mood, '生气')
  assert.equal(loaded.energy(), 20)

  writeFileSync(file, JSON.stringify({ mood: '不知道什么心情', energy: '很高' }), 'utf8')
  const broken = storeOf()
  await broken.load()
  assert.equal(broken.snapshot().mood, '平静')
  assert.equal(broken.energy(), ENERGY_BASELINE)
})

// ── 接进组包器的那条缝 ──────────────────────────────────────────────────────

const NOW = Date.parse('2026-10-17T15:00:00+08:00')
const QUEUE_TEXT = '群里在聊部署的事，说要不要上新机器'

interface GroupInput { emotionHint: string }

/** 只留下要断言的那个字段：人格模板渲染不是本测试的对象。 */
function composer(emotion: (() => { observe(text: string): void; spend(): void; hint(): string; energy(): number } | null) | undefined, logs: string[] = []): InstanceType<typeof PacketComposer> {
  return new PacketComposer({
    prompts: {
      groupPacket: (input: GroupInput) => JSON.stringify(input),
      roomDirective: () => '',
    },
    clock: { now: () => NOW },
    config: () => ({ imageRecognition: { maxPerMessage: 1 }, contextBudget: { compactChars: 4000 } }),
    log: (line: string) => logs.push(line),
    knowledge: () => null,
    ...(emotion === undefined ? {} : { emotion }),
    sentBlockFor: async () => '',
  } as never)
}

function conversation(): unknown {
  return { key: 'qq-group-107', chatId: 107, isGroup: true, queue: [QUEUE_TEXT], pendingImages: [], calledLine: false }
}

async function packetOf(c: InstanceType<typeof PacketComposer>): Promise<GroupInput> {
  const packet = await c.compose(conversation() as never)
  return JSON.parse(packet.text) as GroupInput
}

test('没装情绪面：这一包不带情绪提示（与从前逐字节一致）', async () => {
  assert.equal((await packetOf(composer(undefined))).emotionHint, '')
  assert.equal((await packetOf(composer(() => null))).emotionHint, '')
})

test('装了情绪面：提示进包，且这一包同时记了账、花了力气', async () => {
  const calls: string[] = []
  const surface = {
    observe: (text: string) => { calls.push(`observe:${text}`) },
    spend: () => { calls.push('spend') },
    hint: () => '【此刻】心情兴奋，能量 84/100（足）——想多说就多说，也可以主动起个话头',
    energy: () => 84,
  }
  const input = await packetOf(composer(() => surface))
  assert.equal(input.emotionHint, surface.hint())
  assert.deepEqual(calls, [`observe:${QUEUE_TEXT}`, 'spend'])
})

test('情绪面抛错：记一行日志，这一包照常组出来', async () => {
  const logs: string[] = []
  const broken = {
    observe: () => { throw new Error('磁盘满了') },
    spend: noop,
    hint: () => '不该被调用',
    energy: () => 0,
  }
  const input = await packetOf(composer(() => broken, logs))
  assert.equal(input.emotionHint, '')
  assert.ok(logs.some((line) => line.includes('emotion hint failed') && line.includes('磁盘满了')))
})
