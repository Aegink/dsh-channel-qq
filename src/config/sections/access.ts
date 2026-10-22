/** 访问门控段（安全）：谁能触发 agent。
 *
 * 三种模式：
 *   - `pairing`（默认）：陌生私聊/未批准的群先回一句「待主人批准」，不进 agent；
 *     主人在后台「安全」页批准后才放行。
 *   - `allowlist`：只放行 `allowUsers` / `allowGroups`（另有已批准列表）。
 *   - `open`：旧行为（任何人可触发），只建议在本机/私有环境使用。
 */

import { b, e, list, n, type FieldGroup } from '../dsl.js'

export interface AccessConfig {
  mode: 'pairing' | 'allowlist' | 'open'
  allowUsers: number[]
  allowGroups: number[]
  /** 新请求私聊通知主人。 */
  notifyOwner: boolean
  /** 同一请求者两次「待批准」回复的最小间隔（分钟）。 */
  replyCooldownMin: number
}

export const ACCESS_GROUPS: FieldGroup[] = [
  {
    id: 'access',
    label: '访问门控',
    page: 'security',
    help: '决定谁能触发 agent。默认 pairing：陌生人先申请，主人批准后放行。',
    fields: {
      mode: e('模式', 'pairing', [
        ['pairing', '配对审批（推荐）'],
        ['allowlist', '仅白名单'],
        ['open', '全部放行（旧行为）'],
      ], {
        hot: 'live',
        help: 'pairing：陌生私聊/未批准的群只回「待主人批准」；allowlist：只认下面的名单；open：任何人都能触发。',
      }),
      allowUsers: list('额外允许的 QQ 号', [], {
        hot: 'live', page: 'security', itemsKind: 'number',
        help: '私聊白名单；与后台已批准列表合并。管理员始终允许。',
      }),
      allowGroups: list('额外允许的群号', [], {
        hot: 'live', page: 'security', itemsKind: 'number',
        help: '群白名单；与后台已批准列表合并。',
      }),
      notifyOwner: b('新请求通知主人', true, { hot: 'live' }),
      replyCooldownMin: n('待批准回复间隔（分钟）', 30, {
        min: 1, max: 1440, hot: 'live', unit: '分钟',
        help: '同一个人/同一个群在这个时间内只回一次「待主人批准」。',
        hiddenIf: { field: 'access.mode', notEquals: 'pairing' },
      }),
    },
  },
]
