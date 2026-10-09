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
Vref = 3V3 divided by two 10 kΩ resistors, decoupled with 10 µF. Power the LM324/LM339 from 3V3 so every output stays within ESP32 limits.

## Pins
| Signal | GPIO |
|---|---|
| P1 / P2 / P3 / P4 (wall) | 34 / 35 / 32 / 33 |
| P5 (bumper) | 25 |
| Timer sync loop-back (leave unconnected) | 26 |
| BMP280 SDA / SCL | 21 / 22 |

## Threshold setting
With the dashboard connected, raise each trimpot until a firm desk thump next to the box does **not** trigger, then confirm a light pen tap on the wall triggers all four wall channels.
