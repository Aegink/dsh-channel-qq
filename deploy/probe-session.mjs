/** Print one sample record of each requested session record type. */
import { promises as fs } from 'node:fs'

const file = process.argv[2]
const wanted = process.argv.slice(3)
const jsonl = await fs.readFile(file, 'utf8')
const seen = new Set()
for (const line of jsonl.split('\n')) {
  if (line.trim() === '') continue
  let r
  try { r = JSON.parse(line) } catch { continue }
  const t = r.type ?? '?'
  if (wanted.length > 0 && !wanted.includes(t)) continue
  if (seen.has(t)) continue
  seen.add(t)
  console.log(`\n===== ${t} =====`)
  console.log(JSON.stringify(r).slice(0, 1300))
}