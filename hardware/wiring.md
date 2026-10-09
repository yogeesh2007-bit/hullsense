# Wiring and assembly

## Mechanical
1. **Wall:** 1 mm aluminium, 300 × 300 mm. It is the lid of an ~8 L plastic box, sealed all round with M-seal.
2. **Sensors:** bond four 27 mm piezo discs (brass side down) under the wall, 20 mm in from each corner, with Fevikwik. Bond the fifth disc on the bumper.
3. **Bumper:** 0.5 mm aluminium, 300 × 150 mm, on M3 standoffs 15 mm above the top half of the wall.
4. **Breach ports:** drill 1, 2 and 3 mm holes in the bare half of the wall. Seal each with kitchen foil and tape; a punch strike through the foil opens a real hole of known size.
5. **Pressure:** BMP280 inside the box; pass the four wires through a hole sealed with M-seal. A tubeless tyre valve in the box wall lets you pressurise to about 2.5 kPa with a cycle pump.

## One channel (repeat ×5)
```
piezo ─┬─ 1 MΩ to GND (bleed)
       └─ 10 kΩ ─┬─ clamp diodes to 3V3 / GND
                 └─ 10 nF ─┬─ 100 kΩ to Vref (1.65 V)
                           └─ LM324 (+), gain ≈ 11: 100 kΩ ∥ 330 pF feedback, 10 kΩ to Vref
LM324 out ─ LM339 (+);  LM339 (−) ← threshold trimpot
LM339 out ─ 10 kΩ pull-up to 3V3 ─ ESP32 capture pin
```
Vref = 3V3 divided by two 10 kΩ resistors, decoupled with 10 µF.

**Power the LM324 and LM339 from the ESP32's 5 V (VIN) pin, not 3V3.** On a 3.3 V supply the LM324 output can only rise to about 1.8 V, which leaves just 0.15 V of swing above the 1.65 V reference. On 5 V it can reach about 3.5 V. This is still safe for the ESP32: the LM339 has open-collector outputs, and its 10 kΩ pull-ups go to **3V3**, so the capture pins never see more than 3.3 V. Put a 100 nF decoupling capacitor on each IC.

Unused sections: on the spare LM324 op-amps, tie (+) to Vref and the output to (−). On the spare LM339 comparators, tie both inputs to GND.

## Pins
| Signal | GPIO |
|---|---|
| P1 / P2 / P3 / P4 (wall) | 34 / 35 / 32 / 33 |
| P5 (bumper) | 25 |
| Timer sync loop-back (leave unconnected) | 26 |
| BMP280 SDA / SCL | 21 / 22 |

## Threshold setting
With the dashboard connected, raise each trimpot until a firm desk thump next to the box does **not** trigger, then confirm a light pen tap on the wall triggers all four wall channels.
