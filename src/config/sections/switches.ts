/** 四个"开关型段"的类型本体（P6c `policy` / P6d `tools` / P6f `proactive` / P6g `planner`）。
 *
 * 为什么形状在这里而不是 `config.ts` 内联：那份文件吃着 400 行的硬上限
 * （`scripts/check-size.mjs`），每加一段都要从别处抠一行。把"只有开关和一个
 * 数据块"的三段收成一处、由 `QQChannelConfig` 继承，新增段就不再挤那 400 行。
 *
 * 只放**类型**：字段的中文标签、默认值与热生效标注仍然在各自的 `sections/*.ts`
 * 里（`config.ts` 只 import 类型，运行时一律走 schema）。
 */

import type { EventBook } from '../../core/schedule/event-book.js'
import type { RoomOverride } from '../../core/room-policy.js'

/** 工具策略 v2（P6c）；字段定义见 `sections/safety.ts`。 */
export interface PolicySwitchConfig {
  readonly v2: boolean
}

/** 工具面 v2（P6d）；字段定义见 `sections/tools.ts`。 */
export interface ToolsSwitchConfig {
  readonly v2: boolean
}

/** 事件书（P6f）；字段定义见 `sections/proactive.ts`。 */
export interface ProactiveConfig {
  /** 开关（默认关；关着走旧调度器，行为一字不改）。 */
  readonly v2: boolean
  /** 事件书内容：`{version:1, events:[…]}`（校验见 `core/schedule/event-book.ts`）。 */
  readonly book: EventBook
}

/** 群聊准入（P6g）；字段定义见 `sections/chat.ts`。 */
export interface PlannerSwitchConfig {
  readonly enabled: boolean
}

/** 四段合起来由 `QQChannelConfig` 继承。 */
export interface SwitchSections {
  policy: PolicySwitchConfig
  tools: ToolsSwitchConfig
  proactive: ProactiveConfig
  planner: PlannerSwitchConfig
  /** 按群覆盖（数组：`[{ id, enabled?, requireMention?, talkValue? }]`；缺省 = 跟全局）。 */
  rooms?: RoomOverride[]
}
