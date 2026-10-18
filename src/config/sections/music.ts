/** 音乐段：酷狗自建 API 的地址（page: music）。
 *
 * 曲库凭据（网易云/酷狗 Cookie）**不进配置**——它们存在 `/etc/dsh/secrets/`，
 * 由后台「音乐」页的扫码登录写入、更新与清除。这里只放"连哪里"这种非秘密参数。
 */

import { s, type FieldGroup } from '../dsl.js'

/** 音乐相关的非秘密配置。 */
export interface MusicConfig {
  /** 酷狗自建 API（KuGouMusicApi）的基地址；空 = 读 `KUGOU_API_BASE`，再回退 127.0.0.1:4000。 */
  kugouApiBase: string
}

export const MUSIC_GROUPS: FieldGroup[] = [
  {
    id: 'music',
    label: '音乐',
    page: 'music',
    fields: {
      // 读法：适配器每次调用现取（hot: live），所以改完不用重启。
      kugouApiBase: s('酷狗 API 地址', 'http://127.0.0.1:4000', {
        hot: 'live',
        help: '自建 KuGouMusicApi 服务的基地址（默认本机 4000）。留空则读环境变量 KUGOU_API_BASE。'
          + '网易云不需要本项——它直连 music.163.com。',
      }),
    },
  },
]
