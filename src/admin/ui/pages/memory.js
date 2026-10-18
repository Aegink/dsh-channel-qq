/** 记忆页：全局浏览（沿用通用模块页）+ **待审卡片**（候选 / 疑似冲突 / 迁移）。
 *
 * 为什么需要这块：`memory.reflect` 产出的记录是 `candidate`，而检索只认 `active`；
 * 从前没有任何界面能把候选转正，等于"反思产出了但永远不生效"（2026-10-18 审计）。
 * 冲突裁定同理：只检出、没有入口。
 *
 * 数据来自资源 `memory-pending`（每次现算，不另存队列）；动作走 `/api/action/<name>`。
 */

import { el } from '../dom.js'
import { api, errText } from '../api.js'
import { button, emptyBox, section } from '../components/card.js'
import { toast } from '../components/toast.js'
import { createModulePage } from './module.js'

async function act(name, body) {
  const res = await api(`/api/action/${name}`, { method: 'POST', body: { resource: 'memory-pending', ...body } })
  if (res.status !== 200) { toast(`操作失败：${errText(res)}`, 'bad', 8000); return false }
  const payload = res.body?.result ?? res.body
  if (payload?.ok === false) { toast(String(payload.reason ?? '操作失败'), 'bad', 8000); return false }
  toast('已保存', 'ok', 4000)
  return true
}

function row(content, buttons) {
  const card = el('div', { class: 'objrow' })
  card.appendChild(el('div', { class: 'objmeta', text: content }))
  card.appendChild(el('div', { class: 'rowflex', style: 'margin-top:8px' }, buttons))
  return card
}

function pendingCard() {
  const card = section({
    title: '待审核',
    icon: 'brain',
    blurb: '反思产出的候选记忆、疑似冲突的记录对。通过后才会进入检索；冲突裁定不会删除任何记录。',
  })
  const box = el('div', { class: 'stack' })
  card.body.appendChild(box)

  const load = async () => {
    box.textContent = ''
    const res = await api('/api/resource/memory-pending')
    if (res.status !== 200) {
      box.appendChild(emptyBox('读取失败', errText(res), 'alert'))
      return
    }
    const data = res.body?.data ?? res.body ?? {}
    if (data.note !== undefined) {
      box.appendChild(emptyBox('记忆系统关着', String(data.note), 'info'))
      return
    }
    const candidates = Array.isArray(data.candidates) ? data.candidates : []
    const conflicts = Array.isArray(data.conflicts) ? data.conflicts : []

    if (candidates.length === 0 && conflicts.length === 0) {
      box.appendChild(emptyBox('没有待审条目', '反思与冲突扫描只在 memory.v2 打开后才会产出。', 'brain'))
    }

    if (candidates.length > 0) {
      box.appendChild(el('div', { class: 'flabel', text: `候选记忆（${candidates.length}）` }))
      for (const c of candidates) {
        const approve = button('通过', 'small primary', 'check')
        approve.addEventListener('click', async () => { if (await act('approve', { id: c.id })) void load() })
        const reject = button('忽略', 'small', 'trash')
        reject.addEventListener('click', async () => { if (await act('reject', { id: c.id })) void load() })
        box.appendChild(row(`${c.content}（${c.kind} · ${c.date} · ${c.source}）`, [approve, reject]))
      }
    }

    if (conflicts.length > 0) {
      box.appendChild(el('div', { class: 'flabel', text: `疑似冲突（${conflicts.length}）`, style: 'margin-top:14px' }))
      for (const pair of conflicts) {
        const keepLeft = button('保留左条', 'small primary', 'check')
        keepLeft.addEventListener('click', async () => { if (await act('resolve', { keep: pair.left.id, drop: pair.right.id })) void load() })
        const keepRight = button('保留右条', 'small primary', 'check')
        keepRight.addEventListener('click', async () => { if (await act('resolve', { keep: pair.right.id, drop: pair.left.id })) void load() })
        const wrap = el('div', { class: 'objrow' })
        wrap.appendChild(el('div', { class: 'tiny mute', text: `重叠 ${pair.overlap}` }))
        wrap.appendChild(el('div', { class: 'objmeta', text: `左：${pair.left.content}` }))
        wrap.appendChild(el('div', { class: 'objmeta', text: `右：${pair.right.content}` }))
        wrap.appendChild(el('div', { class: 'rowflex', style: 'margin-top:8px' }, [keepLeft, keepRight]))
        box.appendChild(wrap)
      }
    }

    const migrate = button('迁移 MEMORY.md → 候选', 'small', 'download')
    migrate.addEventListener('click', async () => {
      migrate.disabled = true
      const ok = await act('migrate', {})
      migrate.disabled = false
      if (ok) void load()
    })
    box.appendChild(el('div', { class: 'rowflex', style: 'margin-top:14px' }, [migrate]))
  }

  void load()
  globalThis.__dshMemoryPendingReload = load
  return card.node
}

const page = createModulePage('memory', { extras: () => pendingCard() })

export default {
  ...page,
  render(host) {
    page.render(host)
  },
  refresh() {
    page.refresh?.()
    globalThis.__dshMemoryPendingReload?.()
  },
}
