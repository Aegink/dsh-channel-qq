/**
 * Hand a local file to NapCat.
 *
 * Why this module exists
 * ----------------------
 * A OneBot message segment (`data.file`) and the `file` parameter of
 * `upload_private_file` / `upload_group_file` all accept three forms: an
 * http(s) URL, a **local path**, or `base64://<payload>`.
 *
 * The local-path form only works when NapCat can read that path *itself*. In this
 * deployment NapCat runs in a container that does not mount the plugin's
 * directories and `enableLocalFile2Url` is off, so handing it a path — or a
 * `file://` URL, which it also does not resolve — is answered with
 * `QQ API failed: 识别URL失败`, and every file send silently fails.
 *
 * Every local file therefore goes through `napcatFileArg()`:
 *
 *   - under a root NapCat can read  -> `file://<abs>`    (no copy, no size limit)
 *   - anywhere else                 -> `base64://<b64>`  (always works, size-capped)
 *
 * The visible roots come from `CHANNEL_QQ_NAPCAT_ROOTS` (colon- or comma-separated
 * host paths). Unset means "NapCat cannot read anything on this host", which is
 * the safe default: uploads still work, just inline.
 *
 * `localPathOf()` also accepts a `file://` URL from the caller. The model
 * sometimes writes `file:///opt/...` when asked for a path; feeding that straight
 * to `fs.access` produced `ENOENT ... access 'file:///opt/...'`.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/**
 * Above this, inlining is refused instead of attempted.
 *
 * base64 inflates by 4/3 and the payload travels as one WebSocket frame, so a
 * multi-megabyte file is both slow and likely to be rejected. 8 MiB of input is
 * ~11 MiB on the wire — comfortably inside what a local NapCat accepts while
 * still refusing the case that would otherwise blow up.
 */
export const DEFAULT_MAX_INLINE_BYTES = 8 * 1024 * 1024

/** Host paths NapCat is configured to read (see the module doc). */
export function napcatVisibleRoots(): string[] {
  const raw = process.env.CHANNEL_QQ_NAPCAT_ROOTS ?? ''
  return raw
    .split(/[,:;]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => path.resolve(s))
}

/**
 * Normalise whatever the caller passed into a local absolute filesystem path.
 *
 * Accepts a bare path or a `file://` URL (percent-decoded). Anything with
 * another scheme (`http:`, `base64:`) is returned unchanged so callers can pass
 * a ready-made URL straight through.
 */
export function localPathOf(input: string): string {
  const raw = input.trim()
  if (raw === '') throw new Error('文件路径不能为空')
  if (/^[a-zA-Z][\w+.-]*:/.test(raw) && !/^file:/i.test(raw)) return raw
  if (/^file:/i.test(raw)) {
    let rest = raw.replace(/^file:\/\//i, '').replace(/^file:/i, '')
    // `file:///opt/x` -> `/opt/x`; `file://host/share` keeps `host/share` (unused here)
    if (!rest.startsWith('/') && /^[a-zA-Z]:/.test(rest)) rest = rest // win32 `file:///C:/x` already handled
    else if (!rest.startsWith('/')) rest = `/${rest.replace(/^\/+/, '')}`
    try { rest = decodeURIComponent(rest) } catch { /* keep the raw form */ }
    return path.resolve(rest)
  }
  return path.resolve(raw)
}

/** True when `abs` is inside one of `roots` (both already absolute). */
function underAnyRoot(abs: string, roots: string[]): boolean {
  for (const root of roots) {
    if (abs === root) return true
    if (abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true
  }
  return false
}

/**
 * Turn a local path into something NapCat can actually fetch.
 *
 * The returned string is meant for `data.file` / `file` verbatim — `file://…`
 * when NapCat can see the path, otherwise a `base64://…` data URL.
 *
 * @throws when the file is missing, is a directory, or exceeds the inline cap
 *         while sitting outside every visible root — the operator needs to know
 *         *which* of the two things to fix, so the message names both.
 */
export async function napcatFileArg(
  input: string,
  opts: { maxInlineBytes?: number } = {},
): Promise<string> {
  const max = opts.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES
  const abs = localPathOf(input)

  // Already a usable URL (http/base64) — pass it through untouched.
  if (/^[a-zA-Z][\w+.-]*:/.test(abs) && !/^[a-zA-Z]:[\\/]/.test(abs)) return abs

  const stat = await fs.stat(abs) // throws ENOENT/EISDIR with the real path in it
  if (!stat.isFile()) throw new Error(`不是文件（是目录？）：${abs}`)

  if (underAnyRoot(abs, napcatVisibleRoots())) {
    // NapCat reads it directly; no copy and no size limit.
    return `file://${abs.split(path.sep).join('/')}`
  }

  if (stat.size > max) {
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)
    throw new Error(
      `文件 ${abs} 有 ${mb(stat.size)}MiB，超过内联上限 ${mb(max)}MiB，而 NapCat 又读不到这个路径。`
      + `两种解法：把该目录挂进 NapCat 容器（并设 CHANNEL_QQ_NAPCAT_ROOTS），或换个小文件。`,
    )
  }

  const bytes = await fs.readFile(abs)
  return `base64://${bytes.toString('base64')}`
}