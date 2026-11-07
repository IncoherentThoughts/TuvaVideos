const res = await Bun.build({ entrypoints: ["/home/user/TuvaVideos/src/tv/main.tsx"], target: "browser", minify: true, sourcemap: "none", define: { "process.env.NODE_ENV": '"production"' } });
const js = await res.outputs[0]!.text();
await Bun.write("/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-06/tv.js", js);
console.log(js.length, "?.", (js.match(/\?\./g)||[]).length, "??", (js.match(/\?\?/g)||[]).length, "??=", (js.match(/\?\?=/g)||[]).length, "||=", (js.match(/\|\|=/g)||[]).length, "#priv", (js.match(/#[a-zA-Z_]\w*\s*[;=(]/g)||[]).length);
