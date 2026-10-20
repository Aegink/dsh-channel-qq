/** 会话换血阈值：纯函数边界。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldResetSession } from '../src/core/session-reset.js'

test('窗口未知 / 非有限值：不换血', () => {
  assert.equal(shouldResetSession(1_000_000, null, 0.7), false)
  assert.equal(shouldResetSession(Number.NaN, 128_000, 0.7), false)
  assert.equal(shouldResetSession(100, 0, 0.7), false)
  assert.equal(shouldResetSession(-1, 128_000, 0.7), false)
})

test('按比例触发；比例被夹在 0.1–0.95', () => {
  assert.equal(shouldResetSession(89_599, 128_000, 0.7), false)
  assert.equal(shouldResetSession(89_600, 128_000, 0.7), true)
  // 比例过低被夹到 0.1：128000*0.1=12800
  assert.equal(shouldResetSession(12_799, 128_000, 0), false)
  assert.equal(shouldResetSession(12_800, 128_000, 0), true)
  // 比例过高被夹到 0.95
  assert.equal(shouldResetSession(121_599, 128_000, 2), false)
  assert.equal(shouldResetSession(121_600, 128_000, 2), true)
})

test('1M 窗口：27.8 万 token 不触发（留出压缩余量）', () => {
  assert.equal(shouldResetSession(278_000, 1_048_576, 0.7), false)
  assert.equal(shouldResetSession(734_004, 1_048_576, 0.7), true)
})
