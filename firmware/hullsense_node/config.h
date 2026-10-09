// HULLSENSE node configuration
// Team BYTEMELATER · SEDHACKS '26
#pragma once

// ---------------- Capture inputs (LM339 outputs, 10k pull-up to 3V3) ----------------
// An LM339 output goes HIGH when the band-passed piezo signal crosses its threshold,
// so the rising edge is the arrival time and the falling edge ends the burst.
//
// The ESP32 has 2 MCPWM groups x 3 capture channels. P1..P3 use group 0, P4 and the
// bumper sensor P5 use group 1. Both capture timers count the 80 MHz APB clock
// (12.5 ns per tick) and are phase-aligned at boot with a GPIO sync pulse.
#define PIN_P1 34   // wall, corner (20, 20) mm
#define PIN_P2 35   // wall, corner (280, 20) mm
#define PIN_P3 32   // wall, corner (20, 280) mm
#define PIN_P4 33   // wall, corner (280, 280) mm
#define PIN_P5 25   // bumper (outer shield), centre of bumper sheet

#define PIN_SYNC 26 // spare GPIO, driven internally to phase-align both capture timers

// ---------------- BMP280 (I2C) ----------------
#define PIN_SDA 21
#define PIN_SCL 22
#define BMP280_ADDR 0x76         // 0x77 on some boards (SDO high)
#define PRESSURE_PERIOD_MS 10    // ~100 samples per second

// ---------------- Event logic ----------------
#define CAPTURE_TICK_HZ 80000000UL // APB clock on the classic ESP32
#define EVENT_WINDOW_US 2000       // collect edges for 2 ms after the first rising edge
#define HOLDOFF_US 30000           // ignore ringing for 30 ms after an event
#define HEARTBEAT_MS 1000

#define SERIAL_BAUD 921600
