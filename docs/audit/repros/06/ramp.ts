import { nextSeekStep } from "/home/user/TuvaVideos/src/tv/seekStep";
// a held Right: first event at 0, auto-repeat after 500 ms delay at 50 ms intervals (typical TV remote)
let r = null as any, total = 0; const marks: string[] = [];
const times = [0]; for (let t = 500; t <= 3000; t += 50) times.push(t);
for (const t of times) { const x = nextSeekStep(r, 1, t); r = x.ramp; total += x.step; if ([0,500,1000,1500,2000,3000].includes(t)) marks.push(`${t}ms: +${total}s (step ${x.step})`); }
console.log(marks.join("\n"));
