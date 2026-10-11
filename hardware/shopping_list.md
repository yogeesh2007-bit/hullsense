# HULLSENSE shopping list

Checked against `wiring.md` (5 channels, op-amps and comparators on 5 V VIN, pull-ups on 3V3) and `firmware/hullsense_node/config.h`.
"Need" is what the circuit uses; "Buy" includes spares. Prices are in `BOM.csv`; only the ESP32 and piezo prices were checked (Oct 2026), the rest are estimates.

## Main parts
| ✓ | Part | Need | Buy | Ask for / check |
|---|---|---|---|---|
| ☐ | ESP32 DevKit V1, 30-pin, CP2102 | 1 | 1 (2 if budget allows) | ESP-WROOM-32 module, micro-USB. Must have a VIN pin |
| ☐ | Piezo disc 27 mm | 5 | 6 | Bare brass disc **with wire leads**. Not a buzzer in a plastic case, not an "active buzzer" |
| ☐ | LM324 quad op-amp, DIP-14 | 2 | 2 | LM324N |
| ☐ | LM339 quad comparator, DIP-14 | 2 | 2 | LM339N. Substitute: 3× LM393 (dual) |
| ☐ | BMP280 module (GY-BMP280) | 1 | 1 | 6-pin I2C/SPI board, 3.3 V. A BME280 also works |

## Resistors (¼ W carbon film)
| ✓ | Value | Colour bands | Need | Buy | Where it goes |
|---|---|---|---|---|---|
| ☐ | 1 MΩ | brown-black-green | 5 | 8 | Bleed across each piezo |
| ☐ | 100 kΩ | brown-black-yellow | 10 | 14 | Bias to Vref + feedback, 2 per channel |
| ☐ | 10 kΩ | brown-black-orange | 17 | 22 | Series, gain, pull-up (3 per channel) + 2 for the Vref divider |

## Capacitors
| ✓ | Value | Marking | Type | Need | Buy | Where it goes |
|---|---|---|---|---|---|---|
| ☐ | 10 nF | 103 | Ceramic | 5 | 8 | Coupling, 1 per channel |
| ☐ | 330 pF | 331 | Ceramic | 5 | 8 | Across each feedback resistor |
| ☐ | 100 nF | 104 | Ceramic | 4 | 8 | Decoupling, 1 per IC |
| ☐ | 10 µF, 16 V or more | — | Electrolytic | 1 | 3 | Vref |

## Other electronics
| ✓ | Part | Need | Buy | Note |
|---|---|---|---|---|
| ☐ | 1N4148 diode | 10 | 14 | Input clamps, 2 per channel |
| ☐ | 10 kΩ trimpot (preset) | 5 | 7 | Thresholds. Marked 103 |
| ☐ | DIP-14 IC socket | 4 | 4 | So chips can be swapped if one dies |
| ☐ | Perfboard (dotted), ~10 × 15 cm | 1 | 1 | |
| ☐ | Female header strips, 15-pin | 2 | 2 | To plug the ESP32 in, not solder it |
| ☐ | Thin hookup wire, 2–3 colours | — | 3 m | Piezo leads to the board (~40 cm each) |
| ☐ | 4-core wire or ribbon | — | 50 cm | BMP280 out through the box seal |
| ☐ | Micro-USB **data** cable | 1 | 1 | Charge-only cables will not upload firmware |

## Mechanical
| ✓ | Part | Need | Note |
|---|---|---|---|
| ☐ | Aluminium sheet 1 mm, 300 × 300 mm | 1 | Wall. Ask the shop to cut it |
| ☐ | Aluminium sheet 0.5 mm, 300 × 150 mm | 1 | Bumper |
| ☐ | Plastic storage box, ~8 L, open top about 300 × 300 mm | 1 | Take a tape measure: the wall plate must cover the opening |
| ☐ | M3 × 15 mm standoffs + M3 screws + nuts | 4 sets | Brass hex |
| ☐ | Rubber feet | 4 | |
| ☐ | M-seal epoxy putty | 1 | |
| ☐ | Fevikwik | 2 | Bond the piezos |
| ☐ | Tubeless tyre valve stem | 1 | Cycle/bike shop |
| ☐ | Steel balls, ~6–10 mm | a few | Calibration drops (cycle bearing balls) |
| ☐ | Kitchen foil + tape | — | Cover the breach holes |

## Borrow, don't buy
Soldering iron + solder, multimeter, drill with 1, 2 and 3 mm bits (plus 3 mm for the standoffs), cycle pump (to pressurise via the valve).
