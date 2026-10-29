/** 情绪子插件：心情与能量的状态机 + 后台可见的投影。
 *
 * 它只做两件事：把 `EmotionStore` 放进服务袋（组包器与主动行为各自取用），
 * 以及把当前读数挂到后台「人格」页。**没有工具**：情绪不是模型手里的旋钮——
 * 它由入站文字自己推动、自己回落；模型能看到的只是组包时那一行提示。
 *
 * 不声明 `reload`：三个旋钮都是引擎现取配置（`() => host.config.emotion`），
 * 所以后台保存后的重挂只是**重读一次 `emotion.json`**——状态在盘上，不会丢。
 */

import { EmotionStore } from './engine.js'
import type { SubPlugin } from '../plugin-kit.js'

export const emotionPlugin: SubPlugin = {
  name: 'emotion',
  watches: ['emotion'],
  async apply(host) {
    const emotion = new EmotionStore(host.dshHome, host.log, () => host.config.emotion)
    await emotion.load()
    host.provide('emotion', emotion)
    host.registerResource('emotion', {
      label: '情绪与能量',
      list: () => emotion.snapshot(),
    })
  },
}
