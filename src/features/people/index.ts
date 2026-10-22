/** 人物档子插件：按房间记录"一个人怎么说话"的线索。
 *
 * 工具侧：`qq_person_note` 支持 get / set / list（默认关，`people.enabled`
 * 为 true 才注册，golden 工具快照不含它）。
 *
 * 上下文注入（personHint）未在本 PR 实现：把"这个人怎么说话"塞进组包需要
 * 在入站组包器按发送者取档，可作为后续增强。
 */

import { registerPeopleTools } from './tools.js'
import type { SubPlugin } from '../plugin-kit.js'

export const peoplePlugin: SubPlugin = {
  name: 'people',
  watches: ['people'],
  apply(host) {
    return registerPeopleTools(host.bridge.toolHost(), host.config, host.log)
  },
}
