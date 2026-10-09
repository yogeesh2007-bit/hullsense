"""HULLSENSE test rig: parametric CAD model (CadQuery).

Builds the bench rig described in hardware/wiring.md and exports:
  hullsense_rig.step            full assembly, coloured, for any CAD tool (Fusion, SolidWorks, FreeCAD, Onshape)
  hullsense_rig.glb             same assembly for the web viewer (docs/cad/)
  hullsense_rig_exploded.glb    exploded view for the web viewer
  stl/<part>.stl                one file per fabricated part (for laser-cut / 3D-print references)

Run:  pip install cadquery && python3 hardware/cad/hullsense_rig.py
All dimensions in millimetres. Team BYTEMELATER · SEDHACKS '26.
"""
import os
import cadquery as cq

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- parameters
PANEL = 300.0          # wall plate is PANEL x PANEL
WALL_T = 1.0           # 1 mm aluminium pressure wall
BUMPER_T = 0.5         # 0.5 mm aluminium Whipple bumper
BUMPER_Y0 = 150.0      # bumper covers y = 150..300 (top half of the wall)
STANDOFF_H = 15.0      # bumper gap above the wall
BOX_H = 95.0           # sealed box: 300 x 300 x 95 outer, 3 mm walls -> ~7.9 L inside
BOX_T = 3.0
PIEZO_D, PIEZO_T = 27.0, 0.3      # brass disc
CERAMIC_D, CERAMIC_T = 20.0, 0.2  # piezo ceramic layer
SENSORS = [(20, 20), (280, 20), (20, 280), (280, 280)]   # P1..P4 centres (match solver.js)
P5 = (150, 225)                                           # bumper sensor
BREACH_PORTS = [(105, 75, 1.0), (150, 75, 2.0), (195, 75, 3.0)]  # x, y, diameter
STANDOFFS = [(12, 162), (288, 162), (12, 288), (288, 288)]
BASE = (500.0, 340.0, 6.0)        # plywood/acrylic base board
BASE_ORIGIN = (-20.0, -20.0)

EXPLODE = 40.0          # mm per layer in the exploded view
Z_WALL = BOX_H                    # underside of the wall plate sits on the box rim


def inner_volume_litres():
    return (PANEL - 2 * BOX_T) ** 2 * (BOX_H - BOX_T) / 1e6


# ---------------------------------------------------------------- parts
def base_board():
    x, y, t = BASE
    b = cq.Workplane("XY").box(x, y, t, centered=False).translate((BASE_ORIGIN[0], BASE_ORIGIN[1], -t))
    return b.edges("|Z").fillet(6)


def rubber_feet():
    x, y, t = BASE
    pts = [(BASE_ORIGIN[0] + 15, BASE_ORIGIN[1] + 15), (BASE_ORIGIN[0] + x - 15, BASE_ORIGIN[1] + 15),
           (BASE_ORIGIN[0] + 15, BASE_ORIGIN[1] + y - 15), (BASE_ORIGIN[0] + x - 15, BASE_ORIGIN[1] + y - 15)]
    return cq.Workplane("XY").pushPoints(pts).circle(8).extrude(-5).translate((0, 0, -t))


def sealed_box():
    outer = cq.Workplane("XY").box(PANEL, PANEL, BOX_H, centered=False).edges("|Z").fillet(8)
    inner = (cq.Workplane("XY").box(PANEL - 2 * BOX_T, PANEL - 2 * BOX_T, BOX_H, centered=False)
             .edges("|Z").fillet(5).translate((BOX_T, BOX_T, BOX_T)))
    box = outer.cut(inner)
    # valve hole (x = PANEL face) and sensor-wire gland hole (y = 0 face)
    box = box.cut(cq.Workplane("YZ").center(150, 40).circle(4.2).extrude(PANEL + 5))
    box = box.cut(cq.Workplane("XZ").center(260, 60).circle(3).extrude(-10))
    return box


def seal_bead():
    """M-seal bead around the rim, where the wall plate meets the box."""
    ring = (cq.Workplane("XY").rect(PANEL + 4, PANEL + 4).extrude(3)
            .cut(cq.Workplane("XY").rect(PANEL - 1, PANEL - 1).extrude(3)))
    return ring.edges().fillet(1.2).translate((PANEL / 2, PANEL / 2, Z_WALL - 2))


def wall_plate():
    p = cq.Workplane("XY").box(PANEL, PANEL, WALL_T, centered=False).translate((0, 0, Z_WALL))
    for x, y, d in BREACH_PORTS:
        p = p.cut(cq.Workplane("XY").center(x, y).circle(d / 2).extrude(10).translate((0, 0, Z_WALL - 2)))
    for x, y in STANDOFFS:
        p = p.cut(cq.Workplane("XY").center(x, y).circle(1.6).extrude(10).translate((0, 0, Z_WALL - 2)))
    return p


def foil_patches():
    w = cq.Workplane("XY")
    for x, y, d in BREACH_PORTS:
        w = w.union(cq.Workplane("XY").center(x, y).rect(16, 16).extrude(0.15).translate((0, 0, Z_WALL + WALL_T)))
    return w


def bumper_plate():
    p = (cq.Workplane("XY").box(PANEL, PANEL - BUMPER_Y0, BUMPER_T, centered=False)
         .translate((0, BUMPER_Y0, Z_WALL + WALL_T + STANDOFF_H)))
    for x, y in STANDOFFS:
        p = p.cut(cq.Workplane("XY").center(x, y).circle(1.6).extrude(30).translate((0, 0, Z_WALL)))
    return p


def standoffs():
    w = None
    for x, y in STANDOFFS:
        s = (cq.Workplane("XY").polygon(6, 5.5 / 0.866).extrude(STANDOFF_H)
             .faces(">Z").workplane().hole(2.5).translate((x, y, Z_WALL + WALL_T)))
        w = s if w is None else w.union(s)
    return w


def screw_heads():
    """M3 pan-head screws on top of the bumper."""
    w = None
    for x, y in STANDOFFS:
        head = cq.Workplane("XY").circle(2.8).extrude(1.8).edges(">Z").fillet(0.8) \
            .translate((x, y, Z_WALL + WALL_T + STANDOFF_H + BUMPER_T))
        w = head if w is None else w.union(head)
    return w


def wall_nuts():
    """M3 nuts under the wall plate (sealed over with M-seal)."""
    w = None
    for x, y in STANDOFFS:
        nut = cq.Workplane("XY").polygon(6, 5.5 / 0.866).extrude(2.4).translate((x, y, Z_WALL - 2.4))
        w = nut if w is None else w.union(nut)
    return w


def piezo(x, y, z_brass_top, flip=False):
    """27 mm piezo disc: brass base + ceramic layer. flip=True hangs it under a plate."""
    if not flip:
        brass = cq.Workplane("XY").circle(PIEZO_D / 2).extrude(PIEZO_T).translate((x, y, z_brass_top - PIEZO_T))
        cer = cq.Workplane("XY").circle(CERAMIC_D / 2).extrude(CERAMIC_T).translate((x, y, z_brass_top))
    else:
        brass = cq.Workplane("XY").circle(PIEZO_D / 2).extrude(-PIEZO_T).translate((x, y, z_brass_top))
        cer = cq.Workplane("XY").circle(CERAMIC_D / 2).extrude(-CERAMIC_T).translate((x, y, z_brass_top - PIEZO_T))
    return brass, cer


def wall_piezos():
    brass = cer = None
    for x, y in SENSORS:
        b, c = piezo(x, y, Z_WALL, flip=True)           # bonded brass-side up to the underside of the wall
        brass = b if brass is None else brass.union(b)
        cer = c if cer is None else cer.union(c)
    b, c = piezo(P5[0], P5[1], Z_WALL + WALL_T + STANDOFF_H, flip=True)   # under the bumper
    return brass.union(b), cer.union(c)


def bmp280():
    pcb = cq.Workplane("XY").box(15, 11.5, 1.6, centered=False).translate((142.5, 144, BOX_T + 8))
    sensor = cq.Workplane("XY").box(2.5, 2.5, 0.95, centered=False).translate((148.7, 148.5, BOX_T + 9.6))
    post = cq.Workplane("XY").box(10, 6, 8, centered=False).translate((145, 147, BOX_T))
    return pcb, sensor.union(post)


def valve():
    stem = cq.Workplane("YZ").center(150, 40).circle(4).extrude(32).translate((PANEL - 10, 0, 0))
    nut = cq.Workplane("YZ").center(150, 40).polygon(6, 14).extrude(4).translate((PANEL, 0, 0))
    cap = cq.Workplane("YZ").center(150, 40).circle(4.6).extrude(10).translate((PANEL + 22, 0, 0)) \
        .faces(">X").edges().fillet(1.5)
    return stem.union(nut), cap


def electronics():
    """Perfboard with 5 analog channels + ESP32 dev board, on the base next to the box."""
    x0, y0 = 330.0, 30.0
    perf = cq.Workplane("XY").box(90, 70, 1.6, centered=False).translate((x0, y0, 6))
    spacers = cq.Workplane("XY").pushPoints([(x0 + 4, y0 + 4), (x0 + 86, y0 + 4), (x0 + 4, y0 + 66), (x0 + 86, y0 + 66)]) \
        .circle(2.5).extrude(6)
    chips = None
    for i in range(4):                                   # 2 x LM324, 2 x LM339 (DIP-14)
        c = cq.Workplane("XY").box(19, 6.4, 3.3, centered=False).translate((x0 + 8 + (i % 2) * 40, y0 + 12 + (i // 2) * 22, 7.6))
        chips = c if chips is None else chips.union(c)
    pots = None
    for i in range(5):                                   # threshold trimpots
        p = cq.Workplane("XY").box(9.5, 9.5, 5, centered=False).translate((x0 + 6 + i * 16, y0 + 54, 7.6))
        pots = p if pots is None else pots.union(p)
    knobs = cq.Workplane("XY").pushPoints([(x0 + 10.75 + i * 16, y0 + 58.75) for i in range(5)]).circle(2.5).extrude(1) \
        .translate((0, 0, 12.6))
    ex, ey = 330.0, 150.0
    esp_pcb = cq.Workplane("XY").box(55, 28, 1.6, centered=False).translate((ex, ey, 6 + 8))
    esp_posts = cq.Workplane("XY").pushPoints([(ex + 3, ey + 3), (ex + 52, ey + 3), (ex + 3, ey + 25), (ex + 52, ey + 25)]) \
        .circle(2).extrude(8).translate((0, 0, 6))
    can = cq.Workplane("XY").box(16, 18, 3, centered=False).translate((ex + 34, ey + 5, 6 + 9.6))
    usb = cq.Workplane("XY").box(6, 8, 3, centered=False).translate((ex - 1, ey + 10, 6 + 9.6))
    headers = cq.Workplane("XY").box(48, 2.5, 8.5, centered=False).translate((ex + 4, ey - 0.5, 6)) \
        .union(cq.Workplane("XY").box(48, 2.5, 8.5, centered=False).translate((ex + 4, ey + 26, 6)))
    return {
        "perfboard": (perf, (0.80, 0.70, 0.45)),
        "spacers": (spacers.translate((0, 0, 0)), (0.85, 0.85, 0.85)),
        "ic_dip14": (chips, (0.10, 0.10, 0.12)),
        "trimpot": (pots, (0.15, 0.35, 0.85)),
        "trimpot_screw": (knobs, (0.95, 0.95, 0.95)),
        "esp32_board": (esp_pcb, (0.08, 0.08, 0.10)),
        "esp32_posts": (esp_posts, (0.80, 0.80, 0.80)),
        "esp32_module": (can, (0.75, 0.76, 0.78)),
        "usb_port": (usb, (0.70, 0.70, 0.72)),
        "pin_headers": (headers, (0.15, 0.15, 0.15)),
    }


# ---------------------------------------------------------------- assembly
ALU = (0.78, 0.80, 0.83)
BUMPER_C = (0.62, 0.55, 0.90)       # bumper tinted so it reads separately in renders
BRASS = (0.83, 0.66, 0.28)
CERAMIC = (0.96, 0.95, 0.90)


def build(explode=0.0):
    """explode > 0 lifts each layer apart (mm per layer) for exploded renders."""
    e = explode
    a = cq.Assembly(name="hullsense_rig")

    def add(name, shape, rgb, dz=0.0, alpha=1.0):
        a.add(shape.translate((0, 0, dz)) if dz else shape, name=name, color=cq.Color(*rgb, alpha))

    add("base_board", base_board(), (0.86, 0.74, 0.56))
    add("rubber_feet", rubber_feet(), (0.12, 0.12, 0.12))
    add("sealed_box_8L", sealed_box(), (0.90, 0.93, 0.97), alpha=0.55)
    pcb, sensor = bmp280()
    add("bmp280_pcb", pcb, (0.45, 0.25, 0.65))
    add("bmp280_sensor", sensor, (0.80, 0.80, 0.82))
    stem, cap = valve()
    add("valve_stem", stem, (0.70, 0.70, 0.72))
    add("valve_cap", cap, (0.10, 0.10, 0.10))
    add("seal_bead_mseal", seal_bead(), (0.55, 0.55, 0.50), dz=e * 0.5)
    brass, cer = wall_piezos()
    # wall piezos travel with the wall; P5 travels with the bumper (split for explode)
    wall_brass = brass.intersect(cq.Workplane("XY").box(PANEL, PANEL, 20, centered=False).translate((0, 0, Z_WALL - 10)))
    wall_cer = cer.intersect(cq.Workplane("XY").box(PANEL, PANEL, 20, centered=False).translate((0, 0, Z_WALL - 10)))
    b5_brass = brass.cut(cq.Workplane("XY").box(PANEL, PANEL, 20, centered=False).translate((0, 0, Z_WALL - 10)))
    b5_cer = cer.cut(cq.Workplane("XY").box(PANEL, PANEL, 20, centered=False).translate((0, 0, Z_WALL - 10)))
    add("piezo_P1_P4_brass", wall_brass, BRASS, dz=e * 1.0)
    add("piezo_P1_P4_ceramic", wall_cer, CERAMIC, dz=e * 1.0)
    add("m3_nuts", wall_nuts(), (0.35, 0.35, 0.38), dz=e * 1.0)
    add("wall_plate_1mm_Al", wall_plate(), ALU, dz=e * 2.0)
    add("foil_patches", foil_patches(), (0.92, 0.92, 0.95), dz=e * 2.0)
    add("standoffs_M3x15", standoffs(), (0.85, 0.75, 0.40), dz=e * 3.0)
    add("piezo_P5_brass", b5_brass, BRASS, dz=e * 3.8)
    add("piezo_P5_ceramic", b5_cer, CERAMIC, dz=e * 3.8)
    add("bumper_0p5mm_Al", bumper_plate(), BUMPER_C, dz=e * 4.5)
    add("m3_screws", screw_heads(), (0.35, 0.35, 0.38), dz=e * 5.2)
    for name, (shape, rgb) in electronics().items():
        add(name, shape, rgb)
    return a


def export_all():
    os.makedirs(os.path.join(HERE, "stl"), exist_ok=True)
    rig = build()
    rig.export(os.path.join(HERE, "hullsense_rig.step"))
    cq.occ_impl.exporters.assembly.exportGLTF(rig, os.path.join(HERE, "hullsense_rig.glb"), binary=True, tolerance=0.05)
    cq.occ_impl.exporters.assembly.exportGLTF(build(explode=EXPLODE), os.path.join(HERE, "hullsense_rig_exploded.glb"),
                                              binary=True, tolerance=0.05)
    parts = {"wall_plate_1mm_Al": wall_plate(), "bumper_0p5mm_Al": bumper_plate(), "sealed_box_8L": sealed_box(),
             "standoff_M3x15": standoffs(), "base_board": base_board()}
    for n, s in parts.items():
        cq.exporters.export(s, os.path.join(HERE, "stl", n + ".stl"), tolerance=0.05)
    print(f"box inner volume: {inner_volume_litres():.2f} L")
    print("exported STEP, GLB (assembled + exploded) and", len(parts), "STL parts")


if __name__ == "__main__":
    export_all()
