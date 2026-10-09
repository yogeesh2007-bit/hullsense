// HULLSENSE sensor node firmware
// Team BYTEMELATER · SEDHACKS '26 · Rajalakshmi Engineering College
//
// What it does
//   1. Timestamps comparator edges from 5 piezo channels with the ESP32 MCPWM
//      capture hardware (12.5 ns per tick, no fast ADC needed).
//   2. Groups edges that arrive within EVENT_WINDOW_US into one "strike event" and
//      sends it as one JSON line: first rising edge (arrival) and last falling
//      edge (for time-over-threshold) per channel.
//   3. Streams box pressure from a BMP280 at ~100 Hz, so the dashboard can detect
//      and size a breach from the pressure decay.
//   4. Sends a heartbeat with per-channel edge counters, so a dead sensor is
//      reported as a fault instead of being read as "all clear".
//
// Board:   ESP32 DevKit V1 (classic ESP32, 30-pin)
// Core:    Arduino-ESP32 3.x (built on ESP-IDF 5.x, which provides driver/mcpwm_cap.h)
// Library: Adafruit BMP280 (install via Library Manager)
//
// Serial protocol (921600 baud, one JSON object per line)
//   {"t":"evt","id":12,"us":123456,"rise":[r1,r2,r3,r4,r5],"fall":[f1,...],"n":[e1,...]}
//       rise/fall are capture-timer ticks (uint32, 80 MHz); 0 means "no edge".
//   {"t":"p","us":123456,"pa":101412.37}
//   {"t":"hb","us":...,"edges":[...],"sync":1,"bmp":1}
// Commands from the dashboard: "SYNC\n" re-aligns the timers, "PING\n" -> {"t":"pong"}

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_BMP280.h>
#include "driver/mcpwm_cap.h"
#include "driver/mcpwm_sync.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "config.h"

static const int NCH = 5;
static const int CAP_PINS[NCH] = {PIN_P1, PIN_P2, PIN_P3, PIN_P4, PIN_P5};
static const int CAP_GROUP[NCH] = {0, 0, 0, 1, 1};

static mcpwm_cap_timer_handle_t capTimer[2] = {nullptr, nullptr};
static mcpwm_cap_channel_handle_t capChan[NCH] = {nullptr};
static mcpwm_sync_handle_t syncSrc[2] = {nullptr, nullptr};
static bool syncOk = false;

// ---- shared between ISR and loop ----
static portMUX_TYPE evMux = portMUX_INITIALIZER_UNLOCKED;
static volatile uint32_t evRise[NCH];
static volatile uint32_t evFall[NCH];
static volatile uint16_t evEdges[NCH];
static volatile bool evActive = false;
static volatile int64_t evStartUs = 0;
static volatile int64_t holdoffUntilUs = 0;
static volatile uint32_t totalEdges[NCH];

static Adafruit_BMP280 bmp;
static bool bmpOk = false;
static uint32_t eventId = 0;

// ---------------------------------------------------------------------------
// Capture ISR: keep the FIRST rising edge (arrival) and the LAST falling edge
// (end of the burst) for each channel during the event window.
// ---------------------------------------------------------------------------
static bool IRAM_ATTR onCapture(mcpwm_cap_channel_handle_t chan, const mcpwm_capture_event_data_t *ed, void *user) {
  const int ch = (int)(intptr_t)user;
  const int64_t now = esp_timer_get_time();
  portENTER_CRITICAL_ISR(&evMux);
  totalEdges[ch]++;
  if (now >= holdoffUntilUs) {
    if (ed->cap_edge == MCPWM_CAP_EDGE_POS) {
      if (!evActive) {               // first edge of a new event
        evActive = true;
        evStartUs = now;
        for (int i = 0; i < NCH; i++) { evRise[i] = 0; evFall[i] = 0; evEdges[i] = 0; }
      }
      if (evRise[ch] == 0) evRise[ch] = ed->cap_value ? ed->cap_value : 1;
    } else if (evActive) {
      evFall[ch] = ed->cap_value ? ed->cap_value : 1;
    }
    if (evActive) evEdges[ch]++;
  }
  portEXIT_CRITICAL_ISR(&evMux);
  return false;  // no task to wake
}

// ---------------------------------------------------------------------------
// Phase-align both capture timers: one GPIO, looped back into both MCPWM groups.
// If anything here fails, the dashboard's 5-tap calibration still absorbs the
// constant offset between the two groups (both count the same APB clock).
// ---------------------------------------------------------------------------
static void pulseSync() {
  gpio_set_level((gpio_num_t)PIN_SYNC, 1);
  delayMicroseconds(5);
  gpio_set_level((gpio_num_t)PIN_SYNC, 0);
}

static void setupSync() {
  esp_err_t err = ESP_OK;
  for (int g = 0; g < 2 && err == ESP_OK; g++) {
    mcpwm_gpio_sync_src_config_t sc = {};
    sc.group_id = g;
    sc.gpio_num = PIN_SYNC;
    sc.flags.io_loop_back = true;   // we drive this pin ourselves
    sc.flags.pull_down = true;
    err = mcpwm_new_gpio_sync_src(&sc, &syncSrc[g]);
    if (err != ESP_OK) break;
    mcpwm_capture_timer_sync_phase_config_t ph = {};
    ph.sync_src = syncSrc[g];
    ph.count_value = 0;
    ph.direction = MCPWM_TIMER_DIRECTION_UP;
    err = mcpwm_capture_timer_set_phase_on_sync(capTimer[g], &ph);
  }
  if (err == ESP_OK) {
    gpio_set_direction((gpio_num_t)PIN_SYNC, GPIO_MODE_INPUT_OUTPUT);
    gpio_set_level((gpio_num_t)PIN_SYNC, 0);
    pulseSync();
    syncOk = true;
  } else {
    Serial.printf("{\"t\":\"warn\",\"msg\":\"timer sync unavailable (%s); calibration will absorb the offset\"}\n", esp_err_to_name(err));
  }
}

static void setupCapture() {
  for (int g = 0; g < 2; g++) {
    mcpwm_capture_timer_config_t tc = {};
    tc.group_id = g;
    tc.clk_src = MCPWM_CAPTURE_CLK_SRC_DEFAULT;  // APB 80 MHz on ESP32
    ESP_ERROR_CHECK(mcpwm_new_capture_timer(&tc, &capTimer[g]));
  }
  for (int ch = 0; ch < NCH; ch++) {
    mcpwm_capture_channel_config_t cc = {};
    cc.gpio_num = CAP_PINS[ch];
    cc.prescale = 1;
    cc.flags.pos_edge = true;
    cc.flags.neg_edge = true;
    cc.flags.pull_up = false;   // external 10k pull-up on each LM339 output
    ESP_ERROR_CHECK(mcpwm_new_capture_channel(capTimer[CAP_GROUP[ch]], &cc, &capChan[ch]));
    mcpwm_capture_event_callbacks_t cbs = {};
    cbs.on_cap = onCapture;
    ESP_ERROR_CHECK(mcpwm_capture_channel_register_event_callbacks(capChan[ch], &cbs, (void *)(intptr_t)ch));
    ESP_ERROR_CHECK(mcpwm_capture_channel_enable(capChan[ch]));
  }
  for (int g = 0; g < 2; g++) {
    ESP_ERROR_CHECK(mcpwm_capture_timer_enable(capTimer[g]));
    ESP_ERROR_CHECK(mcpwm_capture_timer_start(capTimer[g]));
  }
  setupSync();
}

static void setupPressure() {
  Wire.begin(PIN_SDA, PIN_SCL, 400000);
  bmpOk = bmp.begin(BMP280_ADDR);
  if (!bmpOk) {
    Serial.println("{\"t\":\"warn\",\"msg\":\"BMP280 not found\"}");
    return;
  }
  // Fast, unfiltered pressure: a breach drains the box in 1 to 11 s, so speed beats smoothing.
  bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                  Adafruit_BMP280::SAMPLING_X1,    // temperature
                  Adafruit_BMP280::SAMPLING_X2,    // pressure
                  Adafruit_BMP280::FILTER_OFF,
                  Adafruit_BMP280::STANDBY_MS_1);
}

static void emitEventIfReady() {
  if (!evActive) return;
  const int64_t now = esp_timer_get_time();
  if (now - evStartUs < EVENT_WINDOW_US) return;

  uint32_t rise[NCH], fall[NCH];
  uint16_t edges[NCH];
  int64_t startUs;
  portENTER_CRITICAL(&evMux);
  for (int i = 0; i < NCH; i++) { rise[i] = evRise[i]; fall[i] = evFall[i]; edges[i] = evEdges[i]; }
  startUs = evStartUs;
  evActive = false;
  holdoffUntilUs = now + HOLDOFF_US;
  portEXIT_CRITICAL(&evMux);

  eventId++;
  Serial.printf("{\"t\":\"evt\",\"id\":%lu,\"us\":%lld,\"rise\":[%lu,%lu,%lu,%lu,%lu],\"fall\":[%lu,%lu,%lu,%lu,%lu],\"n\":[%u,%u,%u,%u,%u]}\n",
                (unsigned long)eventId, (long long)startUs,
                (unsigned long)rise[0], (unsigned long)rise[1], (unsigned long)rise[2], (unsigned long)rise[3], (unsigned long)rise[4],
                (unsigned long)fall[0], (unsigned long)fall[1], (unsigned long)fall[2], (unsigned long)fall[3], (unsigned long)fall[4],
                edges[0], edges[1], edges[2], edges[3], edges[4]);
}

static void handleCommands() {
  static char buf[32];
  static uint8_t len = 0;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      buf[len] = 0;
      if (!strcmp(buf, "SYNC") && syncOk) { pulseSync(); Serial.println("{\"t\":\"ack\",\"cmd\":\"SYNC\"}"); }
      else if (!strcmp(buf, "PING")) Serial.println("{\"t\":\"pong\"}");
      len = 0;
    } else if (len < sizeof(buf) - 1) {
      buf[len++] = c;
    }
  }
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(200);
  setupCapture();
  setupPressure();
  Serial.printf("{\"t\":\"hello\",\"fw\":\"hullsense-node 1.0\",\"tick_hz\":%lu,\"sync\":%d,\"bmp\":%d}\n",
                (unsigned long)CAPTURE_TICK_HZ, syncOk ? 1 : 0, bmpOk ? 1 : 0);
}

void loop() {
  static uint32_t lastP = 0, lastHb = 0;
  const uint32_t ms = millis();

  emitEventIfReady();
  handleCommands();

  if (bmpOk && ms - lastP >= PRESSURE_PERIOD_MS) {
    lastP = ms;
    const float pa = bmp.readPressure();
    Serial.printf("{\"t\":\"p\",\"us\":%lld,\"pa\":%.2f}\n", (long long)esp_timer_get_time(), pa);
  }

  if (ms - lastHb >= HEARTBEAT_MS) {
    lastHb = ms;
    uint32_t e[NCH];
    portENTER_CRITICAL(&evMux);
    for (int i = 0; i < NCH; i++) e[i] = totalEdges[i];
    portEXIT_CRITICAL(&evMux);
    Serial.printf("{\"t\":\"hb\",\"us\":%lld,\"edges\":[%lu,%lu,%lu,%lu,%lu],\"sync\":%d,\"bmp\":%d}\n",
                  (long long)esp_timer_get_time(),
                  (unsigned long)e[0], (unsigned long)e[1], (unsigned long)e[2], (unsigned long)e[3], (unsigned long)e[4],
                  syncOk ? 1 : 0, bmpOk ? 1 : 0);
  }
}
