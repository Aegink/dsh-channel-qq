/** 模型供应商页：列表 · 编辑 · 删除 · 五档实测 · 一键切换默认。
 *
 * 为什么要有"实测"：2026-10-17 的真实教训——某供应商小请求 12 秒正常，600KB
 * 的大请求直接挂死；只测"能连通"会给出假阳性，换过去才发现机器人回不了话。
 * 五档按所选协议发真实请求（completions / responses / messages 形状不同）。
 *
 * 请求头：pi-ai 原生支持每供应商 `headers`；内置 CC / Codex 两个预设（值来自
 * 官方源码与开源实现，见 provider-headers.ts）。`user-agent` 由宿主保留，填了
 * 也会被覆盖——预设里因此不含它，界面上明说。
 */

import { el } from '../dom.js'
import { api, errText } from '../api.js'
import { button, emptyBox, kvList, section } from '../components/card.js'
import { toast } from '../components/toast.js'

const PROTOCOLS = [
  ['openai-completions', 'OpenAI Chat Completions'],
  ['openai-responses', 'OpenAI Responses API'],
  ['anthropic-messages', 'Anthropic Messages'],
]

const fmtDur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

let host = null
let editing = null
let draftHeaders = []

function render(h) {
  host = h
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)
  const cur = section({ title: '当前默认模型', icon: 'plug' })
  const curBox = el('div', { class: 'stack' })
  cur.body.appendChild(curBox)
  view.appendChild(cur.node)
  const list = section({ title: '供应商', icon: 'db', blurb: '读写走 dsh 原生接口（settings / agentDefaultModel / 凭据缝）——保存与切换即刻生效，不需要重启。' })
  const listBox = el('div', { class: 'stack' })
  list.body.appendChild(listBox)
  view.appendChild(list.node)
  const form = section({ title: editing === null ? '添加供应商' : `编辑「${editing.name}」`, icon: 'gear', blurb: '同名即覆盖。密钥留空表示不改；请求头整组替换。' })
  form.body.appendChild(editForm())
  view.appendChild(form.node)
  void load(curBox, listBox)
}

async function load(curBox, listBox) {
  const res = await api('/api/providers')
  curBox.textContent = ''
  listBox.textContent = ''
  if (res.status !== 200 || res.body?.ok !== true) {
    curBox.appendChild(emptyBox('供应商接口不可用', String(res.body?.note ?? res.body?.error ?? errText(res)), 'alert'))
    return
  }
  const cur = res.body.current ?? null
  curBox.appendChild(kvList([
    ['默认供应商', cur === null ? '（未设置）' : String(cur.provider)],
    ['默认模型', cur === null ? '—' : String(cur.model)],
  ]))
  const providers = Array.isArray(res.body.providers) ? res.body.providers : []
  if (providers.length === 0) {
    listBox.appendChild(emptyBox('还没有供应商', '用下面的表单添加第一个。', 'plug'))
    return
  }
  for (const provider of providers) listBox.appendChild(providerCard(provider, cur, () => void load(curBox, listBox)))
}

function providerCard(p, cur, reload) {
  const isDefault = cur !== null && String(cur.provider) === String(p.name)
  const card = el('div', { class: 'objrow' })
  const head = el('div', { class: 'objhead' })
  const title = el('div', { class: 'objtitle' })
  title.appendChild(el('strong', { text: String(p.displayName ?? p.name) }))
  title.appendChild(el('code', { class: 'tiny mute', text: String(p.name) }))
  if (isDefault) title.appendChild(el('span', { class: 'pill ok', text: '当前默认' }))
  head.appendChild(el('div', { class: 'grow' }, [title]))
  const del = button('删除', 'small danger', 'trash')
  del.addEventListener('click', async () => {
    if (!window.confirm(`删除供应商「${p.name}」？`)) return
    const res = await api(`/api/providers?name=${encodeURIComponent(p.name)}`, { method: 'DELETE' })
    if (res.status !== 200) { toast(`删除失败：${errText(res)}`, 'bad', 9000); return }
    toast(String(res.body?.note ?? '已删除'), 'ok')
    reload()
  })
  const edit = button('编辑', 'small', 'wand')
  edit.addEventListener('click', () => {
    editing = p
    draftHeaders = Object.entries(p.headers ?? {}).map(([k, v]) => ({ k, v }))
    render(host)
  })
  head.appendChild(el('div', { class: 'rowbtns' }, [edit, del]))
  card.appendChild(head)
  card.appendChild(el('div', { class: 'objmeta tiny mute', text: `${p.api} · ${p.baseURL} · 密钥 ${p.apiKeyEnv || '（未引用）'} ${p.keyConfigured ? '· 已配置' : '· 未配置'}` }))
  const hdrs = Object.keys(p.headers ?? {})
  card.appendChild(el('div', { class: 'objmeta tiny' }, [
    el('span', { class: 'mute', text: `请求头 ${hdrs.length} 个：` }),
    ...hdrs.length === 0 ? [el('span', { class: 'mute', text: '（无）' })] : hdrs.map((k) => el('span', { class: 'tag', text: k })),
  ]))
  const modelRow = el('div', { class: 'rowflex', style: 'margin-top:8px' })
  for (const m of p.models ?? []) {
    const b = button(`${isDefault && cur.model === m ? '当前：' : '设为默认：'}${m}`, 'small', 'check')
    b.disabled = isDefault && cur.model === m
    b.addEventListener('click', async () => {
      b.disabled = true
      const res = await api('/api/providers/default', { method: 'POST', body: { provider: p.name, model: m } })
      if (res.status !== 200) { toast(`切换失败：${errText(res)}`, 'bad', 9000); b.disabled = false; return }
      toast(String(res.body?.note ?? '已切换'), 'ok', 7000)
      reload()
    })
    modelRow.appendChild(b)
  }
  const testBtn = button('实测（五档）', 'small', 'flask')
  modelRow.appendChild(testBtn)
  card.appendChild(modelRow)
  const resultBox = el('div', { class: 'testout' })
  card.appendChild(resultBox)
  testBtn.addEventListener('click', () => void runTest(String(p.name), testBtn, resultBox))
  return card
}

async function runTest(name, btn, box) {
  btn.disabled = true
  box.textContent = ''
  box.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '实测中：五档依次进行，最长约 3 分钟…' })]))
  const res = await api('/api/providers/test', { method: 'POST', body: { name } })
  btn.disabled = false
  box.textContent = ''
  if (res.status !== 200) { box.appendChild(emptyBox('实测失败', errText(res), 'alert')); return }
  const report = res.body?.report
  if (report === null || report === undefined) { box.appendChild(emptyBox('没有结果', '服务器没有返回报告', 'alert')); return }
  const table = el('table', { class: 'table' })
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { text: '档位' }), el('th', { text: '结果' }), el('th', { text: '耗时' }), el('th', { text: '说明' }),
  ])]))
  const tbody = el('tbody')
  for (const s of report.steps ?? []) {
    tbody.appendChild(el('tr', {}, [
      el('td', { text: String(s.step ?? '') }),
      el('td', {}, [el('span', { class: 'pill ' + (s.ok === true ? 'ok' : 'bad'), text: s.ok === true ? '通过' : '失败' })]),
      el('td', { class: 'mono tiny', text: fmtDur(Number(s.ms ?? 0)) }),
      el('td', { class: 'tiny mute', text: String(s.note ?? (s.httpStatus === undefined ? '' : `HTTP ${s.httpStatus}`)) }),
    ]))
  }
  table.appendChild(tbody)
  box.appendChild(el('div', { class: 'tiny mute', style: 'margin-bottom:6px', text: `协议 ${report.protocol} · 模型 ${report.model}` }))
  box.appendChild(table)
  toast(report.ok === true ? `${name}：五档全过，可以切` : `${name}：有档位没过，别切它`, report.ok === true ? 'ok' : 'bad', 9000)
}

function headerRows() {
  const wrap = el('div', { class: 'hdreditor' })
  const list = el('div', { class: 'stack' })
  const draw = () => {
    list.textContent = ''
    draftHeaders.forEach((row, i) => {
      const name = el('input', { type: 'text', placeholder: 'X-Header-Name', value: row.k })
      const value = el('input', { type: 'text', placeholder: '值', value: row.v })
      name.addEventListener('input', () => { row.k = name.value })
      value.addEventListener('input', () => { row.v = value.value })
      const rm = button('', 'small ghost', 'trash')
      rm.setAttribute('aria-label', '删除这一行')
      rm.addEventListener('click', () => { draftHeaders.splice(i, 1); draw() })
      list.appendChild(el('div', { class: 'hdrrow' }, [name, value, rm]))
    })
    if (draftHeaders.length === 0) list.appendChild(el('div', { class: 'tiny mute', text: '（没有自定义请求头）' }))
  }
  draw()
  const add = button('添加一行', 'small', 'plus')
  add.addEventListener('click', () => { draftHeaders.push({ k: '', v: '' }); draw() })
  wrap.appendChild(list)
  wrap.appendChild(el('div', { class: 'rowflex', style: 'margin-top:8px' }, [add]))
  return wrap
}

function presetBar() {
  const wrap = el('div', { class: 'rowflex', style: 'margin-top:8px' })
  const apply = async (id) => {
    const res = await api('/api/providers')
    const presets = res.body?.presets ?? []
    const preset = presets.find((p) => p.id === id)
    if (preset === undefined) { toast('预设不可用', 'bad'); return }
    const map = new Map(draftHeaders.filter((r) => r.k !== '').map((r) => [r.k.toLowerCase(), r]))
    for (const [k, v] of Object.entries(preset.headers)) map.set(k.toLowerCase(), { k, v })
    draftHeaders = [...map.values()]
    render(host)
    toast(`已套用 ${preset.label} 的请求头。${preset.note}`, 'warn', 9000)
  }
  for (const [id, label] of [['claude-code', '套用 Claude Code 头'], ['codex', '套用 Codex 头']]) {
    const b = button(label, 'small', 'download')
    b.addEventListener('click', () => void apply(id))
    wrap.appendChild(b)
  }
  wrap.appendChild(el('span', { class: 'tiny mute', text: 'user-agent 由宿主保留，填了也会被覆盖' }))
  return wrap
}

function field(label, node, hint) {
  const box = el('div', { class: 'field' }, [el('label', { class: 'flabel', text: label }), node])
  if (hint) box.appendChild(el('div', { class: 'fhint', text: hint }))
  return box
}

function editForm() {
  const src = editing ?? {}
  const inputs = {}
  const mk = (key, value, placeholder, type) => {
    const input = el('input', { type: type ?? 'text', placeholder: placeholder ?? '', value: value ?? '' })
    inputs[key] = input
    return input
  }
  const name = mk('name', src.name, 'windhub')
  if (editing !== null) name.disabled = true
  const protocol = el('select')
  for (const [value, label] of PROTOCOLS) {
    const opt = el('option', { value, text: label })
    if ((src.api ?? 'openai-completions') === value) opt.selected = true
    protocol.appendChild(opt)
  }
  inputs.api = protocol
  const grid = el('div', { class: 'formgrid' })
  grid.appendChild(field('路由名', name, '小写字母 / 数字 / 连字符；保存后不可改名'))
  grid.appendChild(field('显示名', mk('displayName', src.displayName, 'windhub 网关')))
  grid.appendChild(field('协议', protocol, '按供应商实际提供的接口选'))
  grid.appendChild(field('Base URL', mk('baseURL', src.baseURL, 'https://example.com/v1'), 'Anthropic Messages 要带 /v1'))
  grid.appendChild(field('模型 id', mk('model', (src.models ?? [])[0], 'deepseek-v4.1-flash')))
  grid.appendChild(field('密钥环境变量名', mk('apiKeyEnv', src.apiKeyEnv, '留空 = NAME_API_KEY')))
  grid.appendChild(field('密钥', mk('apiKey', '', editing === null ? 'sk-…' : '留空 = 不修改', 'password'), '填了写进凭据缝'))
  const vision = el('input', { type: 'checkbox', checked: src.vision === true })
  inputs.vision = vision
  grid.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'flabel' }, [vision, el('span', { text: ' 模型支持图片输入' })]),
  ]))
  const saveBtn = button(editing === null ? '保存供应商' : '保存修改', 'primary', 'check')
  saveBtn.addEventListener('click', () => void save(inputs, saveBtn))
  const cancel = button('取消编辑', 'small ghost')
  cancel.addEventListener('click', () => { editing = null; draftHeaders = []; render(host) })
  return el('div', {}, [
    grid,
    el('div', { class: 'sep' }),
    el('div', { class: 'flabel', text: '自定义请求头' }),
    headerRows(),
    presetBar(),
    el('div', { class: 'rowflex', style: 'margin-top:14px' }, [saveBtn, editing === null ? null : cancel]),
  ])
}

async function save(inputs, btn) {
  const headers = {}
  for (const row of draftHeaders) {
    const k = row.k.trim()
    if (k !== '') headers[k] = row.v
  }
  const body = {
    name: inputs.name.value.trim(),
    baseURL: inputs.baseURL.value.trim(),
    model: inputs.model.value.trim(),
    api: inputs.api.value,
    vision: inputs.vision.checked,
    headers,
  }
  for (const key of ['displayName', 'apiKeyEnv', 'apiKey']) {
    const value = inputs[key].value.trim()
    if (value !== '') body[key] = value
  }
  btn.disabled = true
  const res = await api('/api/providers/save', { method: 'POST', body })
  btn.disabled = false
  if (res.status !== 200) { toast(`保存失败：${errText(res)}`, 'bad', 9000); return }
  toast(String(res.body?.note ?? '已保存'), 'ok', 9000)
  editing = null
  draftHeaders = []
  render(host)
}

export default {
  render,
  refresh: () => { if (host !== null) render(host) },
  onEvent() { /* 供应商页不订阅 SSE */ },
  dispose() { host = null },
}
