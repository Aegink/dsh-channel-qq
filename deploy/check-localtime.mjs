/** Verify localStamp is self-consistent with the process timezone. */
import { localStamp, timeContext } from '#lib/scheduler.js'

const d = new Date('2026-10-14T16:29:53.719Z')
console.log('process TZ          :', process.env.TZ ?? '(unset)')
console.log('Intl resolved zone  :', Intl.DateTimeFormat().resolvedOptions().timeZone)
console.log('UTC (toISOString)   :', d.toISOString())
console.log('getHours / TZoffset :', d.getHours(), '/', d.getTimezoneOffset())
console.log('localStamp(sample)  :', localStamp(d))
console.log('localStamp(now)     :', localStamp())
console.log('new Date()          :', new Date().toString())
console.log('timeContext(now)    :', timeContext().period)

// Self-consistency: the printed wall-clock fields must equal what the platform
// reports for the same instant in the resolved zone.
const parts = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(d).replace(' ', 'T')
const stamped = localStamp(d).slice(0, 19)
console.log('platform says       :', parts)
console.log(parts === stamped ? 'PASS  两者一致' : `FAIL  不一致：localStamp=${stamped} platform=${parts}`)
