/** 掉线诊断：连不上时日志/后台要能说清"为什么"。
 *
 * 2026-10-31 的事故：QQ 从 04:24 起就没登录（机器正常关机重启后卡在扫码页），
 * 而插件日志只有一句接一句的 `reconnecting in 60000ms`——看不出是"没启动"还是
 * "没登录"，人只能靠猜。现在两种情形各有各的说法，后台面板也会亮红字。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { outageHint, OneBotClient } = await import('../src/onebot.js')

test('掉线诊断：连接被拒 = 协议端没在监听', () => {
  assert.match(outageHint('connect ECONNREFUSED 127.0.0.1:3001'), /没有在监听/)
  assert.match(outageHint('getaddrinfo ENOTFOUND napcat'), /没有在监听/)
})

test('掉线诊断：端口有人接但马上被关 = 多半是 QQ 未登录', () => {
  // docker-proxy 占着宿主端口时，客户端能连上、随即被关；这才是"未登录"的形状。
  assert.match(outageHint(null), /未登录/)
  assert.match(outageHint('socket hang up'), /未登录/)
})

test('掉线诊断：刚起来还没断过 → outage() 为 null', () => {
  const client = new OneBotClient(
    { mode: 'forward', url: 'ws://127.0.0.1:3001' },
    undefined,
    () => {},
  )
  assert.equal(client.outage(), null, '没断线就不该报离线')
})
