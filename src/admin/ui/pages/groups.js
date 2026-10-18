/** 群聊与房间页：全局默认（schema 表单）+ **逐群覆盖表**。
 *
 * 为什么需要逐群：一个号会被拉进很多群，"这个群要不要说话 / 要不要 @ / 接话概率"
 * 不该全局一刀切。表里每一行写进 `config.rooms[群号]`，留空/继承 = 跟全局默认。
 *
 * 数据来源：`state.status.groupsDetail`（机器人当前已加入的群，来自 NapCat）。
 * 覆盖值保存在 `state.config.rooms`。
 */

import { el } from '../dom.js'
import { api, errText } from '../api.js'
import { state, loadSnapshot } from '../state.js'
import { button, emptyBox, section } from '../components/card.js'
import { toast } from '../components/toast.js'
import { createModulePage } from './module.js'

const INHERIT = ''

function roomRow(group, current, draft, onChange) {
  const row = el('div', { class: 'objrow' })
  const head = el('div', { class: 'objhead' })
  // 显式 null = 继承：配置层是深合并，删键删不掉旧值。
  const inherits = (v) => v === undefined || v === null
  const hasOverride = current !== undefined && Object.values(current).some((v) => !inherits(v))
  head.appendChild(el('div', { class: 'grow' }, [
    el('div', { class: 'objtitle' }, [
      el('strong', { text: group.name || `群 ${group.id}` }),
      el('code', { class: 'tiny mute', text: String(group.id) }),
      hasOverride ? el('span', { class: 'pill info', text: '已覆盖' }) : el('span', { class: 'pill', text: '继承全局' }),
    ]),
  ]))
  const reset = button('清除覆盖', 'small ghost', 'refresh')
  reset.addEventListener('click', () => {
    draft[String(group.id)] = { enabled: null, requireMention: null, talkValue: null }
    onChange()
  })
  head.appendChild(el('div', { class: 'rowbtns' }, [reset]))
  row.appendChild(head)

  const controls = el('div', { class: 'formgrid', style: 'margin-top:10px' })

  const enabled = el('select')
  for (const [value, label] of [[INHERIT, '继承全局'], ['true', '处理这个群'], ['false', '忽略这个群']]) {
    enabled.appendChild(el('option', { value, text: label, selected: inherits(current?.enabled) ? value === INHERIT : String(current.enabled) === value }))
  }
  enabled.addEventListener('change', () => {
    const target = draft[String(group.id)] ?? (draft[String(group.id)] = {})
    target.enabled = enabled.value === INHERIT ? null : enabled.value === 'true'
    onChange()
  })

  const mention = el('select')
  for (const [value, label] of [[INHERIT, '继承全局'], ['true', '必须 @ 才理'], ['false', '不用 @ 也说']]) {
    mention.appendChild(el('option', { value, text: label, selected: inherits(current?.requireMention) ? value === INHERIT : String(current.requireMention) === value }))
  }
  mention.addEventListener('change', () => {
    const target = draft[String(group.id)] ?? (draft[String(group.id)] = {})
    target.requireMention = mention.value === INHERIT ? null : mention.value === 'true'
    onChange()
  })

  const talk = el('input', { type: 'number', min: '0', max: '1', step: '0.05', placeholder: '继承全局', value: inherits(current?.talkValue) ? '' : String(current.talkValue) })
  talk.addEventListener('input', () => {
    const target = draft[String(group.id)] ?? (draft[String(group.id)] = {})
    const value = talk.value.trim()
    target.talkValue = value === '' ? null : Number(value)
    onChange()
  })

  const field = (label, node) => el('div', { class: 'field' }, [el('label', { class: 'flabel', text: label }), node])
  controls.appendChild(field('是否处理', enabled))
  controls.appendChild(field('是否必须 @', mention))
  controls.appendChild(field('接话概率（0–1）', talk))
  row.appendChild(controls)
  return row
}

function roomsCard() {
  const card = section({
    title: '按群覆盖',
    icon: 'people',
    blurb: '机器人当前已加入的群。留空 = 跟上面的全局默认；覆盖只影响这一个群，保存后立即生效。',
  })
  const box = el('div', { class: 'stack' })
  card.body.appendChild(box)

  const paint = () => {
    box.textContent = ''
    const groups = Array.isArray(state.status?.groupsDetail) ? state.status.groupsDetail : []
    const current = (state.config?.rooms ?? {})
    // 草稿：保存前只在本地改，避免每动一下都写配置。
    const draft = JSON.parse(JSON.stringify(current))
    const dirtyNote = el('div', { class: 'inline-note', text: '' })
    const saveBtn = button('保存全部覆盖', 'primary', 'check')
    saveBtn.disabled = true
    const onChange = () => {
      const changed = JSON.stringify(draft) !== JSON.stringify(current)
      saveBtn.disabled = !changed
      dirtyNote.className = 'inline-note warn'
      dirtyNote.textContent = changed ? '有未保存的改动' : ''
    }
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true
      const res = await api('/api/config', { method: 'POST', body: { patch: { rooms: draft }, baseVersion: state.configVersion, section: 'groups' } })
      if (res.status !== 200) { toast(`保存失败：${errText(res)}`, 'bad', 9000); saveBtn.disabled = false; return }
      toast('群覆盖已保存（下一次消息生效）', 'ok', 6000)
      await loadSnapshot()
      paint()
    })

    if (groups.length === 0) {
      box.appendChild(emptyBox('还没有已加入的群', '机器人连接后在群里出现过，这里就会列出来。', 'people'))
      return
    }
    for (const group of groups) {
      box.appendChild(roomRow(group, current[String(group.id)], draft, onChange))
    }
    box.appendChild(el('div', { class: 'rowflex', style: 'margin-top:12px' }, [saveBtn, dirtyNote]))
    // 初始态：无改动。
    onChange()
  }

  paint()
  globalThis.__dshGroupsRepaint = paint
  return card.node
}

const page = createModulePage('groups', {
  extras: () => {
    const node = roomsCard()
    return node
  },
})

export default {
  ...page,
  render(host) {
    page.render(host)
  },
  refresh() {
    page.refresh?.()
    globalThis.__dshGroupsRepaint?.()
  },
}
