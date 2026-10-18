/** 歌单子插件（P5.1）：只注册后台的「歌单」资源表。
 *
 * 播歌工具面在 `qq-tools` 的 music 组里（注册顺序属于提示词内容，不拆）；
 * 这里承载的是歌单文件的读写——面板加歌 / 删歌与 `qq_music_playlist`
 * 工具看的是同一个 `music-playlist.json`。
 */

import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { readJson } from '../../read-json.js'
import type { SubPlugin } from '../plugin-kit.js'

export const musicPlugin: SubPlugin = {
  name: 'music',
  watches: [],
  apply(host) {
    const playlistFile = (): string => path.join(host.config.workspacePath ?? path.join(host.dshHome, 'channel-qq'), 'music-playlist.json')
    host.registerResource('playlist', {
      label: '歌单',
      list: async () => {
        const songs = await readJson<unknown[]>(playlistFile(), [])
        return { count: songs.length, songs }
      },
      create: async (body) => {
        if (host.config.workspacePath === null) throw new Error('未配置工作区')
        const file = playlistFile()
        const songs = await readJson<Array<Record<string, unknown>>>(file, [])
        const songId = String(body.songId ?? '')
        if (songId === '') throw new Error('songId 不能为空')
        if (songs.some((s) => String(s.id) === songId)) return { added: false, note: '歌单里已有这首' }
        songs.unshift({ id: songId, name: String(body.name ?? ''), artists: body.artists === undefined ? undefined : String(body.artists), addedAt: Date.now() })
        await atomicWriteFile(file, JSON.stringify(songs, null, 1))
        return { added: true, total: songs.length }
      },
      remove: async (id) => {
        if (host.config.workspacePath === null) throw new Error('未配置工作区')
        const file = playlistFile()
        const songs = await readJson<Array<Record<string, unknown>>>(file, [])
        const kept = songs.filter((s) => String(s.id) !== id)
        await atomicWriteFile(file, JSON.stringify(kept, null, 1))
        return { removed: songs.length - kept.length }
      },
    })
  },
}
