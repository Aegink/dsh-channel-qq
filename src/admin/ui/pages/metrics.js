/** 指标页：诚实占位——回合耗时/token/工具失败率的采集在 P6 接入，现在不造数。 */

import { el } from '../dom.js'
import { state } from '../state.js'
import { kvList, section } from '../components/card.js'
import { button } from '../components/card.js'
import { navigate } from '../router.js'
import { api, errText } from '../api.js'

let host = null

function render(h) {
  host = h
  host.textContent = ''
  const view = el('div', { class: 'view' })
  host.appendChild(view)

  const card = section({
    title: '指标采集（未接入）',
    icon: 'chart',
    blurb: '回复耗时 p50/p90、每回合 token、工具失败率的采集依赖宿主 token-meter 与回合指标（refactor-plan [10 §7] 的 metric 通道），排在 P6。这一页现在不显示假数据。',
  })
  card.body.appendChild(kvList([
    ['规划中的指标', '回复耗时 p50/p90 · 每回合 token · 工具失败率 · 发送失败数'],
    ['数据来源', '宿主 token-meter + 回合账本（P6 接入）'],
    ['现在的替代', '「日志」页的错误聚合可以区分"历史残留"与"仍在发生"'],
  ]))
  const toLogs = button('去日志页看错误聚合', 'small primary', 'filetext')
  toLogs.addEventListener('click', () => navigate('system', 'logs'))
  card.body.appendChild(el('div', { class: 'rowflex', style: 'margin-top:10px' }, [toLogs]))
  view.appendChild(card.node)

  view.appendChild(sessionsCard())

  const counts = section({ title: '当前规模（快照口径）', icon: 'pulse' })
  const s = state.status ?? {}
  counts.body.appendChild(kvList([
    ['工具数', s.tools ?? '—'],
    ['表情索引', s.emojiIndexed ?? '—'],
    ['语录', s.quotes ?? '—'],
    ['口癖', s.learnedPhrases ?? '—'],
    ['风控记录/触发', `${s.floodTracked ?? '—'} / ${s.floodTriggered ?? '—'}`],
  ]))
  view.appendChild(counts.node)
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 一条折线（不引图表库：一个 sparkline 不值得）。 */
function sparkline(points, width = 240, height = 42) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', '会话体积曲线')
  const values = points.map((p) => p.tokens)
  const max = Math.max(...values, 1)
  if (values.length >= 2) {
    const coords = values.map((value, index) => {
      const x = (index / (values.length - 1)) * (width - 2) + 1
      const y = height - 2 - (value / max) * (height - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
    const line = document.createElementNS(SVG_NS, 'polyline')
    line.setAttribute('points', coords)
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', 'currentColor')
    line.setAttribute('stroke-width', '1.5')
    svg.appendChild(line)
  }
  return svg
}

/** 会话体积卡：当前值与曲线（数据来自 `session-size` 资源）。 */
function sessionsCard() {
  const card = section({
    title: '会话体积曲线',
    icon: 'chart',
    blurb: '看门狗每轮记一次 token；达到模型窗口 85% 会自动换血。曲线只保留最近 500 条采样。',
  })
  const box = el('div', { class: 'stack' })
  card.body.appendChild(box)
  box.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spin' }), el('span', { text: '读取…' })]))
  void api('/api/resource/session-size').then((res) => {
    box.textContent = ''
    if (res.status !== 200) { box.appendChild(el('div', { class: 'inline-note bad', text: errText(res, '读取失败') })); return }
    const rooms = Array.isArray(res.body?.data?.rooms) ? res.body.data.rooms : []
    if (rooms.length === 0) {
      box.appendChild(el('div', { class: 'empty' }, [el('b', { text: '还没有采样' }), el('span', { text: '看门狗启动后每个活跃会话每 5 分钟记一次。' })]))
      return
    }
    for (const room of rooms) {
      const pct = room.window ? Math.round((room.tokens / room.window) * 100) : null
      const row = el('div', { class: 'objrow' })
      row.appendChild(el('div', { class: 'rowflex' }, [
        el('b', { text: String(room.room) }),
        el('span', { class: 'pill ' + (pct !== null && pct >= 85 ? 'bad' : pct !== null && pct >= 60 ? 'warn' : 'ok'), text: pct === null ? '窗口未知' : `${pct}%` }),
        el('span', { class: 'tiny mute', text: `${room.tokens} / ${room.window ?? '?'} tokens · ${room.provider}/${room.model}` }),
      ]))
      row.appendChild(sparkline(Array.isArray(room.points) ? room.points : []))
      box.appendChild(row)
    }
  })
  return card.node
}

export default { render }
