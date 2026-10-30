/** 供应商路由名的清洗（issue 反馈：填中文、填英文都存不了）。
 *
 * 规则本身来自宿主（llm-pi-ai 的路由名只能是 `[a-z0-9-]`），错的是**让用户去满足它**：
 * 「路由名」是内部标识，用户只想填个看得懂的名字。所以保存前先清洗、清洗不出东西
 * 就用 baseURL 的域名推导——这一组断言钉住的就是"什么输入都能落到一个合法名字上"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { slugifyProviderName } = await import('../src/adapters/dsh-host/providers.js')

const URL_UNISOUND = 'https://maas-api.unisound.com/v1'

test('供应商名：本来就是合法英文名就原样保留', () => {
  assert.equal(slugifyProviderName('unisound', URL_UNISOUND), 'unisound')
  assert.equal(slugifyProviderName('my-provider-2', URL_UNISOUND), 'my-provider-2')
})

test('供应商名：大写、空格、中文都被清洗成连字符', () => {
  assert.equal(slugifyProviderName('UniSound 智能', URL_UNISOUND), 'unisound')
  assert.equal(slugifyProviderName('  A__B  ', URL_UNISOUND), 'a-b')
})

test('供应商名：清洗不出东西就用 baseURL 的域名推导', () => {
  // 中文名 → 域名（去掉常见顶级域，短一点好记）
  assert.equal(slugifyProviderName('友声智能', URL_UNISOUND), 'maas-api-unisound')
  // 名字留空 → 同样走域名
  assert.equal(slugifyProviderName('', URL_UNISOUND), 'maas-api-unisound')
  assert.equal(slugifyProviderName('   ', 'https://www.example.com/v1'), 'example')
})

test('供应商名：名字和域名都推不出合法值时返回空串，由调用方报错', () => {
  assert.equal(slugifyProviderName('中文名', 'not a url'), '')
  assert.equal(slugifyProviderName('中文名', ''), '')
})

test('供应商名：结果永远满足 [a-z0-9-] 且不以连字符开头/结尾', () => {
  for (const raw of ['友声', 'Uni Sound', '---x---', 'x'.repeat(80), '日本語のなまえ']) {
    const name = slugifyProviderName(raw, URL_UNISOUND)
    assert.match(name, /^[a-z0-9][a-z0-9-]*$/, `${raw} → ${name}`)
    assert.ok(name.length <= 40)
  }
})
