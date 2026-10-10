// A stand-in for the osascript child, for the ResidentBridge tests: same protocol (one JSON command per stdin line, one
// JSON reply per line). Commands: `die` exits at once, `hang` never answers, anything else answers with the pid so a
// restart is visible.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const c = JSON.parse(line);
  if (c.cmd === "die") process.exit(3);
  if (c.cmd === "hang") return;
  if (c.cmd === "fail") return void console.log(JSON.stringify({ id: c.id, ok: false, error: "boom" }));
  console.log(JSON.stringify({ id: c.id, ok: true, state: "playing", position: 12.5, duration: 200, persistentId: "AAAA", found: c.persistentId !== "GONE", pid: process.pid }));
});
