import { startApp } from "/home/user/TuvaVideos/src/server/app";
import { loadConfig } from "/home/user/TuvaVideos/src/server/config";
const cfg = loadConfig({ TUVA_DATA_DIR: "/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-07/nullbody/data", TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: "/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-07/nullbody/local" });
const app = await startApp(cfg);
const u = "http://localhost:" + app.server.port;
const id = "00000000-0000-4000-8000-000000000001";
for (const p of ["resume", "loop"]) {
  const r = await fetch(u + "/api/videos/" + id + "/" + p, { method: "POST", headers: { "content-type": "application/json", origin: u }, body: "null" });
  console.log(p, r.status, await r.text());
}
await app.stop();
