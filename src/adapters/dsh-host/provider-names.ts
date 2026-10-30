/** 供应商「路由名」的清洗（宿主 llm-pi-ai 只接受 `[a-z0-9-]`）。
 *
 * 单独一个文件的原因很实在：`providers.ts` 已经贴着 400 行的硬上限，而这段逻辑
 * 与"怎么读写 settings"无关，只是一条纯粹的字符串规则。
 */

/** 把用户填的名字清洗成合法路由名；清洗不出东西就用 baseURL 的域名推导。 */
export function slugifyProviderName(raw: string, baseURL: string): string {
  const clean = (text: string): string => text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const fromRaw = clean((raw ?? '').trim())
  if (fromRaw !== '') return fromRaw
  let host = ''
  try {
    host = new URL((baseURL ?? '').trim()).hostname
  } catch {
    host = ''
  }
  // 顺手去掉常见顶级域：`maas-api.unisound.com` → `maas-api-unisound`，名字短一点好记。
  return clean(host.replace(/^www\./, '').replace(/\./g, '-'))
    .replace(/-(com|net|org|cn|io|ai|dev|app|cc)$/, '')
}
