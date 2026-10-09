# Cirkit Designer prompt: HULLSENSE sensor node

Paste the block below into Cirkit Designer's AI prompt. It matches `hardware/wiring.md` and the firmware pin map in `firmware/hullsense_node/config.h`.

```
Design the full wiring diagram for "HULLSENSE", an ESP32 impact-localisation and pressure-monitoring node. Use these exact parts, nets and pins.

PARTS
- 1x ESP32 DevKit V1 (30-pin, ESP-WROOM-32), powered from USB
- 5x piezo disc 27 mm (2-wire): P1, P2, P3, P4 (on the wall) and P5 (on the bumper)
- 2x LM324 quad op-amp (U1, U2), DIP-14
- 2x LM339 quad comparator (U3, U4), DIP-14
- 1x BMP280 pressure sensor module (GY-BMP280, I2C)
- 5x 10 kΩ trimpot (RV1-RV5) for the comparator thresholds
- Per channel (x5): 1 MΩ, 10 kΩ, 100 kΩ, 100 kΩ, 10 kΩ, 10 kΩ resistors; 10 nF and 330 pF capacitors; 2x 1N4148 diodes
- Reference: 2x 10 kΩ divider + 10 µF capacitor
- Decoupling: 4x 100 nF (one per IC)

POWER NETS
- 5V net = ESP32 VIN pin (5 V from USB). It powers U1-U4: LM324 pin 4 = VCC, pin 11 = GND; LM339 pin 3 = VCC, pin 12 = GND.
- 3V3 net = ESP32 3V3 pin. It powers the BMP280, the comparator pull-ups, the clamp diodes and the trimpots.
- VREF net = 1.65 V: a 10 kΩ from 3V3 to VREF, a 10 kΩ from VREF to GND, and 10 µF from VREF to GND.
- All grounds are common.

ONE ANALOG CHANNEL (draw 5 identical copies, CH1-CH5)
1. Piezo (+) goes to node IN; piezo (-) to GND. Add 1 MΩ from IN to GND (bleed).
2. 10 kΩ series resistor from IN to node CLAMP. Add a 1N4148 from CLAMP to 3V3 (cathode at 3V3) and a 1N4148 from GND to CLAMP (cathode at CLAMP).
3. A 10 nF coupling capacitor from CLAMP to node B. Add 100 kΩ from node B to VREF.
4. Op-amp, non-inverting amplifier with gain about 11: (+) input = node B. Feedback from the output to the (-) input is 100 kΩ in parallel with 330 pF. Add 10 kΩ from the (-) input to VREF.
5. Comparator: (+) input = op-amp output. (-) input = trimpot wiper (trimpot ends to 3V3 and GND).
6. The comparator output is open-collector: add a 10 kΩ pull-up to 3V3 (NOT 5V). This node is the channel output to the ESP32.

CHANNEL ALLOCATION
- Op-amps: U1A -> CH1, U1B -> CH2, U1C -> CH3, U1D -> CH4, U2A -> CH5. On the unused U2B-U2D, tie (+) to VREF and the output to (-).
- Comparators: U3A -> CH1, U3B -> CH2, U3C -> CH3, U3D -> CH4, U4A -> CH5. On the unused U4B-U4D, tie both inputs to GND.

ESP32 CONNECTIONS
- CH1 (P1, wall corner 20,20 mm) -> GPIO34
- CH2 (P2, wall corner 280,20 mm) -> GPIO35
- CH3 (P3, wall corner 20,280 mm) -> GPIO32
- CH4 (P4, wall corner 280,280 mm) -> GPIO33
- CH5 (P5, bumper) -> GPIO25
- GPIO26 = timer sync loop-back used inside the firmware: leave it unconnected.
- BMP280: VCC -> 3V3, GND -> GND, SCL -> GPIO22, SDA -> GPIO21, CSB -> 3V3 (selects I2C), SDO -> GND (address 0x76).

LAYOUT AND LABELS
- Place the ESP32 in the centre, the five channels in a column on the left, and the BMP280 on the right.
- Label every net: 5V, 3V3, VREF, GND, CH1_OUT ... CH5_OUT, SDA, SCL.
- Label each piezo P1-P5 and each trimpot "threshold CHn".
- Colour the wires: red 5V, orange 3V3, black GND, blue signals, green I2C.
```

## If the tool is missing a part

- **No LM339:** use LM393 (dual comparator, same open-collector output). You will need 3 chips for 5 channels.
- **No piezo disc:** use "piezo buzzer (passive)" or a generic 2-pin sensor, and label it "27 mm piezo disc".
- **Circuit too large for one prompt:** first ask for one channel plus the ESP32 and the BMP280, then say "duplicate the channel four more times to GPIO35, 32, 33 and 25".
