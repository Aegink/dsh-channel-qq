/** 概览页：连接与身份、关键指标、快捷操作、最近错误。 */

import { el, fmtDuration } from '../dom.js'
import { api, errText } from '../api.js'
import { state, loadSnapshot } from '../state.js'
import { button, emptyBox, kvList, pill, section, skeletonRows, statTile } from '../components/card.js'
import { toast } from '../components/toast.js'
import { navigate } from '../router.js'

let host = null

function render(h) {
  host = h
  paint()
}

function paint() {
  if (host === null) return
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)
  const status = state.status
  const meta = state.meta
  if (status === null || status === undefined) {
    view.appendChild(skeletonRows(4))
    return
  }

  // ── 状态 ────────────────────────────────────────────────────────────────
  const conn = section({ title: '连接与身份', icon: 'wifi' })
  const pills = el('div', { class: 'rowflex', style: 'margin-bottom:12px' })
  const connected = status.qqConnected === true
  const known = status.qqConnected === true || status.qqConnected === false
  pills.appendChild(pill(connected ? 'QQ 已连接' : (known ? 'QQ 未连接' : '状态未知'), connected ? 'ok' : (known ? 'bad' : undefined)))

  // 掉线不是"小胶囊"级别的事：QQ 断了整条通道就废了，原因必须一眼看到。
  const offline = status.qqOffline
  if (offline !== null && offline !== undefined) {
    const minutes = Math.max(1, Math.round((Number(offline.sinceMs) || 0) / 60000))
    view.appendChild(el('div', {
      role: 'alert',
      style: 'margin:0 0 12px;padding:10px 12px;border-radius:8px;'
        + 'background:rgba(220,38,38,.12);border:1px solid rgba(220,38,38,.45);color:#dc2626;font-weight:600',
    }, `⚠ QQ 已离线约 ${minutes} 分钟 · ${offline.hint ?? '协议端无应答'}`))
  }
  if (status.tools !== undefined) pills.appendChild(pill(`${status.tools} 个工具`, 'info'))
  if (status.uptimeSec !== undefined) pills.appendChild(pill(`已运行 ${fmtDuration(status.uptimeSec)}`))
  conn.body.appendChild(pills)
  conn.body.appendChild(kvList([
    ['机器人 QQ 号', status.selfId, true],
    ['连接方式', status.connection],
    ['主群号', status.primaryGroup, true],
    ['学弟（管理员）', status.master, true],
    ['Agent 工作区', status.workspace, true],
  ]))
  const groupList = Array.isArray(status.groupList) ? status.groupList : []
  if (groupList.length > 0) {
    const det = el('details', { class: 'raw', style: 'margin-top:10px' })
    det.appendChild(el('summary', { text: `群列表（${groupList.length}）` }))
    const inner = el('div', { class: 'inner rowflex' })
    for (const entry of groupList) inner.appendChild(el('span', { class: 'tag', text: typeof entry === 'string' ? entry : JSON.stringify(entry) }))
    det.appendChild(inner)
    conn.body.appendChild(det)
  }
  view.appendChild(conn.node)

  // ── 关键指标 ────────────────────────────────────────────────────────────
  const metrics = section({ title: '关键指标', icon: 'chart', blurb: '数据来自运行中的插件（SSE 每 8 秒推送一次）。' })
  const grid = el('div', { class: 'grid' })
  const tiles = [
    ['表情索引', status.emojiIndexed], ['语录', status.quotes], ['待发提醒', status.pendingReminders],
    ['订阅源', status.rssFeeds], ['风控记录', status.floodTracked], ['风控触发', status.floodTriggered],
    ['口癖', status.learnedPhrases],
  ]
  for (const [label, value] of tiles) grid.appendChild(statTile(label, value === undefined ? '—' : value))
  grid.appendChild(statTile('TTS', status.tts === undefined ? '—' : status.tts))
  grid.appendChild(statTile('生图', status.imageGen === undefined ? '—' : status.imageGen))
  grid.appendChild(statTile('链接解析', status.linkResolve === undefined ? '—' : status.linkResolve))
  metrics.body.appendChild(grid)
  view.appendChild(metrics.node)

  // ── 快捷操作 ────────────────────────────────────────────────────────────
  const actions = section({ title: '快捷操作', icon: 'wand' })
  const bar = el('div', { class: 'rowflex' })
  const reload = button('重新读取快照', 'small', 'refresh')
  reload.addEventListener('click', () => { reload.disabled = true; void loadSnapshot().finally(() => { reload.disabled = false }) })
  const reconnect = button('重连 OneBot', 'small', 'plug')
  reconnect.addEventListener('click', async () => {
    reconnect.disabled = true
    const res = await api('/api/action/reconnect', { method: 'POST', body: { resource: 'admin' } })
    reconnect.disabled = false
    if (res.status !== 200) { toast(`重连失败：${errText(res)}`, 'bad'); return }
    toast('已触发重连', 'ok')
    void loadSnapshot()
  })
  const toLogs = button('看日志 / 错误聚合', 'small', 'filetext')
  toLogs.addEventListener('click', () => navigate('system', 'logs'))
  const toAudit = button('看审计', 'small', 'shieldcheck')
  toAudit.addEventListener('click', () => navigate('system', 'audit'))
  bar.appendChild(reload); bar.appendChild(reconnect); bar.appendChild(toLogs); bar.appendChild(toAudit)
  actions.body.appendChild(bar)
  if (meta !== null && meta !== undefined && typeof meta.configVersion === 'number') {
    actions.body.appendChild(el('p', { class: 'blurb', style: 'margin:10px 0 0', text: `配置版本 v${meta.configVersion}${meta.overrideFile ? ` · 覆盖层：${meta.overrideFile}` : ''}` }))
  }
  view.appendChild(actions.node)

  // ── 最近错误 ────────────────────────────────────────────────────────────
  const errors = section({ title: '最近错误（从日志尾部提取）', icon: 'alert' })
  errors.body.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '读取日志…' })]))
  view.appendChild(errors.node)
  void api('/api/logs?lines=300').then((res) => {
    errors.body.textContent = ''
    if (res.status !== 200) { errors.body.appendChild(emptyBox('读取失败', errText(res), 'alert')); return }
    const lines = Array.isArray(res.body.lines) ? res.body.lines : []
    const hits = lines.filter((line) => /\b(error|failed|exception|失败)\b/i.test(line)).slice(-8)
    if (hits.length === 0) {
      errors.body.appendChild(el('div', { class: 'inline-note ok', text: '最近 300 行日志里没有错误。' }))
      return
    }
    for (const line of hits) {
      errors.body.appendChild(el('div', { class: 'aggrrow' }, [
        el('span', { class: 'shape', text: line.trim().slice(0, 220) }),
        el('span', { class: 'when', text: '' }),
      ]))
    }
  })
}

async function refresh() {
  await loadSnapshot()
  paint()
}

/** SSE 推来新状态时重绘（外壳转发）。 */
function onEvent(name) {
  if (name === 'status') paint()
}

export default { render, refresh, onEvent }
