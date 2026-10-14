// Hello-world TV app (#48): plays test Copies from the Mac in <video src> and reports timings back to serve.ts.
// Up/Down choose, Enter plays (the first row runs every test in turn), Back stops, Back again exits.
var SERVER = "http://192.168.4.83:4410";
var TIMEOUT_MS = 20000;
var PLAY_MS = 5000;

var v = document.getElementById("v");
var logEl = document.getElementById("log");
var listEl = document.getElementById("tests");
var tests = [];
var sel = 0;
var running = null; // { test, done } while a test plays
var queue = [];

function log(s) {
  logEl.textContent = (s + "\n" + logEl.textContent).slice(0, 4000);
}

function post(path, body) {
  return fetch(SERVER + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .catch(function (e) { log("report failed: " + e); });
}

function render() {
  var rows = [{ label: "▶ Run all tests", sub: "one after another, about 30 s each" }].concat(tests.map(function (t) {
    return { label: t.label, sub: "#" + t.id + " · " + t.width + "×" + t.height + " · " + Math.round(t.size / 1e6) + " MB", res: t.result };
  }));
  listEl.innerHTML = rows.map(function (r, i) {
    return '<div class="t' + (i === sel ? " on" : "") + '">' + r.label + "<small>" + r.sub + "</small>" +
      (r.res ? '<div class="res">' + r.res + "</div>" : "") + "</div>";
  }).join("");
}

function stop() {
  v.pause();
  v.removeAttribute("src");
  v.load();
}

function runTest(t) {
  return new Promise(function (resolve) {
    var t0 = performance.now();
    var r = { id: t.id, label: t.label, events: {}, ua: navigator.userAgent };
    var finished = false;
    var mark = function (name) { if (r.events[name] === undefined) r.events[name] = Math.round(performance.now() - t0); };
    var names = ["loadstart", "loadedmetadata", "loadeddata", "canplay", "playing", "waiting", "stalled", "seeking", "seeked"];
    var handlers = {};
    names.forEach(function (n) { handlers[n] = function () { mark(n); }; v.addEventListener(n, handlers[n]); });

    function finish(outcome) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      names.forEach(function (n) { v.removeEventListener(n, handlers[n]); });
      v.removeEventListener("error", onError);
      r.outcome = outcome;
      r.videoWidth = v.videoWidth;
      r.videoHeight = v.videoHeight;
      r.currentTime = v.currentTime;
      stop();
      t.result = outcome + (r.firstFrameMs !== undefined ? " · first frame " + r.firstFrameMs + " ms" : "") +
        (r.seekFrameMs !== undefined ? " · seek " + r.seekFrameMs + " ms" : "") +
        (r.videoWidth ? " · " + r.videoWidth + "×" + r.videoHeight : "");
      log(t.label + ": " + t.result);
      render();
      post("/report", r).then(function () { resolve(r); });
    }
    function onError() {
      var e = v.error;
      r.error = e ? { code: e.code, message: e.message } : "unknown";
      finish("ERROR " + (e ? e.code + " " + e.message : ""));
    }
    function afterFrame(cb) {
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(function () { cb(); });
      else v.addEventListener("timeupdate", function once() { v.removeEventListener("timeupdate", once); cb(); });
    }

    var timer = setTimeout(function () { finish(r.firstFrameMs === undefined ? "TIMEOUT (no frame)" : "TIMEOUT"); }, TIMEOUT_MS);
    v.addEventListener("error", onError);
    afterFrame(function () {
      r.firstFrameMs = Math.round(performance.now() - t0);
      r.rvfc = !!v.requestVideoFrameCallback;
      setTimeout(function () {
        r.playedTo = v.currentTime;
        var s0 = performance.now();
        var target = (v.duration || t.duration_s) / 2;
        v.currentTime = target;
        v.addEventListener("seeked", function once() {
          v.removeEventListener("seeked", once);
          r.seekedMs = Math.round(performance.now() - s0);
          // Tizen never calls requestVideoFrameCallback again after a seek (#48), so time-to-playing-again is the
          // first timeupdate past the target instead.
          v.addEventListener("timeupdate", function moved() {
            if (v.currentTime <= target) return;
            v.removeEventListener("timeupdate", moved);
            r.seekFrameMs = Math.round(performance.now() - s0);
            setTimeout(function () { finish("PLAYED"); }, 2000);
          });
        });
      }, PLAY_MS);
    });
    log("playing " + t.label);
    v.src = SERVER + "/copy/" + t.id;
    var p = v.play();
    if (p && p.catch) p.catch(function (e) { r.playRejected = String(e); });
    running = { test: t, finish: finish };
  }).then(function (r) { running = null; return r; });
}

function runNext() {
  var t = queue.shift();
  if (!t) { log("all tests done"); return; }
  runTest(t).then(runNext);
}

document.addEventListener("keydown", function (e) {
  switch (e.keyCode) {
    case 38: sel = Math.max(0, sel - 1); render(); break;
    case 40: sel = Math.min(tests.length, sel + 1); render(); break;
    case 13:
      if (running) break;
      queue = sel === 0 ? tests.slice() : [tests[sel - 1]];
      runNext();
      break;
    case 10009: // Back
      if (running) { queue = []; running.finish("STOPPED"); }
      else if (window.tizen) tizen.application.getCurrentApplication().exit();
      break;
    default:
      log("key " + e.keyCode + " " + e.key);
  }
});

try {
  if (window.tizen && tizen.tvinputdevice) tizen.tvinputdevice.registerKeyBatch(["MediaPlayPause", "MediaPlay", "MediaPause"]);
} catch (e) { log("registerKey failed: " + e); }

log(navigator.userAgent);
fetch(SERVER + "/tests.json")
  .then(function (res) { return res.json(); })
  .then(function (list) { tests = list; render(); post("/report", { hello: true, ua: navigator.userAgent, screen: screen.width + "x" + screen.height, dpr: devicePixelRatio }); })
  .catch(function (e) { listEl.textContent = "Could not reach " + SERVER + ": " + e; });
