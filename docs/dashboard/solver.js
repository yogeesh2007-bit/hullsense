// HULLSENSE solver: calibration, strike localisation, energy, breach sizing.
// Pure functions, no DOM. Works in the browser (window.HS) and in Node (module.exports).
// Units: metres, seconds, pascals unless stated. Team BYTEMELATER · SEDHACKS '26.
(function (root) {
  "use strict";

  const TICK_HZ = 80e6;               // ESP32 MCPWM capture clock (12.5 ns)
  const PANEL = 0.300;                 // test wall is 300 x 300 mm
  // Wall sensors P1..P4 (metres, origin at the panel's top-left corner)
  const SENSORS = [[0.020, 0.020], [0.280, 0.020], [0.020, 0.280], [0.280, 0.280]];

  // ---------- small dense linear algebra ----------
  function solveLinear(A, b) {           // Gaussian elimination with partial pivoting
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-18) throw new Error("singular system");
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function leastSquares(rows, rhs) {     // normal equations; rows small and well-conditioned here
    const n = rows[0].length;
    const AtA = Array.from({ length: n }, () => Array(n).fill(0)), Atb = Array(n).fill(0);
    rows.forEach((r, k) => {
      for (let i = 0; i < n; i++) { Atb[i] += r[i] * rhs[k]; for (let j = 0; j < n; j++) AtA[i][j] += r[i] * r[j]; }
    });
    return solveLinear(AtA, Atb);
  }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

  // Convert raw capture ticks for the 4 wall channels into seconds relative to channel 1.
  // uint32 wrap-around is handled with a signed 32-bit difference.
  function ticksToRelSeconds(rise) {
    const t1 = rise[0] >>> 0;
    return rise.slice(0, 4).map((r) => (((r >>> 0) - t1) | 0) / TICK_HZ);
  }

  // ---------- 1. Calibration ----------
  // Taps at known points q_k. Model: t_ik = T_k + s*|q_k - p_i| + b_i, with b_1 = 0.
  // Unknowns: T_1..T_K, slowness s (= 1/v), offsets b_2..b_4. Linear least squares.
  function calibrate(taps, sensors = SENSORS) {
    if (taps.length < 3) throw new Error("need at least 3 calibration taps");
    const K = taps.length, nU = K + 4, rows = [], rhs = [];
    taps.forEach((tap, k) => {
      tap.t.forEach((tik, i) => {
        const row = Array(nU).fill(0);
        row[k] = 1;                         // T_k
        row[K] = dist(tap.q, sensors[i]);   // s
        if (i > 0) row[K + i] = 1;          // b_i
        rows.push(row); rhs.push(tik);
      });
    });
    const x = leastSquares(rows, rhs);
    const s = x[K], b = [0, x[K + 1], x[K + 2], x[K + 3]];
    let ss = 0;
    rows.forEach((r, k) => { const pred = r.reduce((a, v, j) => a + v * x[j], 0); ss += (pred - rhs[k]) ** 2; });
    const rms = Math.sqrt(ss / rows.length);
    return { s, v: 1 / s, b, rmsSeconds: rms, rmsMetres: rms / s };
  }

  // ---------- 2. Localisation ----------
  function residuals(t, cal, x, y, sensors) {
    const d = sensors.map((p) => Math.hypot(x - p[0], y - p[1]));
    const T = t.reduce((a, ti, i) => a + (ti - cal.b[i] - cal.s * d[i]), 0) / t.length;
    return { d, T, r: t.map((ti, i) => ti - cal.b[i] - T - cal.s * d[i]) };
  }
  function locate(t, cal, sensors = SENSORS, opts = {}) {
    const step = opts.gridStep || 0.002, margin = opts.margin || 0.0;
    let best = { cost: Infinity, x: 0, y: 0 };
    for (let x = -margin; x <= PANEL + margin + 1e-9; x += step) {
      for (let y = -margin; y <= PANEL + margin + 1e-9; y += step) {
        const { r } = residuals(t, cal, x, y, sensors);
        const cost = r.reduce((a, v) => a + v * v, 0);
        if (cost < best.cost) best = { cost, x, y };
      }
    }
    // Gauss-Newton on (x, y, T)
    let x = best.x, y = best.y, T = residuals(t, cal, x, y, sensors).T;
    for (let it = 0; it < 20; it++) {
      const J = [], r = [];
      sensors.forEach((p, i) => {
        const d = Math.max(Math.hypot(x - p[0], y - p[1]), 1e-6);
        r.push(t[i] - cal.b[i] - T - cal.s * d);
        J.push([cal.s * (x - p[0]) / d, cal.s * (y - p[1]) / d, 1]);  // -dr/dparam
      });
      let dx;
      try { dx = leastSquares(J, r); } catch (e) { break; }
      x += dx[0]; y += dx[1]; T += dx[2];
      if (Math.hypot(dx[0], dx[1]) < 1e-6) break;
    }
    const { r } = residuals(t, cal, x, y, sensors);
    const rms = Math.sqrt(r.reduce((a, v) => a + v * v, 0) / r.length);
    const inside = x >= -0.01 && x <= PANEL + 0.01 && y >= -0.01 && y <= PANEL + 0.01;
    return { x, y, rmsSeconds: rms, rmsMetres: rms / cal.s, inside };
  }

  // ---------- 3. Triage ----------
  // rise: raw ticks for [P1..P4, P5]; 0 = no edge.
  function triage(rise, opts = {}) {
    const wall = rise.slice(0, 4), bump = rise[4];
    const wallHits = wall.filter((r) => r > 0).length;
    const maxSpread = (opts.maxSpreadSeconds || 1e-3) * TICK_HZ;  // 1 ms coincidence gate
    if (bump > 0) {
      const firstWall = wall.filter((r) => r > 0).map((r) => ((r - bump) | 0));
      const bumperFirst = firstWall.length === 0 || Math.min(...firstWall) > 0;
      if (bumperFirst) return { kind: "shield" };
    }
    if (wallHits < 4) return { kind: "incomplete", wallHits };
    const rel = wall.map((r) => ((r - wall[0]) | 0));
    if (Math.max(...rel) - Math.min(...rel) > maxSpread) return { kind: "noise" };
    return { kind: "wall" };
  }

  // ---------- 4. Energy (time-over-threshold) ----------
  function totSum(rise, fall) {
    let s = 0;
    for (let i = 0; i < 4; i++) if (rise[i] && fall[i]) s += Math.max(0, ((fall[i] - rise[i]) | 0) / TICK_HZ);
    return s;
  }
  // Fit ln E = a + b ln(ToT) from ball drops: points [{tot, mass_kg, height_m}]
  function fitEnergy(points) {
    const rows = points.map((p) => [1, Math.log(p.tot)]);
    const rhs = points.map((p) => Math.log(p.mass_kg * 9.81 * p.height_m));
    const [a, b] = leastSquares(rows, rhs);
    return { a, b };
  }
  const energyJ = (fit, tot) => Math.exp(fit.a + fit.b * Math.log(tot));

  // ---------- 5. Breach sizing ----------
  // Subsonic orifice blow-down: dΔP/dt = -(P/V)·Cd·A·sqrt(2ΔP/ρ)
  // => sqrt(ΔP) falls linearly with slope -c/2, where c = (P/V)·Cd·A·sqrt(2/ρ).
  function fitBreach(samples, opts = {}) {
    const V = opts.boxVolume || 0.008, Cd = opts.cd || 0.62, rho = opts.rho || 1.2;
    const pAmb = opts.ambient;          // absolute ambient pressure (Pa)
    const pts = samples
      .map((s) => ({ t: s.t, dp: s.pa - pAmb }))
      .filter((s) => s.dp > 0);
    if (pts.length < 6) throw new Error("not enough decay samples");
    const dp0 = pts[0].dp;
    const use = pts.filter((s) => s.dp > 0.08 * dp0 && s.dp < 0.95 * dp0);
    if (use.length < 4) throw new Error("decay too short to fit");
    const [c0, m] = leastSquares(use.map((s) => [1, s.t]), use.map((s) => Math.sqrt(s.dp)));
    const c = -2 * m;
    const A = (c * V) / ((pAmb + dp0 / 2) * Cd * Math.sqrt(2 / rho));
    const d = Math.sqrt((4 * A) / Math.PI);
    return { c, areaM2: A, diameterMm: d * 1000, intercept: c0, used: use.length };
  }

  // Choked flow to vacuum: P(t) = P0·exp(-t/τ), τ = V / (Cd·A·c*)
  function flightMinutes(diameterMm, opts = {}) {
    const Vm = opts.moduleVolume || 91, Cd = opts.cd || 0.62, frac = opts.lossFraction || 0.10;
    const g = 1.4, R = 287, T = opts.cabinT || 295;
    const cstar = Math.sqrt(g * R * T) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
    const A = Math.PI * (diameterMm / 2000) ** 2;
    const tau = Vm / (Cd * A * cstar);
    return (tau * Math.log(1 / (1 - frac))) / 60;
  }

  const HS = { TICK_HZ, PANEL, SENSORS, calibrate, locate, triage, ticksToRelSeconds, totSum, fitEnergy, energyJ, fitBreach, flightMinutes, leastSquares };
  if (typeof module !== "undefined" && module.exports) module.exports = HS;
  else root.HS = HS;
})(typeof window !== "undefined" ? window : globalThis);
