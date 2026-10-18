/** 分句发送的规则层（P6h）：把一条长回复拆成"像人连着说"的几条。
 *
 * 这段逻辑来自 OpenClaw 扩展的 `smartSegmenter`，在 P4.6 里被删过一次——那时它
 * **真的没有消费者**（`sendSegments` 没有任何调用点），而按 D9 它应该在 P6h 作为
 * 一个**出站阶段**回来。现在回来了：`qq_send_text` 在
 * `config.segmentation.enabled` 打开时按这里的规则分条发送。
 *
 * 规则（一个字都没改，逐字搬回）：
 *   - 句末标点（`。！？…!?`）各自结束一段，**但受保护区域里不切**：代码块、`---`
 *     块、各种引号/括号内的标点不算句子边界（引号里的书名号里再带句号是常事）；
 *   - 情绪标点连着的一串（"！！！"、"……"）跟在同一段尾巴上；
 *   - `removeTrailingPeriod`：去掉段末的句号（聊天里句号显得生硬）；
 *   - `style`：`conservative` 把相邻的短句粘起来（阈值是 `minLength`，
 *     **旧实现里这里是个写死的 8**，配置项改了没用——这次真的读配置了），
 *     `active` 每句一条，`natural` 跟标点走；
 *   - 段内去重（同一句不重复发）+ `maxSegments` 封顶。
 *
 * 纯函数（R8）：不读时钟、不掷随机、不碰 IO，**也不依赖 config 模块**——只收
 * "分段这几个开关"（`config.segmentation` 结构上正好是它），这样 `core/` 不必
 * 认识外层。
 */

/** 分段行为需要的那五个开关（`QQChannelConfig['segmentation']` 就是它）。 */
export interface SegmentOptions {
  readonly enabled: boolean
  readonly style: 'natural' | 'conservative' | 'active'
  readonly minLength: number
  readonly maxSegments: number
  readonly removeTrailingPeriod: boolean
}

/** 模型偶尔吐出来的噪音；**永不**发进群里。 */
const JUNK_PATTERNS: RegExp[] = [
  /这些是重复发送的内容/i,
  /NO_REPLY/i,
  /^Something went wrong while processing your request/i,
  /^Please try again, or use \/new to start a fresh session/i,
  /^.*terminated.*$/i,
  /^GitHub\s*-\s*.+·\s*GitHub\s*$/i,
  /Contribute to .+ development by creating an account on GitHub/i,
  /未解析到有效文本内容/,
  /生成任务失败/,
]

/** 去掉思考块、字数提示、重复链接这些"不是话"的部分。 */
export function stripJunk(text: string): string {
  let filtered = text
  for (const pattern of JUNK_PATTERNS) {
    filtered = filtered.replace(pattern, '')
  }
  filtered = filtered.replace(/<思考>[\s\S]*?<\/思考>/g, '')
  filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  filtered = filtered.replace(/[（(][\d一二三四五六七八九十百千万]+字[）)]/g, '')
  const seen = new Set<string>()
  filtered = filtered.replace(/https?:\/\/github\.com\/[^\s]+/gi, (match) => (seen.has(match) ? '' : (seen.add(match), match)))
  return filtered.trim()
}

/** 半角标点 → 全角；直引号 → 成对的弯引号。 */
export function convertPunctuation(text: string): string {
  const result = text.replace(/:/g, '：').replace(/,/g, '，').replace(/\?/g, '？').replace(/!/g, '！')
  let open = true
  let converted = ''
  for (const char of result) {
    if (char === '"') { converted += open ? '“' : '”'; open = !open } else converted += char
  }
  return converted
}

const ENDERS = new Set(['。', '！', '？', '…', '!', '?'])

/** 不该在内部切分的区域：代码块、破折号块、各种成对引号/括号。 */
const PROTECTED = [
  /```[\s\S]*?```/g, /---[\s\S]*?---/g, /「[^」]*」/g, /《[^》]*》/g,
  /【[^【】]*】/g, /（[^（）]*）/g, /\([^()]*\)/g,
]

/** 按句末标点切段（受保护区域除外），并把连着的同类标点留在同一段尾巴上。 */
function splitByEnders(body: string): string[] {
  const ranges: Array<{ start: number; end: number }> = []
  for (const pattern of PROTECTED) {
    for (const match of body.matchAll(pattern)) {
      ranges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
    }
  }
  const isProtected = (pos: number): boolean => ranges.some((r) => pos >= r.start && pos < r.end)

  const segments: string[] = []
  let current = ''
  const chars = Array.from(body)
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!
    current += char
    if (ENDERS.has(char) && !isProtected(i)) {
      while (i + 1 < chars.length
        && (chars[i + 1] === '…' || chars[i + 1] === char || (char === '…' && chars[i + 1] === '。'))) {
        i += 1
        current += chars[i]
      }
      segments.push(current.trim())
      current = ''
    }
  }
  if (current.trim() !== '') segments.push(current.trim())
  return segments
}

/** `conservative`：相邻的短句粘成一条（旧实现写死 8，这里读配置）。 */
function mergeTiny(segments: readonly string[], minLength: number): string[] {
  const merged: string[] = []
  for (const seg of segments) {
    const prev = merged[merged.length - 1]
    if (prev !== undefined && prev.length < minLength && seg.length < minLength) merged[merged.length - 1] = `${prev}，${seg}`
    else merged.push(seg)
  }
  return merged
}

function dedupe(segments: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const seg of segments) {
    const key = seg.trim().toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(seg)
    }
  }
  return out
}

/**
 * 分组发送的入口：给一段文本与分段配置，返回**实际要发出去的几条**。
 *
 * 返回单元素数组 = 照旧发一条（开关关着、没有句末标点、或者本来就是一句话）。
 */
export function segmentText(text: string, options: SegmentOptions): string[] {
  const { enabled, style, maxSegments, removeTrailingPeriod, minLength } = options
  const body = stripJunk(text)
  if (!enabled || body === '') return body === '' ? [] : [body]
  if (![...body].some((c) => ENDERS.has(c))) return [body]

  const cleaned = splitByEnders(convertPunctuation(body))
    .map((seg) => (removeTrailingPeriod ? seg.replace(/。+$/u, '') : seg))
    .filter((seg) => seg !== '')
  const styled = style === 'conservative' ? mergeTiny(cleaned, minLength) : cleaned
  return dedupe(styled).slice(0, maxSegments)
}
