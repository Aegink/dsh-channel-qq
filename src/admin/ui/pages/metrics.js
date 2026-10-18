/** 指标页：诚实占位——回合耗时/token/工具失败率的采集在 P6 接入，现在不造数。 */

import { el } from '../dom.js'
import { state } from '../state.js'
import { kvList, section } from '../components/card.js'
import { button } from '../components/card.js'
import { navigate } from '../router.js'

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

export default { render }
