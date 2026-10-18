/** 消息发送与撤回：6 个工具。
 *
 * 发送 / 引用回复 / 撤回 / 戳一戳 / 点赞。
 *
 * 这些 spec **逐字节**来自原来的 `registerQQTools`——P4 的判据是工具名与
 * 参数 schema 一条都不许变（`test/golden/tools/qq-tools.txt` 钉着这一点）。
 * 一个工具一个函数：单看一个工具时不必在 1200 行里找它的边界。
 */

import { looksLikeCode } from '../../core/guards/code.js'
import { isInnerMonologueLeak } from '../../core/guards/monologue.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import { smartSplitMessage } from '../../outbound.js'
import { segmentText } from '../../core/text/segment.js'
import type { QQToolDeps } from '../tool-deps.js'
import { dmRoom, groupRoom } from '../../core/room.js'

/**
 * 记一条"咱发过的话"。
 *
 * OneBotClient.call() 成功时给的是 data 本身（见 B13）：这里读 `.data.message_id`
 * 曾经多读了一层，于是 sent-log 的 messageId 全为 null。这条注释跟着这段代码走。
 */
/**
 * 取这个房间的 sent-log。
 *
 * 从前这里拿的是**主群那一份**单例：于是私聊的发言被记进 `sent-group-<主群>.json`，
 * 私聊的引用链也就从未存在过（2026-10-18 审计实证）。现在按房间取，缺 hub 时才退回。
 */
async function sentLogFor(deps: QQToolDeps, isGroup: boolean, target: number): Promise<QQToolDeps['sentLog']> {
  const room = isGroup ? groupRoom(target) : dmRoom(target)
  if (deps.sentLogHub !== undefined) return await deps.sentLogHub.for(room)
  return deps.sentLog
}

async function recordSent(
  sentLog: QQToolDeps['sentLog'],
  result: unknown,
  text: string,
): Promise<void> {
  if (!sentLog) return
  const mid = (result as { message_id?: number } | null)?.message_id ?? null
  await sentLog.add({ messageId: typeof mid === 'number' ? mid : null, quotedId: null, text, time: Date.now() })
}

/** `qq_send_text` — 发送一条QQ文本消息。isGroup=true 时 target 为群号，否则为好友QQ号。当前会话窗口的归属见系统包里… */
function qqSendText(deps: QQToolDeps): ToolSpec {
  const { api, out, config, log, sentLog } = deps
  const knownGroupIds = deps.knownGroups
  return {
        name: 'qq_send_text',
        description: '发送一条QQ文本消息。isGroup=true 时 target 为群号，否则为好友QQ号。当前会话窗口的归属见系统包里的【本会话是QQ群/私聊】标注——往哪发必须与之一致，发错窗口是大事故。',
        parameters: {
          type: 'object',
          properties: {
            isGroup: { type: 'boolean', description: '是否发送到群聊' },
            target: { type: 'number', description: '群号或好友QQ号' },
            text: { type: 'string', description: '消息文本' },
          },
          required: ['isGroup', 'target', 'text'],
        },
        run: async (args) => {
          const text = String(args.text ?? '').trim().replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim()
          if (text === '') throw new Error('消息文本为空（只有思考没有正文），先想清楚要说什么再发。')
          await assertWindowReachable(deps, args)
          assertGroupTextAllowed(deps, text, args.isGroup === true)
          await assertTargetAllowed(deps, args)
          // P6h：开关打开时按句拆成几条发（像人连着说话）。关着就是一条。
          const pieces = segmentText(text, config.segmentation)
          const isGroup = args.isGroup === true
          const target = Number(args.target)
          let last: unknown = null
          for (const piece of pieces) {
            // 单条仍然要过硬切分：分段之后再长过 OneBot 上限的，只能按长度切。
            for (const chunk of smartSplitMessage(piece, config.maxMessageLength)) {
              const message: OneBotMessageSegment[] = [{ type: 'text', data: { text: chunk } }]
              last = isGroup
                ? await out.push(() => api.sendGroupMessage(target, message))
                : await out.push(() => api.sendPrivateMessage(target, message))
              await recordSent(await sentLogFor(deps, isGroup, target), last, chunk)
            }
          }
          return { ...(last as Record<string, unknown> | null), segments: pieces.length }
        },
      }
}

/** `qq_reply_quote` — 引用回复某条消息：带上对方消息的#编号发一条引用回复，让对方明确知道咱回应的是哪条。文本里不要重复#编号。… */
function qqReplyQuote(deps: QQToolDeps): ToolSpec {
  const { api, out, log, sentLog } = deps
  const knownGroupIds = deps.knownGroups
  return {
        name: 'qq_reply_quote',
        description: '引用回复某条消息：带上对方消息的#编号发一条引用回复，让对方明确知道咱回应的是哪条。文本里不要重复#编号。',
        parameters: {
          type: 'object',
          properties: {
            isGroup: { type: 'boolean', description: '是否群聊' },
            target: { type: 'number', description: '群号或对方QQ号' },
            messageId: { type: 'number', description: '要引用的消息#编号（来自上下文包）' },
            text: { type: 'string', description: '回复正文' },
          },
          required: ['isGroup', 'target', 'messageId', 'text'],
        },
        run: async (args) => {
          const text = String(args.text ?? '').trim().replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim()
          if (text === '') throw new Error('回复文本为空（只有思考没有正文）。引用哪条、说什么，想好了再发。')
          // 【发前验证窗口】群引用必须发进自己真的加入了的群。与 qq_send_text 用同
          // 一个判据（原先这里查 get_group_info 存在性、那边只认主群，两套规则）。
          if (args.isGroup === true) {
            const target = Number(args.target)
            const known = await knownGroupIds()
            if (!known.has(target)) {
              throw new Error(`窗口验证失败：群 ${target} 不是咱加入的群（已知：${[...known].join(',') || '无'}）。先核对窗口再引用回复。`)
            }
          }
          if (args.isGroup === true && looksLikeCode(text)) {
            throw new Error('群聊禁止发代码。请改用 qq_send_code_review 把代码私信给学弟审核，群里用引用只回一句"已私信学弟审核"。')
          }
          // 内心戏外泄闸门：沉默决定/舞台指示/战况盘算不是群消息
          if (args.isGroup === true && isInnerMonologueLeak(text)) {
            log(`blocked inner-monologue leak (quote): ${text.slice(0, 40)}`)
            throw new Error('这条是咱的内部盘算/舞台指示，不是要说的话，已拦下。要么把真正要对群里说的那句话引用发出来，要么不调用任何发送工具直接结束回合。')
          }
          const message: OneBotMessageSegment[] = [
            { type: 'reply', data: { id: String(args.messageId) } },
            { type: 'text', data: { text } },
          ]
          const result = args.isGroup === true
            ? await out.push(() => api.sendGroupMessage(Number(args.target), message))
            : await out.push(() => api.sendPrivateMessage(Number(args.target), message))
          const roomLog = await sentLogFor(deps, args.isGroup === true, Number(args.target))
          if (roomLog) {
            // OneBotClient.call() 成功时给的是 data 本身（见 B13）：这里读 .data.message_id
            // 曾经多读了一层，于是 sent-log 的 messageId 全为 null。
            const mid = (result as { message_id?: number } | null)?.message_id ?? null
            await roomLog.add({ messageId: typeof mid === 'number' ? mid : null, quotedId: Number(args.messageId) || null, text, time: Date.now() })
          }
          return result
        },
      }
}

/** `qq_send_code_review` — 【群聊代码专用】群聊禁止出现代码。有人在群里要求写代码时，把完整代码用这个工具私信发给学弟（管理员）审核，群里只回一句"… */
function qqSendCodeReview(deps: QQToolDeps): ToolSpec {
  const { api, out, config } = deps
  return {
        name: 'qq_send_code_review',
        description: '【群聊代码专用】群聊禁止出现代码。有人在群里要求写代码时，把完整代码用这个工具私信发给学弟（管理员）审核，群里只回一句"代码已私信发给学弟审核"。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '完整代码内容' },
            note: { type: 'string', description: '一句话说明这段代码是干什么的、谁要的' },
          },
          required: ['code'],
        },
        run: async (args) => {
          const master = config.admins[0]
          if (master === undefined) throw new Error('没有配置管理员QQ')
          const text = `【代码审核】${String(args.note ?? '')}

  ${String(args.code ?? '')}`
          const message: OneBotMessageSegment[] = [{ type: 'text', data: { text } }]
          return out.push(() => api.sendPrivateMessage(master, message))
        },
      }
}

/** `qq_send_poke` — 戳一戳群成员。… */
function qqSendPoke(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_send_poke',
        description: '戳一戳群成员。',
        parameters: {
          type: 'object',
          properties: {
            groupId: { type: 'number', description: '群号' },
            userId: { type: 'number', description: '要戳的用户QQ号' },
          },
          required: ['groupId', 'userId'],
        },
        run: async (args) => api.groupPoke(Number(args.groupId), Number(args.userId)),
      }
}

/** `qq_delete_msg` — 撤回一条消息（需要对应权限）。… */
function qqDeleteMsg(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_delete_msg',
        description: '撤回一条消息（需要对应权限）。',
        parameters: {
          type: 'object',
          properties: { messageId: { type: 'number' } },
          required: ['messageId'],
        },
        run: async (args) => api.deleteMessage(Number(args.messageId)),
      }
}

/** `qq_send_like` — 给好友点赞。… */
function qqSendLike(deps: QQToolDeps): ToolSpec {
  const { api } = deps
  return {
        name: 'qq_send_like',
        description: '给好友点赞。',
        parameters: {
          type: 'object',
          properties: { userId: { type: 'number' }, times: { type: 'number', description: '点赞次数（≤10）' } },
          required: ['userId'],
        },
        run: async (args) => api.sendLike(Number(args.userId), Math.min(Number(args.times ?? 1), 10)),
      }
}

/** 组装这一组工具。 */
export function messagingTools(deps: QQToolDeps): ToolSpec[] {
  return [
    qqSendText(deps),
    qqReplyQuote(deps),
    qqSendCodeReview(deps),
    qqSendPoke(deps),
    qqDeleteMsg(deps),
    qqSendLike(deps),
  ]
}

// ── 发送前三道闸门 ───────────────────────────────────────────────────────────
//
// 它们原来内联在 `qq_send_text` 的 run 里，一个函数 67 行、四件事混在一起：
// "窗口对不对""内容能不能进群""目标合不合法"和"发"。拆成三个函数之后，每一道
// 闸门都能单独读、单独测，而 `qq_send_text` 只剩"取文本 → 过闸门 → 发"。

/**
 * 闸门 1：**窗口存在吗**。
 *
 * 先问 QQ"这个群/这个人是不是真的"，再发——发错窗口是大事故（见
 * `core/room.ts` 里 2026-10-14 那次误发的记录）。群要能查到群名，私聊要求对方
 * 是好友或者是学弟本人。
 */
async function assertWindowReachable(deps: QQToolDeps, args: Record<string, unknown>): Promise<void> {
  const { api, config } = deps
  if (args.isGroup === true) {
    const gi = await api.getGroupInfo(Number(args.target)).catch(() => null) as { group_name?: string } | null
    if (!gi || !gi.group_name) throw new Error(`窗口验证失败：群 ${args.target} 不存在或不可达。别发了，先核对窗口。`)
    return
  }
  const fi = await api.getFriendList().catch(() => null) as Array<{ user_id?: number }> | null
  const friend = Array.isArray(fi) ? fi.find((f) => Number(f.user_id) === Number(args.target)) : null
  if (!friend && Number(args.target) !== Number(config.admins[0] ?? 0)) {
    throw new Error(`窗口验证失败：${args.target} 不是咱的好友也不是学弟。别给陌生人发私聊。`)
  }
}

/**
 * 闸门 2：**这段内容能进群吗**。
 *
 * 两条禁令各有来历：
 *   - **代码不进群**：群聊里贴代码既刷屏又容易泄露工作区内容，让她改成私信学弟审核；
 *   - **内心戏不进群**：一次真实事故——她决定"本轮先不说话"，然后把这个决定本身
 *     当成消息发了出去（判据见 `core/guards/monologue.ts`）。
 */
function assertGroupTextAllowed(deps: QQToolDeps, text: string, isGroup: boolean): void {
  if (!isGroup) return
  if (looksLikeCode(text)) {
    throw new Error('群聊禁止发代码。请改用 qq_send_code_review 把代码私信给学弟审核，群里只回一句"已私信学弟审核"。')
  }
  if (isInnerMonologueLeak(text)) {
    deps.log(`blocked inner-monologue leak: ${text.slice(0, 40)}`)
    throw new Error('这条是咱的内部盘算/舞台指示，不是要说的话，已拦下。要么把真正要对群里说的那句话发出来，要么不调用任何发送工具直接结束回合。')
  }
}

/**
 * 闸门 3：**目标合不合法**。
 *
 * 群必须是**咱确实是成员**的群（`knownGroups` 缓存了 `get_group_list`）；私聊只发
 * 管理员。这里以前只认 `[config.primaryGroup]`，于是除主群以外的群一律抛错——而
 * `qq_reply_quote` 用的是"群真实存在即可"，同一个动作两套规则、互相矛盾。
 */
async function assertTargetAllowed(deps: QQToolDeps, args: Record<string, unknown>): Promise<void> {
  const { config } = deps
  if (args.isGroup === true) {
    const target = Number(args.target)
    const known = await deps.knownGroups()
    if (!known.has(target)) {
      throw new Error(`目标群 ${target} 不是咱加入的群（已知：${[...known].join(',') || '无'}）。发错窗口是大事故，先核对。`)
    }
    return
  }
  const master = config.admins[0]
  if (master !== undefined && Number(args.target) !== master && !config.admins.includes(Number(args.target))) {
    throw new Error(`私聊目标 ${args.target} 不是管理员。除学弟外不要私聊陌生人。`)
  }
}
