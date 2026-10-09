// Run: node tests/solver.test.js
// Checks the solver against simulated strikes with timing noise and sensor offsets.
const HS = require("../docs/dashboard/solver.js");
const assert = require("assert");

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const rand = rng(42);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const V = 600;                       // assumed effective wave speed, m/s
const OFFS = [0, 3e-6, -2e-6, 5e-6]; // channel offsets incl. timer-group offset, s
const JITTER = 1e-6;                 // 1 µs timing noise per channel

function arrivals(q, T0) {
  return HS.SENSORS.map((p, i) => T0 + Math.hypot(q[0] - p[0], q[1] - p[1]) / V + OFFS[i] + JITTER * gauss());
}

// --- calibration from 5 taps ---
const calPts = [[0.150, 0.150], [0.075, 0.075], [0.225, 0.075], [0.075, 0.225], [0.225, 0.225]];
const taps = calPts.map((q) => {
  const a = arrivals(q, 1e-3 * rand());
  return { q, t: a.map((ai) => ai - a[0]) };
});
const cal = HS.calibrate(taps);
console.log(`calibration: v = ${cal.v.toFixed(1)} m/s, offsets (µs) = ${cal.b.map((b) => (b * 1e6).toFixed(2)).join(", ")}, rms = ${(cal.rmsMetres * 1000).toFixed(2)} mm`);
assert(Math.abs(cal.v - V) / V < 0.05, "wave speed within 5%");

// --- blind strikes on a 25-point grid ---
const errs = [];
for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
  const q = [0.03 + i * 0.06, 0.03 + j * 0.06];
  const a = arrivals(q, 0);
  const t = a.map((ai) => ai - a[0]);
  const loc = HS.locate(t, cal);
  errs.push(Math.hypot(loc.x - q[0], loc.y - q[1]) * 1000);
}
errs.sort((a, b) => a - b);
const median = errs[Math.floor(errs.length / 2)], p90 = errs[Math.floor(errs.length * 0.9)];
console.log(`localisation on 25-point grid: median ${median.toFixed(1)} mm, 90th pct ${p90.toFixed(1)} mm (1 µs jitter, v = ${V} m/s)`);
assert(median < 25, "median error below 25 mm");

// --- tick conversion handles uint32 wrap ---
const rel = HS.ticksToRelSeconds([4294967000, 200, 4294967100, 50, 0]);
assert(Math.abs(rel[1] - (496 / 80e6)) < 1e-12, "wrap-around handled");

// --- triage ---
assert.strictEqual(HS.triage([1000, 1100, 1200, 1300, 900]).kind, "shield");
assert.strictEqual(HS.triage([1000, 1100, 1200, 1300, 5000]).kind, "wall");
assert.strictEqual(HS.triage([1000, 1100, 0, 1300, 0]).kind, "incomplete");
assert.strictEqual(HS.triage([1000, 1100, 1200, 1000 + 200000, 0]).kind, "noise");

// --- breach sizing on a simulated 8 L box ---
function decay(dmm, dp0 = 2500, V = 0.008, Pamb = 101325) {
  const A = Math.PI * (dmm / 2000) ** 2; let dp = dp0, t = 0; const out = [];
  for (let k = 0; k < 4000; k++) {
    if (k % 10 === 0) out.push({ t, pa: Pamb + dp + 2 * gauss() });   // 100 Hz, 2 Pa noise
    dp = Math.max(0, dp - ((Pamb + dp) / V) * 0.62 * A * Math.sqrt((2 * dp) / 1.2) * 1e-3); t += 1e-3;
  }
  return out;
}
for (const d of [1, 2, 3]) {
  const fit = HS.fitBreach(decay(d), { ambient: 101325 });
  console.log(`breach ${d} mm -> estimated ${fit.diameterMm.toFixed(2)} mm (${fit.used} samples)`);
  assert(Math.abs(fit.diameterMm - d) / d < 0.10, "diameter within 10%");
}

// --- flight scaling matches the deck numbers ---
const m5 = HS.flightMinutes(5);
console.log(`5 mm hole, 91 m3 module: ${m5.toFixed(0)} min to lose 10%`);
assert(Math.abs(m5 - 66) < 2);
console.log("all tests passed");
