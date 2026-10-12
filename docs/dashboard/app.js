// HULLSENSE dashboard: Web Serial link to the node, calibration, verdicts, plots.
// Team BYTEMELATER · SEDHACKS '26
"use strict";
const $ = (id) => document.getElementById(id);

// ---------------- config + storage ----------------
// Rig numbers come from config.js (window.HS_CONFIG); the fallback keeps the page alive without it.
const CFG = window.HS_CONFIG || Object.assign(HS.defaults(), {
  calPoints_m: [[0.150, 0.150], [0.075, 0.075], [0.225, 0.075], [0.075, 0.225], [0.225, 0.225]],
  bumperZone_m: { y0: 0.0, y1: 0.130 }, serialBaud: 921600,
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const DEFAULT_GEOM = { panelSize_m: CFG.panelSize_m, sensors_m: clone(CFG.sensors_m) };
// localStorage may be blocked or full: every access is guarded and the page works without it.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
};
const geomKey = () => JSON.stringify([CFG.panelSize_m, CFG.sensors_m]);
function validGeom(g) {
  const ok = (v) => Number.isFinite(v);
  if (!g || !ok(g.panelSize_m) || g.panelSize_m < 0.05 || g.panelSize_m > 5) return false;
  return Array.isArray(g.sensors_m) && g.sensors_m.length === 4 &&
    g.sensors_m.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => ok(v) && v >= 0 && v <= g.panelSize_m));
}
function applyGeom(g) { CFG.panelSize_m = g.panelSize_m; CFG.sensors_m = clone(g.sensors_m); HS.configure(CFG); }

const S = {
  cal: null, calTaps: [], calIdx: -1,
  energy: null, drops: [], lastTot: null,
  events: [], ambient: null,
  p: [],                       // [{t (s), pa}]
  watch: null,                 // armed after a wall strike: {until, ev}
  breach: null,                // active breach capture: {start, ev, quietSince}
  missStreak: [0, 0, 0, 0, 0], sensorsBad: [false, false, false, false, false], bmpOk: true,
  sim: false, simTimer: null, simLeak: null, t0: performance.now(),
};
const settings = () => ({
  boxVolume: parseFloat($("setV").value) / 1000, cd: parseFloat($("setCd").value),
  moduleVolume: parseFloat($("setVm").value), leakTrigger: parseFloat($("setLeak").value),
});

// ---------------- incoming messages ----------------
// Live and simulated messages enter here. Replay calls handleMessage() directly, so the two never mix.
function onMessage(m, raw) {
  if (S.replay) return;
  dbgLine(raw !== undefined ? raw : JSON.stringify(m), raw !== undefined ? "" : "[sim] ");
  if (S.rec) recLine(raw !== undefined ? raw : JSON.stringify(m), raw === undefined);   // no raw line = simulated
  handleMessage(m);
}
function handleMessage(m) {
  dbgMessage(m);
  lvMessage(m);
  if (m.t === "p") onPressure(m.us / 1e6, m.pa);
  else if (m.t === "evt") onEvent(m);
  else if (m.t === "hb") { S.bmpOk = !!m.bmp; drawSensors(); }
  else if (m.t === "hello") setStatus(S.replay ? "replay" : `node ${m.fw} · sync ${m.sync ? "on" : "off"}`, true);
  else if (m.t === "warn") console.warn(m.msg);
}

function onEvent(m) {
  const tri = HS.triage(m.rise);
  tstOnEvent(tri);
  // fail-safe bookkeeping: a wall channel that keeps missing while others fire is flagged
  const fired = m.rise.slice(0, 4).filter((r) => r > 0).length;
  if (fired >= 3) m.rise.slice(0, 4).forEach((r, i) => {
    S.missStreak[i] = r > 0 ? 0 : S.missStreak[i] + 1;
    S.sensorsBad[i] = S.missStreak[i] >= 3;
  });
  drawSensors();
  if (accOn() && tri.kind !== "wall") { accReject(tri.kind); return; }   // accuracy test: count and skip

  const tot = HS.totSum(m.rise, m.fall);
  S.lastTot = tot;
  const ev = { time: new Date(), kind: tri.kind, tot, energy: S.energy ? HS.energyJ(S.energy, tot) : null,
    fired: m.rise.map((r, i) => (r > 0 ? "P" + (i + 1) : null)).filter(Boolean), sim: S.sim || !!(S.replay && S.replay.simNote), src: S.replay ? "replay" : S.sim ? "simulation" : "live" };

  if (tri.kind === "shield") {
    ev.x = CFG.panelSize_m / 2; ev.y = (CFG.bumperZone_m.y0 + CFG.bumperZone_m.y1) / 2; ev.note = "bumper only";
    setVerdict("shield", "Shield absorbed it", "Only the bumper sensor fired first. Strike logged to the impact map.", ev);
    pushEvent(ev); return;
  }
  if (tri.kind !== "wall") { console.info("ignored event", tri); return; }

  const rel = HS.ticksToRelSeconds(m.rise);
  if (S.calIdx >= 0) {                                   // calibration in progress
    S.calTaps.push({ q: CFG.calPoints_m[S.calIdx], t: rel });
    S.calIdx++;
    if (S.calIdx >= CFG.calPoints_m.length) finishCalibration();
    else $("calState").textContent = `tap point ${S.calIdx + 1} of 5`;
    draw(); return;
  }
  if (!S.cal) { setVerdict("idle", "Calibrate first", "Run the 5-tap calibration so the solver knows the wave speed.", null); return; }

  const loc = HS.locate(rel, S.cal);
  if (accOn()) { accOnLocate(loc); return; }
  tstOnLocate(loc, tot);
  Object.assign(ev, { x: loc.x, y: loc.y, conf: loc.rmsMetres, note: "pressure stable" });
  setVerdict("wall", "Hull struck, sealed", "Wall strike located. Watching box pressure for 5 s.", ev);
  S.watch = { until: lastT() + 5, ev };
  pushEvent(ev);
}

function onPressure(t, pa) {
  S.p.push({ t, pa });
  while (S.p.length && t - S.p[0].t > 20) S.p.shift();
  const slope = slopeOver(0.3);
  const cfg = settings();

  if (!S.breach && slope !== null && slope < -cfg.leakTrigger) {
    const ev = S.watch && t <= S.watch.until ? S.watch.ev : null;
    S.breach = { start: t - 0.35, ev, quietSince: null };
    if (!ev) setVerdict("breach", "Leak detected, location unknown", "Pressure is falling with no recent wall strike. Start a leak hunt.", null);
  }
  if (S.breach) {
    const quiet = slope !== null && slope > -3;
    S.breach.quietSince = quiet ? (S.breach.quietSince ?? t) : null;
    if ((S.breach.quietSince && t - S.breach.quietSince > 0.6) || t - S.breach.start > 20) finishBreach(t);
  }
  if (S.watch && t > S.watch.until && !S.breach) S.watch = null;
  drawPressure();
}

function finishBreach(t) {
  const cfg = settings(), b = S.breach; S.breach = null; S.watch = null;
  const ambient = S.ambient ?? median(S.p.filter((s) => s.t > t - 0.5).map((s) => s.pa));
  const samples = S.p.filter((s) => s.t >= b.start && s.t <= t);
  let fit = null;
  try { fit = HS.fitBreach(samples, { ambient, boxVolume: cfg.boxVolume, cd: cfg.cd }); } catch (e) { console.warn(e.message); }
  const ev = b.ev || { time: new Date(), x: null, y: null, energy: null, sim: S.sim || !!(S.replay && S.replay.simNote), src: S.replay ? "replay" : S.sim ? "simulation" : "live" };
  ev.kind = "breach";
  if (fit) {
    ev.dia = fit.diameterMm;
    ev.minutes = HS.flightMinutes(fit.diameterMm, { moduleVolume: cfg.moduleVolume, cd: cfg.cd });
    ev.note = `Ø ${fit.diameterMm.toFixed(1)} mm · ${fmtMin(ev.minutes)}`;
    ev.fit = { start: samples[0].t, intercept: fit.intercept, c: fit.c, ambient };
  } else ev.note = "breach (decay too short to size)";
  const where = ev.x != null ? `at (${mm(ev.x)}, ${mm(ev.y)}) mm` : "location unknown";
  setVerdict("breach", "BREACH", `Wall strike followed by pressure loss, ${where}. Inspect and patch.`, ev);
  if (!b.ev) pushEvent(ev); else renderLog();
  draw(); drawPressure();
}

// ---------------- calibration ----------------
const calText = (cal) => `v = ${cal.v.toFixed(0)} m/s · fit rms ${(cal.rmsMetres * 1000).toFixed(1)} mm`;
function saveCal() { store.set("hullsense.cal", { cal: S.cal, savedAt: Date.now(), geom: geomKey() }); }
function loadCal() {   // restore a saved calibration if it was made for the current sensor layout
  const r = store.get("hullsense.cal");
  if (!r || !r.cal || r.geom !== geomKey() || !(r.cal.s > 0) || !Array.isArray(r.cal.b)) return;
  S.cal = r.cal;
  $("calState").textContent = `calibration loaded from ${new Date(r.savedAt).toLocaleString()} (${S.cal.source || "hardware"}) · ${calText(S.cal)}`;
}
function clearCal() {
  S.cal = null; S.calStash = null; S.calIdx = -1; S.calTaps = []; store.del("hullsense.cal");
  $("calState").textContent = "not calibrated"; draw();
}
function startCalibration() {
  if (S.rec && !S.replay) recLine(JSON.stringify({ t: "ui", act: "calstart" }), S.sim);   // so a replay can redo the taps
  accStop("calibration started"); tstNoiseEnd("calibration started"); S.calTaps = []; S.calIdx = 0; $("calState").textContent = "tap point 1 of 5"; draw(); }
function finishCalibration() {
  S.calIdx = -1;
  try {
    S.cal = HS.calibrate(S.calTaps);
    S.cal.source = S.replay ? "replay" : S.sim ? "simulation" : "hardware";    // never let a simulated fit pass as real
    if (!S.replay) saveCal();     // a replayed fit must not overwrite the saved calibration
    $("calState").textContent = calText(S.cal) + (S.replay ? " (replay)" : S.sim ? " (simulation)" : "");
  } catch (e) { $("calState").textContent = "calibration failed: " + e.message; }
  draw();
}
function addDrop() {
  if (!S.lastTot) return;
  S.drops.push({ tot: S.lastTot, mass_kg: parseFloat($("ballMass").value) / 1000, height_m: parseFloat($("ballH").value) / 100 });
  if (S.drops.length >= 3) { S.energy = HS.fitEnergy(S.drops); $("energyState").textContent = `energy: fitted from ${S.drops.length} drops`; }
  else $("energyState").textContent = `energy: ${S.drops.length} drop(s), need 3`;
}

// ---------------- UI ----------------
const mm = (m) => (m * 1000).toFixed(0);
const toMm = (m) => +(m * 1000).toFixed(1);
const fmtMin = (min) => (min >= 120 ? `${(min / 60).toFixed(1)} h` : `${min.toFixed(0)} min`);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const lastT = () => (S.p.length ? S.p[S.p.length - 1].t : 0);
function slopeOver(win) {
  const t = lastT(), pts = S.p.filter((s) => s.t > t - win);
  if (pts.length < 8) return null;
  const n = pts.length, mt = pts.reduce((a, s) => a + s.t, 0) / n, mp = pts.reduce((a, s) => a + s.pa, 0) / n;
  let num = 0, den = 0; pts.forEach((s) => { num += (s.t - mt) * (s.pa - mp); den += (s.t - mt) ** 2; });
  return den ? num / den : null;
}
function setStatus(txt, ok) { const el = $("status"); el.textContent = txt; el.className = "pill " + (ok ? "ok" : "bad"); }
function setVerdict(kind, title, sub, ev) {
  $("verdict").className = "verdict " + kind; $("vTitle").textContent = title; $("vSub").textContent = sub;
  $("kLoc").textContent = ev && ev.x != null ? `(${mm(ev.x)}, ${mm(ev.y)})` : "–";
  $("kDia").textContent = ev && ev.dia ? `${ev.dia.toFixed(1)} mm` : "–";
  $("kE").textContent = ev && ev.energy ? `${(ev.energy * 1000).toFixed(1)} mJ` : "–";
  $("kT").textContent = ev && ev.minutes ? fmtMin(ev.minutes) : "–";
  demoVerdict(kind, title, ev); speakVerdict(kind, title, ev);
}
function pushEvent(ev) { S.events.unshift(ev); S.events = S.events.slice(0, 50); renderLog(); draw(); }
function renderLog() {
  if (typeof reportRefresh === "function") reportRefresh();
  const cls = { shield: "g", wall: "a", breach: "r" }, name = { shield: "SHIELD", wall: "HULL STRUCK", breach: "BREACH" };
  $("log").innerHTML = S.events.slice(0, 8).map((e) => `<tr><td>${e.time.toLocaleTimeString()}</td><td class="${cls[e.kind]}">${name[e.kind] || e.kind}</td>` +
    `<td>${e.x != null ? `(${mm(e.x)}, ${mm(e.y)})` : "–"}</td><td>${e.energy ? (e.energy * 1000).toFixed(1) + " mJ" : "–"}</td><td>${e.note || ""}</td></tr>`).join("");
}
function drawSensors() {
  $("sens").innerHTML = ["P1", "P2", "P3", "P4", "P5"].map((n, i) => `<div class="${S.sensorsBad[i] ? "bad" : ""}">${n} ${S.sensorsBad[i] ? "✕ fault" : "✓"}</div>`).join("") +
    `<div class="${S.bmpOk ? "" : "bad"}">BMP280 ${S.bmpOk ? "✓" : "✕"}</div>`;
}
function draw() {
  drawMap($("map"));
  if (S.demo) { drawMap($("demoMap")); drawHeat(); }
}
function drawMap(c) {   // fixed 560 x 560 drawing space, scaled to the canvas so the demo map stays sharp
  const g = c.getContext("2d"), W = 560, pad = 20, k = (W - 2 * pad) / HS.PANEL;
  g.setTransform(c.width / W, 0, 0, c.width / W, 0, 0);
  const X = (x) => pad + x * k, Y = (y) => pad + y * k;
  g.clearRect(0, 0, W, W);
  g.fillStyle = "#0d1430"; g.fillRect(pad, pad, W - 2 * pad, W - 2 * pad);
  g.strokeStyle = "#1c2750"; g.lineWidth = 1;
  for (let i = 1; i < 5; i++) { const v = pad + (i * (W - 2 * pad)) / 5; g.beginPath(); g.moveTo(v, pad); g.lineTo(v, W - pad); g.moveTo(pad, v); g.lineTo(W - pad, v); g.stroke(); }
  g.strokeStyle = "#5c6f9e"; g.strokeRect(pad, pad, W - 2 * pad, W - 2 * pad);
  g.fillStyle = "rgba(139,92,246,.14)"; g.fillRect(X(0.006), Y(CFG.bumperZone_m.y0 + 0.006), k * (HS.PANEL - 0.012), k * (CFG.bumperZone_m.y1 - 0.006));
  g.fillStyle = "#c4b5fd"; g.font = "13px sans-serif"; g.fillText("bumper zone", X(HS.PANEL * 0.4), Y(0.022));
  if (S.calIdx >= 0) CFG.calPoints_m.forEach((q, i) => { g.strokeStyle = i === S.calIdx ? "#cae8ff" : "#3a4a7a"; g.lineWidth = i === S.calIdx ? 3 : 1; g.beginPath(); g.arc(X(q[0]), Y(q[1]), 12, 0, 7); g.stroke(); });
  const col = { shield: "#34d399", wall: "#fbbf24", breach: "#f87171" };
  [...S.events].reverse().forEach((e, i, arr) => {
    if (e.x == null) return;
    g.fillStyle = col[e.kind] || "#fff"; g.beginPath(); g.arc(X(e.x), Y(e.y), i === arr.length - 1 ? 8 : 5, 0, 7); g.fill();
    if (i === arr.length - 1) { g.strokeStyle = g.fillStyle; g.setLineDash([4, 3]); [18, 34].forEach((r) => { g.beginPath(); g.arc(X(e.x), Y(e.y), r, 0, 7); g.stroke(); }); g.setLineDash([]); }
  });
  if (S.acc) drawAccuracy(g, X, Y);
  g.fillStyle = "#cae8ff"; HS.SENSORS.forEach((p, i) => { g.beginPath(); g.arc(X(p[0]), Y(p[1]), 7, 0, 7); g.fill(); g.fillText("P" + (i + 1), X(p[0]) + (i % 2 ? -28 : 12), Y(p[1]) + (i < 2 ? 22 : -10)); });
}
function drawPressure() {
  const c = $("pchart"), g = c.getContext("2d"), W = c.width, H = c.height, pad = 34;
  g.clearRect(0, 0, W, H);
  if (S.p.length < 2) return;
  const tEnd = lastT(), win = 10, pts = S.p.filter((s) => s.t > tEnd - win);
  const lo = Math.min(...pts.map((s) => s.pa)) - 20, hi = Math.max(...pts.map((s) => s.pa)) + 20;
  const X = (t) => pad + ((t - (tEnd - win)) / win) * (W - pad - 10), Y = (p) => H - 20 - ((p - lo) / (hi - lo)) * (H - 40);
  g.strokeStyle = "#1c2750"; for (let i = 0; i <= 4; i++) { const y = 20 + (i * (H - 40)) / 4; g.beginPath(); g.moveTo(pad, y); g.lineTo(W - 10, y); g.stroke(); }
  g.fillStyle = "#7f93bd"; g.font = "11px sans-serif"; g.fillText(`${hi.toFixed(0)} Pa`, 0, 24); g.fillText(`${lo.toFixed(0)} Pa`, 0, H - 22); g.fillText("last 10 s", W - 60, H - 4);
  g.strokeStyle = "#cae8ff"; g.lineWidth = 2; g.beginPath(); pts.forEach((s, i) => (i ? g.lineTo(X(s.t), Y(s.pa)) : g.moveTo(X(s.t), Y(s.pa)))); g.stroke();
  const f = S.events.find((e) => e.fit);
  if (f && f.fit.start > tEnd - win) {
    g.strokeStyle = "#fbbf24"; g.setLineDash([6, 5]); g.beginPath();
    for (let t = f.fit.start; t < tEnd; t += 0.05) {
      const r = f.fit.intercept - (f.fit.c / 2) * t; if (r <= 0) break;
      const p = f.fit.ambient + r * r; t === f.fit.start ? g.moveTo(X(t), Y(p)) : g.lineTo(X(t), Y(p));
    }
    g.stroke(); g.setLineDash([]);
  }
}

// ---------------- Web Serial ----------------
async function connect() {
  if (!("serial" in navigator)) { alert("Web Serial needs Chrome or Edge on desktop."); return; }
  try {
    const port = await navigator.serial.requestPort();
    accStop("connected"); tstNoiseEnd("connected"); clearReplayView();
    if (S.cal && S.cal.source && S.cal.source !== "hardware") { S.cal = null; $("calState").textContent = "not calibrated (simulated calibration discarded)"; }
    await port.open({ baudRate: CFG.serialBaud });
    setStatus("connected", true); S.live = true; S.port = port;
    const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { S.live = false; break; }
      buf += value; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith("{")) { try { onMessage(JSON.parse(line), line); } catch (e) { /* partial line */ } }
      }
    }
  } catch (e) { S.live = false; setStatus("disconnected", false); console.error(e); }
}

// ---------------- Simulation (clearly labelled; for demos without hardware) ----------------
function toggleSim() {
  if (S.replay) return;
  accStop("mode changed"); tstNoiseEnd("mode changed");
  if (!S.sim) clearReplayView();   // about to switch simulation on
  S.sim = !S.sim; $("simBanner").classList.toggle("hidden", !S.sim);
  $("simBanner").textContent = S.sim ? "SIMULATION MODE: synthetic data. Click the map to strike; Shift-click for a strike that breaches the wall." : "";
  if (!S.sim) {
    clearInterval(S.simTimer);
    if (S.cal && S.cal.source && S.cal.source !== "hardware") {   // drop simulated fits; bring back a real one
      S.cal = S.calStash; S.calStash = null;
      $("calState").textContent = S.cal ? calText(S.cal) : "not calibrated";
    }
    return;
  }
  let tick = 0; const base = 101325; S.simDp = 2500;
  S.simTimer = setInterval(() => {
    const t = (performance.now() - S.t0) / 1000;
    if (S.simLeak) { const A = Math.PI * (S.simLeak / 2000) ** 2; for (let k = 0; k < 10; k++) S.simDp = Math.max(0, S.simDp - ((base + S.simDp) / 0.008) * 0.62 * A * Math.sqrt((2 * S.simDp) / 1.2) * 1e-3); }
    onMessage({ t: "p", us: t * 1e6, pa: base + S.simDp + (Math.random() - 0.5) * 3 });
    if (++tick % 100 === 0) onMessage({ t: "hb", bmp: 1, us: t * 1e6, edges: S.simEdges || [0, 0, 0, 0, 0] });
  }, 10);
  if (!S.cal || S.cal.source === "hardware") {   // simulator uses its own wave speed; a real fit is set aside
    S.calStash = S.cal;
    S.cal = { s: 1 / 600, v: 600, b: [0, 0, 0, 0], rmsMetres: 0, source: "sim-auto" };
    $("calState").textContent = "simulation: v = 600 m/s";
  }
  setStatus("simulation", true);
}
function simStrike(x, y, breach) {
  const ticks = (sec) => Math.round(1e9 + sec * HS.TICK_HZ) >>> 0;
  const jitter = () => (Math.random() - 0.5) * 2e-6;
  // a channel check taps the sensor itself: P1..P4 skip the bumper, P5 forces it
  const inBumper = S.dbg.test === 4 || (y < CFG.bumperZone_m.y1 && !breach && S.calIdx < 0 && !accOn() && S.dbg.test == null);   // calibration taps hit the wall directly
  const arr = HS.SENSORS.map((p) => Math.hypot(x - p[0], y - p[1]) / 600 + jitter() + (inBumper ? 0.0004 : 0));
  const rise = [...arr.map(ticks), inBumper ? ticks(0) : ticks(0.0006)];
  const fall = rise.map((r) => (r + 400000) >>> 0);
  S.simEdges = (S.simEdges || [0, 0, 0, 0, 0]).map((e) => e + 6);   // synthetic edge counters for the debug panel
  onMessage({ t: "evt", id: Date.now(), us: 0, rise, fall, n: [6, 6, 6, 6, 6] });
  if (breach) setTimeout(() => { S.simLeak = 2.0; setTimeout(() => { S.simLeak = null; S.simDp = 2500; }, 9000); }, 300);
}

$("btnConnect").onclick = connect;
$("btnSim").onclick = toggleSim;
$("btnCal").onclick = startCalibration;
$("btnCalClear").onclick = clearCal;
$("btnDrop").onclick = addDrop;
$("btnAmbient").onclick = () => { if (S.p.length) { S.ambient = median(S.p.slice(-50).map((s) => s.pa)); $("ambState").textContent = `ambient: ${S.ambient.toFixed(0)} Pa`; } };
function mapClick(e) {
  if (!S.sim && !(accOn() && S.acc.mode === "free")) return;
  const c = e.target, r = c.getBoundingClientRect(), pad = 20, k = (560 - 2 * pad) / HS.PANEL;   // canvases draw in a 560 x 560 space
  const cx = (e.clientX - r.left) * (560 / r.width), cy = (e.clientY - r.top) * (560 / r.height);
  const x = (cx - pad) / k, y = (cy - pad) / k;
  if (x < 0 || y < 0 || x > HS.PANEL || y > HS.PANEL) return;
  if (S.sim) simStrike(x, y, e.shiftKey && !accOn());
  // free mode: the click says where the tap really was (in simulation the strike above was at this point)
  if (accOn() && S.acc.mode === "free" && S.acc.pending) accRecord([x, y], S.acc.pending);
}
$("map").addEventListener("click", mapClick); $("demoMap").addEventListener("click", mapClick);

// ---------------- accuracy test ----------------
// Grid mode: tap the highlighted target, the next valid wall event is scored against it.
// Free mode: tap anywhere, then click the map where you tapped. Simulation clicks act as taps.
const ACC_INSET = 0.030, ACC_N = 5;
const accOn = () => !!(S.acc && S.acc.active);
function accTargets() {
  const step = (CFG.panelSize_m - 2 * ACC_INSET) / (ACC_N - 1), t = [];
  for (let r = 0; r < ACC_N; r++) for (let c = 0; c < ACC_N; c++) t.push([ACC_INSET + c * step, ACC_INSET + r * step]);
  return t;
}
function quantile(sorted, q) {      // linear interpolation between ranks
  if (!sorted.length) return null;
  const p = (sorted.length - 1) * q, i = Math.floor(p);
  return sorted[i] + (i + 1 < sorted.length ? (sorted[i + 1] - sorted[i]) * (p - i) : 0);
}
function accStats() {
  const m = S.acc.rows.map((r) => r.miss).sort((a, b) => a - b);
  return { n: m.length, median: quantile(m, 0.5), p90: quantile(m, 0.9), worst: m.length ? m[m.length - 1] : null, rejected: S.acc.rejected };
}
function accSummary() {
  const s = accStats(), f = (v) => (v == null ? "-" : v.toFixed(0));
  return `${S.acc.sim ? "SIMULATION " : ""}Accuracy: ${s.n} points, median ${f(s.median)} mm, 90th pct ${f(s.p90)} mm, worst ${f(s.worst)} mm, ${s.rejected} rejected`;
}
function accRefresh() {
  if (S.tst) tstRefresh();       // keep the combined results box current
  demoMissUpdate();
  const a = S.acc, st = $("accState");
  $("btnAccSkip").disabled = !accOn(); $("btnAccStop").disabled = !accOn();
  $("btnAccRedo").disabled = !a || !(a.active || a.done) || !a.hist.length;
  $("btnAccCsv").disabled = $("btnAccCopy").disabled = !a || !a.rows.length;
  if (!a) { st.textContent = "idle"; $("accStats").textContent = ""; return; }
  const tag = a.sim ? "SIMULATION · " : "", t = a.mode === "grid" && a.idx < ACC_N * ACC_N ? accTargets()[a.idx] : null;
  if (a.active && a.mode === "grid") st.textContent = `${tag}tap target ${a.idx + 1} of ${ACC_N * ACC_N} at (${mm(t[0])}, ${mm(t[1])}) mm${a.sim ? " (click the map)" : ""}`;
  else if (a.active) st.textContent = tag + (a.pending ? "tap registered: click the map where you tapped" : a.sim ? "click the map to strike" : "tap the surface, then click where you tapped");
  else st.textContent = tag + (a.done ? "complete" : "stopped");
  const s = accStats(), f = (v) => (v == null ? "–" : v.toFixed(1));
  $("accStats").textContent = `points ${s.n} · median ${f(s.median)} mm · 90th ${f(s.p90)} mm · worst ${f(s.worst)} mm · rejected ${s.rejected}`;
}
function accStop(why) {
  if (!accOn()) return;
  S.acc.active = false; S.acc.pending = null; accRefresh();
  if (why) $("accState").textContent += ` (${why})`;
  draw();
}
function startAcc() {
  if (S.replay) { $("accState").textContent = "not available during replay"; return; }
  if (S.calIdx >= 0) { $("accState").textContent = "finish the calibration first"; return; }
  if (!S.cal) { $("accState").textContent = "calibrate first (or start Simulation)"; return; }
  S.acc = { active: true, mode: $("accMode").value, sim: S.sim, idx: 0, rows: [], hist: [], rejected: 0, pending: null, done: false };
  accRefresh(); draw();
}
function accReject(kind) { S.acc.rejected++; accRefresh(); $("accState").textContent += ` · last event rejected (${kind})`; }
function accOnLocate(loc) {          // called with every valid wall event while a test is running
  const a = S.acc;
  if (a.mode === "grid") accRecord(accTargets()[a.idx], loc);
  else { a.pending = loc; accRefresh(); }
}
function accRecord(t, loc) {
  const a = S.acc, miss = Math.hypot(loc.x - t[0], loc.y - t[1]) * 1000;
  const row = { point: a.mode === "grid" ? a.idx + 1 : a.rows.length + 1, tx: t[0], ty: t[1], lx: loc.x, ly: loc.y, miss, conf: loc.rmsMetres * 1000, time: new Date() };
  a.rows.push(row); a.hist.push({ idx: a.idx, row }); a.pending = null;
  if (a.mode === "grid" && ++a.idx >= ACC_N * ACC_N) { a.active = false; a.done = true; }
  setVerdict("wall", "Accuracy test", `Point ${row.point}: missed by ${miss.toFixed(1)} mm`, { x: loc.x, y: loc.y });
  accRefresh(); draw();
}
function accSkip() {
  const a = S.acc; if (!accOn()) return;
  if (a.mode === "grid") { a.hist.push({ idx: a.idx, row: null }); if (++a.idx >= ACC_N * ACC_N) { a.active = false; a.done = true; } }
  a.pending = null; accRefresh(); draw();
}
function accRedo() {
  const a = S.acc, e = a && a.hist.pop(); if (!e) return;
  if (e.row) a.rows.splice(a.rows.indexOf(e.row), 1);
  if (a.mode === "grid") a.idx = e.idx;
  a.active = true; a.done = false; a.pending = null; accRefresh(); draw();
}
function accCsv() {
  const a = S.acc, src = a.sim ? "SIMULATION" : "HARDWARE", f = (v) => (v * 1000).toFixed(1);
  const lines = ["point,target_x_mm,target_y_mm,located_x_mm,located_y_mm,miss_mm,conf,time,source"];
  a.rows.forEach((r) => lines.push([r.point, f(r.tx), f(r.ty), f(r.lx), f(r.ly), r.miss.toFixed(1), r.conf.toFixed(2), r.time.toISOString(), src].join(",")));
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  const el = document.createElement("a");
  el.href = url; el.download = `hullsense_accuracy_${a.sim ? "SIMULATION_" : ""}${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  document.body.appendChild(el); el.click(); el.remove(); URL.revokeObjectURL(url);
}
async function accCopy() {
  const text = accSummary();
  try { await navigator.clipboard.writeText(text); $("accState").textContent = "summary copied"; }
  catch (e) { window.prompt("Copy this summary:", text); }
}
function drawAccuracy(g, X, Y) {
  const a = S.acc;
  g.font = "11px sans-serif";
  if (a.mode === "grid") accTargets().forEach((t, i) => {
    const cur = a.active && i === a.idx, done = a.rows.some((r) => r.point === i + 1);
    g.strokeStyle = cur ? "#cae8ff" : done ? "#34d399" : "#3a4a7a"; g.lineWidth = cur ? 3 : 1;
    g.beginPath(); g.arc(X(t[0]), Y(t[1]), cur ? 14 : 9, 0, 7); g.stroke();
    g.fillStyle = cur ? "#cae8ff" : "#7f93bd"; g.fillText(String(i + 1), X(t[0]) - (i >= 9 ? 6 : 3), Y(t[1]) + 4);
  });
  a.rows.forEach((r) => {      // line from target to where the solver put it
    g.strokeStyle = g.fillStyle = "#f472b6"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(r.tx), Y(r.ty)); g.lineTo(X(r.lx), Y(r.ly)); g.stroke();
    g.beginPath(); g.arc(X(r.lx), Y(r.ly), 4, 0, 7); g.fill();
  });
  g.lineWidth = 1;
}
$("btnAccStart").onclick = startAcc; $("btnAccSkip").onclick = accSkip; $("btnAccRedo").onclick = accRedo;
$("btnAccStop").onclick = () => accStop(); $("btnAccCsv").onclick = accCsv; $("btnAccCopy").onclick = accCopy;

// ---------------- record and replay ----------------
// Recording keeps every live or simulated message with its arrival time (ms). Replay feeds the saved
// lines through handleMessage() at the original pace; live data is ignored while a replay runs.
const REC_MAX = 600000;                        // ~100 minutes at 100 Hz pressure
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
function recLine(line, sim) {
  if (S.rec.lines.length >= REC_MAX) { stopRec("recording full"); return; }
  const e = { ms: Date.now(), line };
  if (sim) e.sim = 1;                          // marks synthetic lines so a replay can say so
  S.rec.lines.push(e);
}
function recRefresh() {
  const on = !!S.rec, n = S.rec ? S.rec.lines.length : 0;
  $("recBadge").classList.toggle("hidden", !on);
  $("recBadge").textContent = `● REC ${n} lines`;
  $("btnRec").textContent = on ? "Stop recording" : "Record";
  $("demoRec").classList.toggle("hidden", !on); $("demoRec").textContent = $("recBadge").textContent;
  $("btnRecSave").disabled = !n;
}
function startRec() {
  const meta = {   // starting point a replay needs: calibration, ambient and breach settings
    t: "meta", app: "hullsense-dashboard", recorded: new Date().toISOString(), cal: S.cal, ambient: S.ambient,
    settings: { v: $("setV").value, cd: $("setCd").value, vm: $("setVm").value, leak: $("setLeak").value },
  };
  S.rec = { lines: [{ ms: Date.now(), line: JSON.stringify(meta) }] };
  $("recState").textContent = "recording"; recRefresh();
}
function stopRec(why) {
  if (!S.rec) return;
  S.recSaved = S.rec; S.rec = null;            // keep the lines so they can still be saved
  $("recState").textContent = `recorded ${S.recSaved.lines.length} lines${why ? " (" + why + ")" : ""}`; recRefresh();
  $("btnRecSave").disabled = false;
}
function saveRec() {
  const r = S.rec || S.recSaved; if (!r || !r.lines.length) return;
  const sim = r.lines.some((l) => l.sim);
  const url = URL.createObjectURL(new Blob([r.lines.map((l) => JSON.stringify(l)).join("\n") + "\n"], { type: "application/x-ndjson" }));
  const el = document.createElement("a");
  el.href = url; el.download = `hullsense_recording_${sim ? "SIMULATION_" : ""}${stamp()}.jsonl`;
  document.body.appendChild(el); el.click(); el.remove(); URL.revokeObjectURL(url);
}
function toggleRec() { if (S.rec) stopRec(); else { S.recSaved = null; startRec(); } }
setInterval(() => { if (S.rec) recRefresh(); }, 500);   // refresh the line counter without redrawing at 100 Hz

const calStateText = () => (S.cal ? calText(S.cal) + (S.cal.source && S.cal.source !== "hardware" ? ` (${S.cal.source})` : "") : "not calibrated");
function setReplayLock(on) {
  ["btnConnect", "btnSim", "btnRec", "btnReplay", "btnCal", "btnCalClear", "btnAccStart", "btnCfgSave", "btnCfgReset", "btnNoiStart", "btnTriBumper", "btnTriWall", "btnShSoft", "btnShHard"].forEach((id) => { $(id).disabled = on; });
  $("btnReplayStop").disabled = !on; $("replaySpeed").disabled = on;
}
function clearReplayView() {     // drop replayed dots and pressure before live or simulated data starts
  if (!S.replayView) return;
  S.replayView = null; $("replayBanner").classList.add("hidden");
  S.events = []; S.p = []; S.watch = null; S.breach = null;
  setVerdict("idle", "Waiting for a strike", "Connect the node, calibrate with 5 taps, then strike the panel.", null);
  renderLog(); draw(); drawPressure();
}
async function loadReplay(file) {
  let text;
  try { text = await file.text(); } catch (e) { $("recState").textContent = "could not read file"; return; }
  const lines = []; let bad = 0, prev = 0;
  text.split("\n").forEach((l) => {
    l = l.trim(); if (!l) return;
    try {
      const o = JSON.parse(l);
      if (Number.isFinite(o.ms) && typeof o.line === "string") { prev = Math.max(prev, o.ms); lines.push({ ms: prev, line: o.line, sim: o.sim }); } else bad++;
    } catch (e) { bad++; }
  });
  if (!lines.length) { $("recState").textContent = "no valid lines in that file"; return; }
  let meta = null;
  try { const m = JSON.parse(lines[0].line); if (m.t === "meta") meta = m; } catch (e) { /* no meta line */ }
  startReplay(lines, meta, file.lastModified, bad);
}
function startReplay(lines, meta, fileTime, bad) {
  if (S.live) { $("recState").textContent = "disconnect the node (reload the page) before replaying"; return; }
  if (S.sim) toggleSim();
  accStop("replay started"); tstNoiseEnd("replay started"); stopRec();
  S.replayStash = { cal: S.cal };
  Object.assign(S, { p: [], events: [], watch: null, breach: null, calIdx: -1, calTaps: [], missStreak: [0, 0, 0, 0, 0], sensorsBad: [false, false, false, false, false], bmpOk: true });
  if (meta) {    // recorded calibration and settings, so verdicts match what was seen live
    if (meta.cal && meta.cal.s > 0 && Array.isArray(meta.cal.b)) { S.cal = Object.assign({}, meta.cal, { source: "replay" }); }
    S.ambient = meta.ambient ?? null;
    if (meta.settings) { $("setV").value = meta.settings.v; $("setCd").value = meta.settings.cd; $("setVm").value = meta.settings.vm; $("setLeak").value = meta.settings.leak; }
  }
  const label = new Date(meta && meta.recorded ? meta.recorded : fileTime).toLocaleString();
  const anySim = lines.some((l) => l.sim);
  S.replay = { lines, i: 0, ms0: lines[0].ms, t0: performance.now(), speed: parseFloat($("replaySpeed").value) || 1, label, simNote: anySim ? " · includes SIMULATED data" : "", timer: null, args: [lines, meta, fileTime, bad] };
  S.replayView = true;
  $("replayBanner").textContent = `REPLAY of recorded data from ${label}, not live${S.replay.simNote}`;
  $("replayBanner").classList.remove("hidden");
  $("calState").textContent = calStateText();
  setStatus("replay", true); setReplayLock(true);
  setVerdict("idle", "Replaying recording", "Recorded data, not live.", null);
  renderLog(); drawSensors(); draw(); drawPressure();
  $("recState").textContent = `replaying ${lines.length} lines at ${S.replay.speed}x${bad ? ` (${bad} bad lines skipped)` : ""}`;
  replayTick();
}
function replayTick() {
  const R = S.replay; if (!R) return;
  const now = R.ms0 + (performance.now() - R.t0) * R.speed;
  while (R.i < R.lines.length && R.lines[R.i].ms <= now) {
    const e = R.lines[R.i++];
    dbgLine(e.line, "[replay] ");
    try {
      const m = JSON.parse(e.line);
      if (m.t === "ui") { if (m.act === "calstart") startCalibration(); } else handleMessage(m);
    } catch (err) { console.warn("replay: skipped a line", err.message); }
  }
  if (R.i >= R.lines.length) {
    if ($("replayLoop").checked) { endReplay("looping"); startReplay(...R.args); return; }   // Loop: start the same recording again
    endReplay("finished"); return;
  }
  $("recState").textContent = `replaying ${Math.round((100 * R.i) / R.lines.length)}% at ${R.speed}x`;
  R.timer = setTimeout(replayTick, Math.max(1, (R.lines[R.i].ms - now) / R.speed));
}
function endReplay(how) {
  const R = S.replay; if (!R) return;
  clearTimeout(R.timer); S.replay = null;
  S.cal = S.replayStash.cal; S.replayStash = null; S.calIdx = -1; S.calTaps = [];   // back to the pre-replay calibration
  $("calState").textContent = calStateText();
  $("replayBanner").textContent = `REPLAY of recorded data from ${R.label}, not live${R.simNote} · ${how}`;
  setReplayLock(false); setStatus("disconnected", false);
  $("recState").textContent = `replay ${how}`;
  draw();
}
$("btnRec").onclick = toggleRec; $("btnRecSave").onclick = saveRec;
$("btnReplay").onclick = () => $("replayFile").click();
$("replayFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) loadReplay(f); });
$("btnReplayStop").onclick = () => endReplay("stopped");
recRefresh();

// ---------------- direct mode: live signal card ----------------
// Direct-mode firmware (piezos straight into the ESP32) adds "lv" level messages, "pk" in events, mode/th/base in hello and
// loop_us in hb. Nothing here touches the solver, calibration or triage. Simulation never shows this card (no fake ADC values).
S.lv = { direct: false, v: [0, 0, 0, 0, 0], base: [0, 0, 0, 0, 0], th: null, at: 0, loopUs: null };
const adcVolts = (counts) => (Math.max(0, counts) * 3.3) / 4095;

function lvMessage(m) {          // every message that reaches handleMessage(): live or replayed
  const L = S.lv;
  if (m.t === "hello") {
    L.direct = m.mode === "direct";
    if (L.direct) {
      if (Array.isArray(m.base) && m.base.length === 5) L.base = m.base.slice();
      if (Number.isFinite(m.th)) { L.th = m.th; $("lvTh").value = m.th; }
    }
  } else if (m.t === "hb") {
    if (m.mode === "direct") L.direct = true;
    if (Number.isFinite(m.loop_us)) L.loopUs = m.loop_us;
  } else if (m.t === "lv") {
    if (!Array.isArray(m.v) || m.v.length !== 5) return;
    L.direct = true; L.v = m.v; L.at = performance.now();
    if (Array.isArray(m.base) && m.base.length === 5) L.base = m.base;
    if (Number.isFinite(m.th) && m.th !== L.th) { L.th = m.th; if (document.activeElement !== $("lvTh")) $("lvTh").value = m.th; }
  } else if (m.t === "ack" && m.cmd === "TH" && Number.isFinite(m.th)) {
    L.th = m.th; $("lvTh").value = m.th; $("lvThMsg").textContent = "threshold set: " + m.th;
  } else return;
  lvRender();
}
function lvRender() {
  const L = S.lv, fresh = performance.now() - L.at < 1000;        // bars fall to zero when levels stop arriving
  const thV = L.th == null ? null : adcVolts(L.th);
  for (let i = 0; i < 5; i++) {
    const volts = fresh ? adcVolts(L.v[i] - (L.base[i] || 0)) : 0, fill = $(`lvFill${i + 1}`), mark = $(`lvMark${i + 1}`);
    fill.style.width = Math.min(100, (volts / 3.3) * 100) + "%";
    fill.classList.toggle("over", thV != null && volts > thV);     // red while above the threshold marker
    $(`lvVal${i + 1}`).textContent = volts.toFixed(2) + " V";
    mark.style.display = thV == null ? "none" : "block"; mark.style.left = thV == null ? "0" : (thV / 3.3) * 100 + "%";
  }
  $("lvTiming").textContent = L.loopUs == null ? "Timing step: –" : `Timing step ≈ ${L.loopUs.toFixed(1)} µs (direct mode)`;
}
function lvTick() {              // visibility, badge, decay and control state
  const L = S.lv, src = !!(S.live || S.replay);
  if (!src || S.sim) L.direct = false;
  const show = L.direct && src && !S.sim;
  $("liveCard").classList.toggle("hidden", !show);
  $("directBadge").classList.toggle("hidden", !show);
  const canSend = !!(S.live && S.port) && !S.replay;
  $("lvTh").disabled = $("btnLvSet").disabled = !canSend;
  if (show) lvRender();
}
async function lvSetThreshold() {
  const n = parseInt($("lvTh").value, 10), msg = (t) => { $("lvThMsg").textContent = t; };
  if (!(n >= 20 && n <= 4095)) return msg("enter a threshold from 20 to 4095");
  if (S.replay) return msg("not available during replay");
  if (!S.live || !S.port) return msg("not connected");
  try { await sendLine("TH " + n); dbgLine("> TH " + n, ""); msg(`sent TH ${n}, waiting for the board`); }
  catch (e) { msg("send failed: " + e.message); }
}
$("btnLvSet").onclick = lvSetThreshold;
$("lvTh").addEventListener("keydown", (e) => { if (e.key === "Enter") lvSetThreshold(); });
setInterval(lvTick, 100);
lvTick();

// ---------------- debug panel ----------------
// Hardware bring-up helpers: last event timing, per-channel edge rates, channel check, raw console, BMP280 status.
const CH = ["P1", "P2", "P3", "P4", "P5"];
const NOISE_PER_S = 5;                         // edges/s on an untouched channel above this is noise
S.dbg = {
  evt: null, ref: 0, first: -1, src: "", evtThis: false, evtPrev: false,
  hb: null, edges: null, rates: Array(5).fill(null), noisy: Array(5).fill(false),
  test: null, testMsg: "", testOk: false,
  lines: [], paused: false, lastPAt: 0, lastPa: null, bmp: undefined, activeSince: null, timer: null,
};
const evtSource = () => (S.replay ? "replay" : S.sim ? "simulation" : "live");

function dbgMessage(m) {         // every message that reaches handleMessage(): live, simulated or replayed
  const d = S.dbg;
  if (m.t === "p") { d.lastPAt = performance.now(); d.lastPa = m.pa; }
  else if (m.t === "evt") dbgEvent(m);
  else if (m.t === "hb") dbgHeartbeat(m);
  else if (m.t === "hello") d.bmp = !!m.bmp;
}
function dbgEvent(m) {
  if (!Array.isArray(m.rise) || m.rise.length !== 5) return;
  const d = S.dbg;
  let first = -1, ref = 0;
  m.rise.forEach((r, i) => { if (r > 0 && (first < 0 || ((r - ref) | 0) < 0)) { first = i; ref = r; } });   // wrap-safe earliest
  Object.assign(d, { evt: m, ref, first, src: evtSource(), evtThis: true });
  if (d.test !== null && first >= 0) {        // channel check: did the tapped channel fire first?
    d.testOk = first === d.test;
    d.testMsg = d.testOk ? `PASS: ${CH[first]} fired first` : `${CH[first]} fired first: cables swapped?`;
    d.test = null;
  }
  dbgSchedule();
}
function dbgHeartbeat(m) {
  const d = S.dbg;
  if ("bmp" in m) d.bmp = !!m.bmp;
  if (Array.isArray(m.edges) && m.edges.length === 5) {
    const now = performance.now(), prev = d.hb;
    if (prev) {   // use the node's clock when present so replay speed does not distort the rate
      let dt = Number.isFinite(m.us) && Number.isFinite(prev.us) && m.us > prev.us ? (m.us - prev.us) / 1e6 : (now - prev.at) / 1000;
      if (dt > 0) d.rates = m.edges.map((e, i) => ((e - prev.edges[i]) >>> 0) / dt);
    }
    d.hb = { at: now, us: m.us, edges: m.edges }; d.edges = m.edges;
    const touched = d.evtThis || d.evtPrev;   // a strike in the last two heartbeat intervals explains the edges
    d.noisy = d.rates.map((r) => r != null && r > NOISE_PER_S && !touched);
  }
  d.evtPrev = d.evtThis; d.evtThis = false;
  dbgSchedule();
}
function dbgLine(text, tag) {
  const d = S.dbg;
  if (d.paused || ($("dbgHideP").checked && text.startsWith('{"t":"p"')) || ($("dbgHideLv").checked && text.startsWith('{"t":"lv"'))) return;
  d.lines.push(`${new Date().toISOString().slice(11, 23)} ${tag}${text.length > 220 ? text.slice(0, 220) + "…" : text}`);
  if (d.lines.length > 30) d.lines.shift();
  dbgSchedule();
}
function dbgSchedule() { if (!S.dbg.timer) S.dbg.timer = setTimeout(() => { S.dbg.timer = null; dbgRender(); }, 100); }

function dbgRender() {
  if ($("debug").open === false) return;
  const d = S.dbg;
  $("dbgSrc").textContent = d.evt ? `Last event (${d.src})` : "No event yet";
  const hasPk = !!(d.evt && Array.isArray(d.evt.pk));
  $("dbgPkHead").classList.toggle("hidden", !hasPk);
  $("dbgRows").innerHTML = CH.map((n, i) => {
    const r = d.evt ? d.evt.rise[i] : 0, f = d.evt ? d.evt.fall[i] : 0, fired = r > 0;
    const arr = fired ? (((r - d.ref) | 0) / 80).toFixed(1) : "–", tot = fired && f > 0 ? (((f - r) | 0) / 80).toFixed(1) : "–";
    const cnt = d.edges ? d.edges[i] : "–", rate = d.rates[i] == null ? "–" : d.rates[i].toFixed(1);
    return `<tr class="${fired && i === d.first ? "first" : ""} ${d.noisy[i] ? "noisy" : ""}"><td>${n}</td><td>${d.evt ? (fired ? "yes" : "no") : "–"}</td>` +
      `<td>${arr}</td><td>${tot}</td><td>${cnt}</td><td>${rate}${d.noisy[i] ? " noise" : ""}</td>` +
      (hasPk ? `<td>${adcVolts(d.evt.pk[i] - (S.lv.base[i] || 0)).toFixed(2)}</td>` : "") + "</tr>";
  }).join("");
  const tm = $("dbgTestMsg");
  tm.textContent = d.test !== null ? `Tap ${CH[d.test]} now…` : d.testMsg; tm.className = "small " + (d.testOk ? "g" : d.test === null && d.testMsg ? "r" : "");
  $("dbgConsole").textContent = d.lines.join("\n");
  dbgStatus();
}
function dbgStatus() {         // BMP280 and pressure freshness; runs twice a second even with no traffic
  const d = S.dbg, now = performance.now(), active = !!(S.live || S.sim || S.replay);
  if (active && d.activeSince === null) d.activeSince = now; else if (!active) d.activeSince = null;
  $("dbgBmp").textContent = d.bmp === undefined ? "BMP280: unknown" : d.bmp ? "BMP280: OK" : "BMP280: NOT FOUND";
  $("dbgBmp").className = d.bmp === false ? "r" : "";
  $("dbgPa").textContent = d.lastPa == null ? "pressure: –" : `pressure: ${d.lastPa.toFixed(1)} Pa (${(d.lastPa / 1000).toFixed(2)} kPa)`;
  const age = now - Math.max(d.lastPAt, d.activeSince || 0);
  $("dbgPWarn").classList.toggle("hidden", !(active && age > 2000));
  $("dbgPWarn").textContent = `⚠ no pressure message for ${(age / 1000).toFixed(0)} s`;
}
async function sendLine(cmd) {     // the one serial writer: PING, SYNC and TH <n> all go through here
  const w = S.port.writable.getWriter();
  try { await w.write(new TextEncoder().encode(cmd + "\n")); } finally { w.releaseLock(); }
}
async function dbgSend() {
  const cmd = $("dbgCmd").value.trim().toUpperCase(), msg = (t) => { $("dbgCmdMsg").textContent = t; };
  if (cmd !== "PING" && cmd !== "SYNC") return msg("only PING or SYNC");
  if (S.replay) return msg("not available during replay");
  if (S.sim) return msg("simulation: there is no node to send to");
  if (!S.live || !S.port) return msg("not connected");
  try {
    await sendLine(cmd);
    dbgLine("> " + cmd, ""); msg("sent " + cmd);
  } catch (e) { msg("send failed: " + e.message); }
}
CH.forEach((n, i) => {
  $(`btnTest${i + 1}`).onclick = () => { S.dbg.test = i; S.dbg.testMsg = ""; S.dbg.testOk = false; dbgRender(); };
});
$("btnDbgPause").onclick = () => { S.dbg.paused = !S.dbg.paused; $("btnDbgPause").textContent = S.dbg.paused ? "Resume" : "Pause"; };
$("btnDbgSend").onclick = dbgSend;
$("dbgCmd").addEventListener("keydown", (e) => { if (e.key === "Enter") dbgSend(); });
$("debug").addEventListener("toggle", dbgRender);
setInterval(dbgStatus, 500);

// ---------------- guided tests ----------------
// Triage: arm "bumper" or "wall", then hit it; each event's verdict is scored. Noise: count every event in a timed
// window. Soft vs hard: average located position and time-over-threshold for two sets of taps on one spot.
S.tst = {
  tri: { expect: null, rows: [] },                     // rows: {expect, got, ok, sim, time}
  noise: { running: false, start: 0, dur: 300, count: 0, sim: false, done: null, timer: null },
  sh: { mode: null, soft: [], hard: [] },              // samples: {x, y, tot (µs), sim}
};
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

function tstOnEvent(tri) {       // called for every event, before the normal verdict logic
  const T = S.tst; if (S.replay) return;
  if (T.noise.running) T.noise.count++;
  if (T.tri.expect && S.calIdx < 0) {
    const got = tri.kind === "shield" ? "bumper" : tri.kind;     // wall / incomplete / noise stay as they are
    T.tri.rows.push({ expect: T.tri.expect, got, ok: got === T.tri.expect, sim: S.sim, time: new Date() });
  }
  tstRefresh();
}
function tstOnLocate(loc, tot) { // called for located wall events
  const T = S.tst; if (S.replay || !T.sh.mode) return;
  T.sh[T.sh.mode].push({ x: loc.x, y: loc.y, tot: (tot / 4) * 1e6, sim: S.sim });   // mean ToT over the 4 wall channels
  tstRefresh();
}
function tstNoiseStart() {
  const N = S.tst.noise, mins = parseFloat($("noiMin").value);
  if (N.running || S.replay) return;
  if (!(mins > 0)) { $("noiState").textContent = "enter a duration in minutes"; return; }
  Object.assign(N, { running: true, start: performance.now(), dur: mins * 60, count: 0, sim: S.sim, done: null });
  N.timer = setInterval(() => { if ((performance.now() - N.start) / 1000 >= N.dur) tstNoiseEnd(); else tstRefresh(); }, 250);
  tstRefresh();
}
function tstNoiseEnd(why) {      // no argument = ran to the end; a reason = cancelled early
  const N = S.tst.noise; if (!N.running) return;
  clearInterval(N.timer); N.running = false;
  N.done = { count: N.count, secs: why ? Math.min(N.dur, (performance.now() - N.start) / 1000) : N.dur, cancelled: !!why, sim: N.sim, why };
  tstRefresh();
}
function shStats(set) {
  return set.length ? { n: set.length, x: mean(set.map((s) => s.x)), y: mean(set.map((s) => s.y)), tot: mean(set.map((s) => s.tot)) } : null;
}

// every finished result as {key, text, detail, sim}; SIMULATION is added to the text when any input was simulated
function tstLines() {
  const T = S.tst, L = [], add = (key, text, sim, detail) => L.push({ key, sim, detail, text: (sim && !text.startsWith("SIMULATION") ? "SIMULATION " : "") + text });
  const r = T.tri.rows;
  if (r.length) {
    const ok = r.filter((x) => x.ok).length, nb = r.filter((x) => x.expect === "bumper").length;
    add("tri", `Triage: ${ok}/${r.length} correct (${nb} bumper, ${r.length - nb} wall)`, r.some((x) => x.sim));
  }
  const d = T.noise.done;
  if (d) {
    const when = d.cancelled ? `${(d.secs / 60).toFixed(1)} min (cancelled early)` : `${+(d.secs / 60).toFixed(1)} min`;
    add("noise", `Noise: ${d.count} false alarm${d.count === 1 ? "" : "s"} in ${when}`, d.sim);
  }
  const so = shStats(T.sh.soft), ha = shStats(T.sh.hard);
  if (so && ha) {
    const f = (s) => `n=${s.n}, avg (${(s.x * 1000).toFixed(1)}, ${(s.y * 1000).toFixed(1)}) mm, ToT ${s.tot.toFixed(0)} µs`;
    add("sh", `Soft vs hard: ${(Math.hypot(so.x - ha.x, so.y - ha.y) * 1000).toFixed(0)} mm shift`, [...T.sh.soft, ...T.sh.hard].some((s) => s.sim),
      `  soft ${f(so)}; hard ${f(ha)}`);
  }
  if (S.acc && S.acc.rows.length) add("acc", accSummary(), S.acc.sim);
  return L;
}
function tstResultsText() {
  const L = tstLines(), head = [`HULLSENSE test results · ${new Date().toLocaleString()}`];
  if (L.some((l) => l.sim)) head.push("SIMULATION: at least one result below uses simulated data, not hardware.");
  return head.concat(L.length ? L.flatMap((l) => (l.detail ? [l.text, l.detail] : [l.text])) : ["(no results yet)"]).join("\n");
}

function tstRefresh() {
  const T = S.tst, L = tstLines(), line = (k) => (L.find((l) => l.key === k) || {}).text || "";
  // triage
  const r = T.tri.rows;
  $("triState").textContent = T.tri.expect ? `ARMED: the next hit should be the ${T.tri.expect.toUpperCase()}` : "not armed: pick what you are about to hit";
  $("btnTriBumper").classList.toggle("on", T.tri.expect === "bumper"); $("btnTriWall").classList.toggle("on", T.tri.expect === "wall");
  $("triList").textContent = r.map((x, i) => `${i + 1}. expected ${x.expect}, got ${x.got}  ${x.ok ? "✓" : "✗"}${x.sim ? "  (sim)" : ""}`).reverse().join("\n");
  $("triSum").textContent = line("tri");
  // noise
  const N = T.noise, left = Math.max(0, N.dur - (performance.now() - N.start) / 1000);
  $("btnNoiStart").disabled = N.running; $("btnNoiStop").disabled = !N.running;
  $("noiState").textContent = N.running ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")} left · false alarms so far: ${N.count}${N.sim ? " (simulation)" : ""}` :
    N.done ? (N.done.cancelled ? `cancelled (${N.done.why})` : "finished") : "make noise around the rig, but do not tap the surface";
  $("noiSum").textContent = line("noise");
  // soft vs hard
  const so = shStats(T.sh.soft), ha = shStats(T.sh.hard), show = (s) => (s ? `n=${s.n} · avg (${(s.x * 1000).toFixed(1)}, ${(s.y * 1000).toFixed(1)}) mm · ToT ${s.tot.toFixed(0)} µs` : "no taps yet");
  $("shState").textContent = T.sh.mode ? `COLLECTING ${T.sh.mode.toUpperCase()} taps: tap the same spot` : "not collecting";
  $("btnShSoft").classList.toggle("on", T.sh.mode === "soft"); $("btnShHard").classList.toggle("on", T.sh.mode === "hard");
  $("shInfo").textContent = `soft: ${show(so)}\nhard: ${show(ha)}` + (so && ha ? `\nshift between averages: ${(Math.hypot(so.x - ha.x, so.y - ha.y) * 1000).toFixed(1)} mm` : "");
  $("shSum").textContent = line("sh");
  $("tstResults").value = tstResultsText();
}
async function tstCopy(text) {
  if (!text) { $("tstMsg").textContent = "nothing to copy yet"; return; }
  try { await navigator.clipboard.writeText(text); $("tstMsg").textContent = "copied"; }
  catch (e) { window.prompt("Copy this:", text); }
}
function tstDownload() {
  const sim = tstLines().some((l) => l.sim), url = URL.createObjectURL(new Blob([tstResultsText() + "\n"], { type: "text/plain" }));
  const el = document.createElement("a");
  el.href = url; el.download = sim ? "results_SIMULATION.txt" : "results.txt";
  document.body.appendChild(el); el.click(); el.remove(); URL.revokeObjectURL(url);
}
const tstLineText = (k) => (tstLines().find((l) => l.key === k) || {}).text || "";
$("btnTriBumper").onclick = () => { S.tst.tri.expect = "bumper"; tstRefresh(); };
$("btnTriWall").onclick = () => { S.tst.tri.expect = "wall"; tstRefresh(); };
$("btnTriStop").onclick = () => { S.tst.tri.expect = null; tstRefresh(); };
$("btnTriUndo").onclick = () => { S.tst.tri.rows.pop(); tstRefresh(); };
$("btnTriReset").onclick = () => { S.tst.tri.rows = []; S.tst.tri.expect = null; tstRefresh(); };
$("btnTriCopy").onclick = () => tstCopy(tstLineText("tri"));
$("noiMin").addEventListener("input", () => { const m = parseFloat($("noiMin").value); $("btnNoiStart").textContent = `Start ${m > 0 ? +m.toFixed(2) : "…"}-minute noise test`; });
$("btnNoiStart").onclick = tstNoiseStart;
$("btnNoiStop").onclick = () => tstNoiseEnd("cancelled");
$("btnNoiCopy").onclick = () => tstCopy(tstLineText("noise"));
$("btnShSoft").onclick = () => { S.tst.sh.mode = "soft"; tstRefresh(); };
$("btnShHard").onclick = () => { S.tst.sh.mode = "hard"; tstRefresh(); };
$("btnShStop").onclick = () => { S.tst.sh.mode = null; tstRefresh(); };
$("btnShReset").onclick = () => { Object.assign(S.tst.sh, { mode: null, soft: [], hard: [] }); tstRefresh(); };
$("btnShCopy").onclick = () => tstCopy(tstLineText("sh"));
$("btnTstCopy").onclick = () => tstCopy(tstResultsText());
$("btnTstDownload").onclick = tstDownload;
$("tstRefreshBtn").onclick = tstRefresh;     // picks up a newer accuracy result
tstRefresh();

// ---------------- demo mode (projector view) ----------------
// body.demo hides the control UI and shows #demo: big map, huge verdict, location, miss, heatmap.
// The SIMULATION and REPLAY banners are outside #demo, so they stay visible.
S.demo = false; S.muted = true;                // voice is off until someone turns it on
const DEMO_TITLES = { "Shield absorbed it": "SHIELD", "Hull struck, sealed": "HULL STRUCK", "BREACH": "BREACH" };
let demoBannerH = 0;

function demoVerdict(kind, title, ev) {
  $("dverdict").className = "dverdict " + kind;
  $("dTitle").textContent = DEMO_TITLES[title] || title.toUpperCase();
  $("dLoc").textContent = ev && ev.x != null ? `(${mm(ev.x)}, ${mm(ev.y)}) mm` : "";
  $("dDetail").textContent = (ev && ev.note) || "";
}
function demoMissUpdate() {      // miss distance, shown while a free-mode accuracy test is running
  const a = S.acc, el = $("dMiss"), on = !!(a && a.active && a.mode === "free");
  el.classList.toggle("hidden", !on);
  if (!on) return;
  const last = a.rows[a.rows.length - 1], s = accStats();
  el.textContent = last ? `MISS ${last.miss.toFixed(0)} mm · median ${s.median.toFixed(0)} mm · ${s.n} pts` : "Accuracy test: tap, then click where you tapped";
}
function sizeDemo() {
  const dpr = window.devicePixelRatio || 1;
  demoBannerH = ["simBanner", "replayBanner"].reduce((h, id) => h + ($(id).offsetHeight || 0), 0);
  const side = Math.max(200, Math.min(window.innerHeight - demoBannerH - 40, window.innerWidth * 0.55));
  const hs = Math.max(120, Math.min(side * 0.4, window.innerWidth * 0.25));
  [["demoMap", side], ["demoHeat", hs]].forEach(([id, px]) => {
    const c = $(id); c.width = c.height = Math.round(px * dpr); c.style.width = c.style.height = px + "px";
  });
}
function drawHeat() {            // last 10 located strikes, overlapping blobs add up to hot spots
  const c = $("demoHeat"), g = c.getContext("2d"), N = 300, pad = 8, k = (N - 2 * pad) / HS.PANEL;
  g.setTransform(c.width / N, 0, 0, c.width / N, 0, 0);
  g.globalCompositeOperation = "source-over"; g.clearRect(0, 0, N, N);
  g.fillStyle = "#0d1430"; g.fillRect(pad, pad, N - 2 * pad, N - 2 * pad);
  g.globalCompositeOperation = "lighter";
  S.events.filter((e) => e.x != null && e.kind !== "shield").slice(0, 10).forEach((e) => {   // shield dots have no real location
    const x = pad + e.x * k, y = pad + e.y * k, r = 0.04 * k, gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, "rgba(255,150,40,.6)"); gr.addColorStop(1, "rgba(255,150,40,0)");
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  });
  g.globalCompositeOperation = "source-over";
  g.strokeStyle = "#5c6f9e"; g.lineWidth = 1; g.strokeRect(pad, pad, N - 2 * pad, N - 2 * pad);
  g.fillStyle = "#cae8ff"; HS.SENSORS.forEach((p) => { g.beginPath(); g.arc(pad + p[0] * k, pad + p[1] * k, 3, 0, 7); g.fill(); });
}
function enterDemo() {
  if (S.demo) return;
  S.demo = true; document.body.classList.add("demo");
  try { const p = document.documentElement.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* fullscreen unavailable: overlay still works */ }
  sizeDemo(); demoMissUpdate(); draw();
}
function exitDemo() {
  if (!S.demo) return;
  S.demo = false; document.body.classList.remove("demo");
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* ignore */ }
  draw();
}
const toggleDemo = () => (S.demo ? exitDemo() : enterDemo());

// ---- spoken alerts (browser speech synthesis, no key) ----
const canSpeak = () => "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
function speak(text) {
  if (!canSpeak()) return;
  try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch (e) { /* ignore */ }
}
const spokenMin = (m) => (m < 1 ? "less than 1 minute" : m < 120 ? `${Math.round(m)} minute${Math.round(m) === 1 ? "" : "s"}` : `${(m / 60).toFixed(1)} hours`);
function speakVerdict(kind, title, ev) {
  if (S.muted || title === "Accuracy test") return;
  let t = "";
  if (kind === "shield") t = "Shield absorbed the strike.";
  else if (kind === "wall" && ev && ev.x != null) t = `Hull strike at ${mm(ev.x)}, ${mm(ev.y)} millimetres. Pressure stable.`;
  else if (kind === "breach") t = ev && ev.dia ? `Breach. Hole about ${+ev.dia.toFixed(1)} millimetres. ${spokenMin(ev.minutes)} to limit.` :
    ev && ev.x != null ? "Breach. Hole size unknown." : "Leak detected. Location unknown.";
  if (t) speak((S.replay ? "Replay. " : S.sim ? "Simulated. " : "") + t);   // never let synthetic data sound real
}
function setMuted(m) {
  S.muted = m;
  ["btnMute", "btnDemoMute"].forEach((id) => { $(id).textContent = canSpeak() ? (m ? "🔇 Muted" : "🔊 Voice on") : "Voice n/a"; $(id).disabled = !canSpeak(); });
  if (!m) speak("Voice on."); else if (canSpeak()) { try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
}

$("btnDemo").onclick = toggleDemo; $("btnDemoExit").onclick = exitDemo;
$("btnMute").onclick = $("btnDemoMute").onclick = () => setMuted(!S.muted);
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target && e.target.tagName;
  if (e.key === "Escape") exitDemo();
  else if ((e.key === "d" || e.key === "D") && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") toggleDemo();
});
document.addEventListener("fullscreenchange", () => { if (S.demo && !document.fullscreenElement) exitDemo(); });   // Esc leaves fullscreen first
window.addEventListener("resize", () => { if (S.demo) { sizeDemo(); draw(); } });
setInterval(() => {              // a banner appearing or disappearing changes the room left for the map
  if (S.demo && ["simBanner", "replayBanner"].reduce((h, id) => h + ($(id).offsetHeight || 0), 0) !== demoBannerH) { sizeDemo(); draw(); }
}, 1000);
setMuted(true);

// ---------------- incident report (optional LLM wording) ----------------
// The verdict and every number come from HULLSENSE. The LLM only rewords them; a local template is the fallback.
// The API key lives only in this browser's localStorage and is never logged, recorded or written to a file.
const LLM_URL = "https://openrouter.ai/api/v1/chat/completions";
const LLM_TIMEOUT_MS = 15000;
const LLM_PLACEHOLDER_MODEL = "YOUR_MODEL_ID";
const LLM_SYSTEM = "You write 4-line incident reports for a spacecraft crew. Use ONLY the numbers given. Do not invent numbers or causes. " +
  "Line 1: verdict. Line 2: location. Line 3: severity and time. Line 4: recommended next action (inspect / patch / isolate). " +
  "If simulation is true, start with 'SIMULATION:'.";

const llmCfg = () => ({ key: $("llmKey").value.trim(), model: $("llmModel").value.trim() });
function llmSave() { const c = llmCfg(); store.set("hullsense.llm", { key: c.key, model: c.model }); reportRefresh(); }
{ const saved = store.get("hullsense.llm"); if (saved) { $("llmKey").value = saved.key || ""; $("llmModel").value = saved.model || LLM_PLACEHOLDER_MODEL; } }

// numbers handed to the LLM and to the template: one source of truth, matching what the dashboard shows
function reportPayload(ev) {
  const located = ev.x != null && ev.kind !== "shield";     // a shield dot has no real wall location
  return {
    kind: ev.kind,
    x_mm: located ? Math.round(ev.x * 1000) : null, y_mm: located ? Math.round(ev.y * 1000) : null,
    confidence: located && ev.conf != null ? `location fit residual ${(ev.conf * 1000).toFixed(1)} mm` : null,
    energy: ev.energy ? `${(ev.energy * 1000).toFixed(1)} mJ` : null,
    hole_mm: ev.dia ? +ev.dia.toFixed(1) : null,
    minutes_left: ev.minutes ? Math.round(ev.minutes) : null,      // minutes until the module loses 10% of its pressure
    time: ev.time.toLocaleString(), sensors_fired: ev.fired || null, simulation: !!ev.sim,
  };
}
function reportTemplate(p) {
  const verdict = { shield: "the outer shield absorbed the strike (bumper sensor fired first)", wall: "the hull wall was struck and is sealed", breach: "BREACH of the hull wall" }[p.kind] || p.kind;
  const loc = p.x_mm != null ? `Location: (${p.x_mm}, ${p.y_mm}) mm from the panel's top-left corner${p.confidence ? ", " + p.confidence : ""}.` :
    p.kind === "shield" ? "Location: bumper zone, not located on the wall." : "Location: not determined.";
  const sev = p.kind === "breach"
    ? (p.hole_mm != null ? `Severity: hole about ${p.hole_mm} mm${p.minutes_left != null ? `, about ${fmtMin(p.minutes_left)} to lose 10% of module pressure` : ""}` : "Severity: hole size could not be fitted")
    : `Severity: no pressure loss recorded${p.energy ? `, strike energy ${p.energy}` : ""}`;
  const act = { shield: "inspect the bumper around the strike", wall: "inspect the wall at the marked location", breach: p.hole_mm != null ? "isolate the module and patch the breach" : "isolate the module and inspect for the leak" }[p.kind] || "inspect";
  return [`${p.simulation ? "SIMULATION: " : ""}Verdict: ${verdict}.`, loc, `${sev} (event time ${p.time}).`, `Recommended action: ${act}.`].join("\n");
}
function extraNumbers(text, p) {   // numbers in the reply that are not in the data we sent
  const ok = new Set();
  (JSON.stringify(p).match(/\d+(?:\.\d+)?/g) || []).forEach((s) => { const v = parseFloat(s); ok.add(v); ok.add(Math.round(v)); ok.add(+v.toFixed(1)); });
  return [...new Set((text.match(/\d+(?:\.\d+)?/g) || []).map(parseFloat))].filter((v) => !ok.has(v));
}

class LlmError extends Error {}
async function llmReport(p, cfg) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(LLM_URL, {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: "Bearer " + cfg.key, "Content-Type": "application/json", "X-Title": "HULLSENSE" },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "system", content: LLM_SYSTEM }, { role: "user", content: JSON.stringify(p) }], max_tokens: 250 }),
    });
  } catch (e) {   // never log e or the request: keep the key out of the console
    if (e && e.name === "AbortError") throw new LlmError(`No answer from OpenRouter after ${LLM_TIMEOUT_MS / 1000} s (timed out).`);
    throw new LlmError("Could not reach OpenRouter (offline, blocked, or the key has invalid characters).");
  } finally { clearTimeout(timer); }
  let body = null; try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const why = body && body.error && body.error.message ? ` (${body.error.message})` : "";
    if (res.status === 401 || res.status === 403) throw new LlmError(`OpenRouter rejected the API key (HTTP ${res.status}). Check the key in Settings.`);
    if (res.status === 400 || res.status === 404) throw new LlmError(`OpenRouter did not accept the model id "${cfg.model}" (HTTP ${res.status})${why}. Check Model in Settings.`);
    if (res.status === 402) throw new LlmError("OpenRouter says the account has no credit (HTTP 402).");
    if (res.status === 429) throw new LlmError("OpenRouter rate limit reached (HTTP 429). Try again in a moment.");
    throw new LlmError(`OpenRouter error HTTP ${res.status}${why}.`);
  }
  const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  if (!text || !text.trim()) throw new LlmError("OpenRouter returned an empty reply.");
  return text.trim();
}

function reportRefresh() {
  const busy = $("btnReport").dataset.busy === "1";
  $("btnReport").disabled = busy || !S.events.length;
  $("reportHint").textContent = llmCfg().key ? "Sends only the event numbers to OpenRouter. The verdict is always computed here." : "No API key set: the report uses the local template.";
}
async function writeReport() {
  const ev = S.events[0]; if (!ev) return;
  const p = reportPayload(ev), cfg = llmCfg(), tpl = reportTemplate(p);
  const btn = $("btnReport");
  btn.dataset.busy = "1"; btn.textContent = "Writing…"; reportRefresh();
  $("reportErr").textContent = ""; $("reportWarn").textContent = "";
  let text = tpl, ai = false;
  if (!cfg.key) $("reportErr").textContent = "";
  else if (!cfg.model || cfg.model === LLM_PLACEHOLDER_MODEL) $("reportErr").textContent = "Set a real model id in Settings (see openrouter.ai/models). Showing the template instead.";
  else {
    try {
      text = await llmReport(p, cfg); ai = true;
      if (p.simulation && !/^\s*SIMULATION:/i.test(text)) text = "SIMULATION: " + text;   // never let a simulated event read as real
      const extra = extraNumbers(text, p);
      if (extra.length) $("reportWarn").textContent = `⚠ The AI text contains numbers that are not in the HULLSENSE data (${extra.join(", ")}). Check it before use.`;
    } catch (e) {
      text = tpl;
      $("reportErr").textContent = (e instanceof LlmError ? e.message : "Report failed.") + " Showing the template instead.";
    }
  }
  const src = ev.src === "replay" ? " · replayed recording, not live" : ev.sim ? " · SIMULATION" : "";
  $("reportLabel").textContent = (ai ? `AI-written summary (numbers from HULLSENSE) · ${cfg.model}` : "Template report (not AI-written; numbers from HULLSENSE)") + src + ` · event ${p.time}`;
  $("reportText").textContent = text;
  btn.dataset.busy = "0"; btn.textContent = "Write incident report"; reportRefresh();
}
$("llmKey").addEventListener("input", llmSave); $("llmModel").addEventListener("input", llmSave);
$("btnLlmForget").onclick = () => { $("llmKey").value = ""; llmSave(); };
$("btnReport").onclick = writeReport;
reportRefresh();

// ---------------- setup panel ----------------
function fillSetup() {
  $("cfgPanel").value = toMm(CFG.panelSize_m);
  CFG.sensors_m.forEach((p, i) => { $(`cfgP${i + 1}x`).value = toMm(p[0]); $(`cfgP${i + 1}y`).value = toMm(p[1]); });
  $("panelLabel").textContent = `Module wall · panel A-03 · ${toMm(CFG.panelSize_m)} × ${toMm(CFG.panelSize_m)} mm`;
}
function changeGeom(g, persist) {
  const before = geomKey();
  applyGeom(g);
  if (persist) store.set("hullsense.config", { panelSize_m: g.panelSize_m, sensors_m: g.sensors_m });
  else store.del("hullsense.config");
  let msg = persist ? "saved" : "reset to defaults";
  if (geomKey() !== before && S.cal && S.cal.source !== "sim-auto") { clearCal(); msg += "; calibration cleared (layout changed)"; }
  fillSetup(); draw();
  $("cfgState").textContent = msg;
}
$("btnCfgSave").onclick = () => {
  const num = (id) => parseFloat($(id).value) / 1000;
  const g = { panelSize_m: num("cfgPanel"), sensors_m: [1, 2, 3, 4].map((n) => [num(`cfgP${n}x`), num(`cfgP${n}y`)]) };
  if (!validGeom(g)) { $("cfgState").textContent = "invalid: use numbers, with every sensor on the panel"; return; }
  changeGeom(g, true);
};
$("btnCfgReset").onclick = () => changeGeom(clone(DEFAULT_GEOM), false);

// saved sensor layout first, then the calibration that belongs to it
{ const saved = store.get("hullsense.config"); if (saved && validGeom(saved)) applyGeom(saved); }
fillSetup(); loadCal();
draw(); drawSensors(); renderLog();
