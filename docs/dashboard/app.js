// HULLSENSE dashboard: Web Serial link to the node, calibration, verdicts, plots.
// Team BYTEMELATER · SEDHACKS '26
"use strict";
const $ = (id) => document.getElementById(id);
const CAL_POINTS = [[0.150, 0.150], [0.075, 0.075], [0.225, 0.075], [0.075, 0.225], [0.225, 0.225]];
const BUMPER_ZONE = { y0: 0.0, y1: 0.130 };      // bumper covers the top 130 mm of the panel

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
function onMessage(m) {
  if (m.t === "p") onPressure(m.us / 1e6, m.pa);
  else if (m.t === "evt") onEvent(m);
  else if (m.t === "hb") { S.bmpOk = !!m.bmp; drawSensors(); }
  else if (m.t === "hello") setStatus(`node ${m.fw} · sync ${m.sync ? "on" : "off"}`, true);
  else if (m.t === "warn") console.warn(m.msg);
}

function onEvent(m) {
  const tri = HS.triage(m.rise);
  // fail-safe bookkeeping: a wall channel that keeps missing while others fire is flagged
  const fired = m.rise.slice(0, 4).filter((r) => r > 0).length;
  if (fired >= 3) m.rise.slice(0, 4).forEach((r, i) => {
    S.missStreak[i] = r > 0 ? 0 : S.missStreak[i] + 1;
    S.sensorsBad[i] = S.missStreak[i] >= 3;
  });
  drawSensors();

  const tot = HS.totSum(m.rise, m.fall);
  S.lastTot = tot;
  const ev = { time: new Date(), kind: tri.kind, tot, energy: S.energy ? HS.energyJ(S.energy, tot) : null };

  if (tri.kind === "shield") {
    ev.x = 0.150; ev.y = 0.065; ev.note = "bumper only";
    setVerdict("shield", "Shield absorbed it", "Only the bumper sensor fired first. Strike logged to the impact map.", ev);
    pushEvent(ev); return;
  }
  if (tri.kind !== "wall") { console.info("ignored event", tri); return; }

  const rel = HS.ticksToRelSeconds(m.rise);
  if (S.calIdx >= 0) {                                   // calibration in progress
    S.calTaps.push({ q: CAL_POINTS[S.calIdx], t: rel });
    S.calIdx++;
    if (S.calIdx >= CAL_POINTS.length) finishCalibration();
    else $("calState").textContent = `tap point ${S.calIdx + 1} of 5`;
    draw(); return;
  }
  if (!S.cal) { setVerdict("idle", "Calibrate first", "Run the 5-tap calibration so the solver knows the wave speed.", null); return; }

  const loc = HS.locate(rel, S.cal);
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
  const ev = b.ev || { time: new Date(), x: null, y: null, energy: null };
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
function startCalibration() { S.calTaps = []; S.calIdx = 0; $("calState").textContent = "tap point 1 of 5"; draw(); }
function finishCalibration() {
  S.calIdx = -1;
  try {
    S.cal = HS.calibrate(S.calTaps);
    $("calState").textContent = `v = ${S.cal.v.toFixed(0)} m/s · fit rms ${(S.cal.rmsMetres * 1000).toFixed(1)} mm`;
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
}
function pushEvent(ev) { S.events.unshift(ev); S.events = S.events.slice(0, 50); renderLog(); draw(); }
function renderLog() {
  const cls = { shield: "g", wall: "a", breach: "r" }, name = { shield: "SHIELD", wall: "HULL STRUCK", breach: "BREACH" };
  $("log").innerHTML = S.events.slice(0, 8).map((e) => `<tr><td>${e.time.toLocaleTimeString()}</td><td class="${cls[e.kind]}">${name[e.kind] || e.kind}</td>` +
    `<td>${e.x != null ? `(${mm(e.x)}, ${mm(e.y)})` : "–"}</td><td>${e.energy ? (e.energy * 1000).toFixed(1) + " mJ" : "–"}</td><td>${e.note || ""}</td></tr>`).join("");
}
function drawSensors() {
  $("sens").innerHTML = ["P1", "P2", "P3", "P4", "P5"].map((n, i) => `<div class="${S.sensorsBad[i] ? "bad" : ""}">${n} ${S.sensorsBad[i] ? "✕ fault" : "✓"}</div>`).join("") +
    `<div class="${S.bmpOk ? "" : "bad"}">BMP280 ${S.bmpOk ? "✓" : "✕"}</div>`;
}
function draw() {
  const c = $("map"), g = c.getContext("2d"), W = c.width, pad = 20, k = (W - 2 * pad) / HS.PANEL;
  const X = (x) => pad + x * k, Y = (y) => pad + y * k;
  g.clearRect(0, 0, W, W);
  g.fillStyle = "#0d1430"; g.fillRect(pad, pad, W - 2 * pad, W - 2 * pad);
  g.strokeStyle = "#1c2750"; g.lineWidth = 1;
  for (let i = 1; i < 5; i++) { const v = pad + (i * (W - 2 * pad)) / 5; g.beginPath(); g.moveTo(v, pad); g.lineTo(v, W - pad); g.moveTo(pad, v); g.lineTo(W - pad, v); g.stroke(); }
  g.strokeStyle = "#5c6f9e"; g.strokeRect(pad, pad, W - 2 * pad, W - 2 * pad);
  g.fillStyle = "rgba(139,92,246,.14)"; g.fillRect(X(0.006), Y(BUMPER_ZONE.y0 + 0.006), k * 0.288, k * (BUMPER_ZONE.y1 - 0.006));
  g.fillStyle = "#c4b5fd"; g.font = "13px sans-serif"; g.fillText("bumper zone", X(0.12), Y(0.022));
  if (S.calIdx >= 0) CAL_POINTS.forEach((q, i) => { g.strokeStyle = i === S.calIdx ? "#cae8ff" : "#3a4a7a"; g.lineWidth = i === S.calIdx ? 3 : 1; g.beginPath(); g.arc(X(q[0]), Y(q[1]), 12, 0, 7); g.stroke(); });
  const col = { shield: "#34d399", wall: "#fbbf24", breach: "#f87171" };
  [...S.events].reverse().forEach((e, i, arr) => {
    if (e.x == null) return;
    g.fillStyle = col[e.kind] || "#fff"; g.beginPath(); g.arc(X(e.x), Y(e.y), i === arr.length - 1 ? 8 : 5, 0, 7); g.fill();
    if (i === arr.length - 1) { g.strokeStyle = g.fillStyle; g.setLineDash([4, 3]); [18, 34].forEach((r) => { g.beginPath(); g.arc(X(e.x), Y(e.y), r, 0, 7); g.stroke(); }); g.setLineDash([]); }
  });
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
    await port.open({ baudRate: 921600 });
    setStatus("connected", true);
    const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith("{")) { try { onMessage(JSON.parse(line)); } catch (e) { /* partial line */ } }
      }
    }
  } catch (e) { setStatus("disconnected", false); console.error(e); }
}

// ---------------- Simulation (clearly labelled; for demos without hardware) ----------------
function toggleSim() {
  S.sim = !S.sim; $("simBanner").classList.toggle("hidden", !S.sim);
  $("simBanner").textContent = S.sim ? "SIMULATION MODE: synthetic data. Click the map to strike; Shift-click for a strike that breaches the wall." : "";
  if (!S.sim) { clearInterval(S.simTimer); return; }
  let tick = 0; const base = 101325; S.simDp = 2500;
  S.simTimer = setInterval(() => {
    const t = (performance.now() - S.t0) / 1000;
    if (S.simLeak) { const A = Math.PI * (S.simLeak / 2000) ** 2; for (let k = 0; k < 10; k++) S.simDp = Math.max(0, S.simDp - ((base + S.simDp) / 0.008) * 0.62 * A * Math.sqrt((2 * S.simDp) / 1.2) * 1e-3); }
    onMessage({ t: "p", us: t * 1e6, pa: base + S.simDp + (Math.random() - 0.5) * 3 });
    if (++tick % 100 === 0) onMessage({ t: "hb", bmp: 1 });
  }, 10);
  if (!S.cal) {   // auto-calibrate the simulator with its own wave speed
    S.cal = { s: 1 / 600, v: 600, b: [0, 0, 0, 0], rmsMetres: 0 };
    $("calState").textContent = "simulation: v = 600 m/s";
  }
  setStatus("simulation", true);
}
function simStrike(x, y, breach) {
  const ticks = (sec) => Math.round(1e9 + sec * HS.TICK_HZ) >>> 0;
  const jitter = () => (Math.random() - 0.5) * 2e-6;
  const inBumper = y < BUMPER_ZONE.y1 && !breach;
  const arr = HS.SENSORS.map((p) => Math.hypot(x - p[0], y - p[1]) / 600 + jitter() + (inBumper ? 0.0004 : 0));
  const rise = [...arr.map(ticks), inBumper ? ticks(0) : ticks(0.0006)];
  const fall = rise.map((r) => (r + 400000) >>> 0);
  onMessage({ t: "evt", id: Date.now(), us: 0, rise, fall, n: [6, 6, 6, 6, 6] });
  if (breach) setTimeout(() => { S.simLeak = 2.0; setTimeout(() => { S.simLeak = null; S.simDp = 2500; }, 9000); }, 300);
}

$("btnConnect").onclick = connect;
$("btnSim").onclick = toggleSim;
$("btnCal").onclick = startCalibration;
$("btnDrop").onclick = addDrop;
$("btnAmbient").onclick = () => { if (S.p.length) { S.ambient = median(S.p.slice(-50).map((s) => s.pa)); $("ambState").textContent = `ambient: ${S.ambient.toFixed(0)} Pa`; } };
$("map").addEventListener("click", (e) => {
  if (!S.sim) return;
  const c = e.target, r = c.getBoundingClientRect(), pad = 20, k = (c.width - 2 * pad) / HS.PANEL;
  const cx = (e.clientX - r.left) * (c.width / r.width), cy = (e.clientY - r.top) * (c.height / r.height);
  const x = (cx - pad) / k, y = (cy - pad) / k;
  if (x < 0 || y < 0 || x > HS.PANEL || y > HS.PANEL) return;
  simStrike(x, y, e.shiftKey);
});
draw(); drawSensors(); renderLog();
