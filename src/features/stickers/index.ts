/** 表情包子插件（P5.1）：偷取存储 + 索引库 + 后台资源。
 *
 * 两个对象的分工见各自模块注释：`EmojiStore` 负责把主群里的图存下来，
 * `EmojiLibrary` 负责去重索引、视觉打标与语义检索。`emoji.dir` /
 * `emoji.registeredDir` 变了就地重读（P5.2，对齐旧 `applyEffects` 的两条分支）。
 */

import { EmojiLibrary } from '../../emoji-library.js'
import { EmojiStore } from '../../emoji.js'
import type { SubPlugin } from '../plugin-kit.js'

export const stickersPlugin: SubPlugin = {
  name: 'stickers',
  watches: ['emoji.dir', 'emoji.registeredDir'],
  requires: ['platform'],
  async apply(host) {
    const { api } = host.need('platform')
    const library = new EmojiLibrary(host.config.emoji, host.log)
    await library.load()
    const store = new EmojiStore(host.config.emoji, api, host.log, library)
    await store.init()
    host.provide('emoji', { library, store })
    host.registerResource('emoji', {
      label: '表情包库',
      list: () => {
        const entries = library.list(500)
        return { count: library.list(100000).length, entries }
      },
      remove: async (id) => ({ removed: await library.remove(id) }),
      actions: {
        rescan: async () => await library.rescan(),
      },
    })
    return () => { void library.save() }
  },
  async reload(host) {
    const parts = host.get('emoji')
    if (parts === undefined) return []
    // 旧 applyEffects 的两条说明行按原顺序返回：索引重读 + 偷取目录切换。
    const notes = [await parts.library.reload()]
    await parts.store.init().catch(() => {})
    notes.push('偷取/注册目录已切换（表情索引已重读）')
    return notes
  },
}
