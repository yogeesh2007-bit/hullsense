// HULLSENSE hardware configuration: every rig-dependent number lives here.
// The Setup panel can override panelSize_m and sensors_m (saved in localStorage "hullsense.config").
window.HS_CONFIG = {
  panelSize_m: 0.300,                                   // square test wall, side length
  sensors_m: [[0.020, 0.020], [0.280, 0.020], [0.020, 0.280], [0.280, 0.280]],  // P1..P4 (x, y) from top-left
  calPoints_m: [[0.150, 0.150], [0.075, 0.075], [0.225, 0.075], [0.075, 0.225], [0.225, 0.225]],
  bumperZone_m: { y0: 0.0, y1: 0.130 },                 // bumper covers this band of the panel
  coincidenceWindow_us: 1000,                           // wall channels must all fire within this
  serialBaud: 921600,
};
