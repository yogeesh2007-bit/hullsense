"""2D dimensioned drawing of the HULLSENSE test rig (A3, PDF + PNG).

Reads every dimension from hullsense_rig.py so the drawing and the 3D model never disagree.
Run:  python3 hardware/cad/drawing.py
"""
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Circle, FancyBboxPatch
import hullsense_rig as R

HERE = os.path.dirname(os.path.abspath(__file__))
INK, DIM, SENS, PORT = "#111827", "#1D4ED8", "#B45309", "#DC2626"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9})


def dim_h(ax, x0, x1, y, text, off=0, col=DIM):
    ax.annotate("", (x0, y), (x1, y), arrowprops=dict(arrowstyle="<->", color=col, lw=0.9, shrinkA=0, shrinkB=0))
    ax.text((x0 + x1) / 2, y + 3 + off, text, ha="center", va="bottom", color=col, fontsize=8.5)


def dim_v(ax, x, y0, y1, text, col=DIM, side=1):
    ax.annotate("", (x, y0), (x, y1), arrowprops=dict(arrowstyle="<->", color=col, lw=0.9, shrinkA=0, shrinkB=0))
    ax.text(x + 3 * side, (y0 + y1) / 2, text, ha="left" if side > 0 else "right", va="center", color=col, fontsize=8.5, rotation=0)


def ext(ax, x0, y0, x1, y1):
    ax.plot([x0, x1], [y0, y1], color=DIM, lw=0.5)


fig = plt.figure(figsize=(16.54, 11.69))   # A3 landscape
fig.patch.set_facecolor("white")
fig.add_artist(Rectangle((0.015, 0.015), 0.97, 0.97, transform=fig.transFigure, fill=False, lw=1.6, color=INK))

# ------------------------------------------------------------------ TOP VIEW (wall plate layout)
ax = fig.add_axes([0.04, 0.24, 0.47, 0.70]); ax.set_aspect("equal"); ax.axis("off")
P = R.PANEL
ax.add_patch(Rectangle((0, 0), P, P, fill=True, fc="#F3F4F6", ec=INK, lw=1.4))
ax.add_patch(Rectangle((0, R.BUMPER_Y0), P, P - R.BUMPER_Y0, fill=True, fc="#EDE9FE", alpha=0.55, ec="#6D28D9", lw=1.1, ls="--"))
ax.plot([-42, P + 8], [225, 225], color=INK, lw=0.8, ls="-.")
ax.text(-44, 225, "A", ha="right", va="center", weight="bold"); ax.text(P + 10, 225, "A", ha="left", va="center", weight="bold")
ax.text(P / 2, 290, "BUMPER ABOVE (0.5 mm Al, 15 mm gap)", ha="center", color="#6D28D9", fontsize=8.5)
ax.text(P / 2, 135, "BARE WALL (breach zone)", ha="center", color="#6B7280", fontsize=8.5)
for i, (x, y) in enumerate(R.SENSORS):
    ax.add_patch(Circle((x, y), R.PIEZO_D / 2, fc="#FDE68A", ec=SENS, lw=1.0, ls="--"))
    ax.plot(x, y, "+", color=SENS, ms=8)
    ax.text(x + 22, y - 3, f"P{i+1}", ha="center", color=SENS, fontsize=9, weight="bold")
x5, y5 = R.P5
ax.add_patch(Circle((x5, y5), R.PIEZO_D / 2, fc="#FDE68A", ec=SENS, lw=1.0, ls=":"))
ax.text(x5, y5 - 22, "P5 (under bumper)", ha="center", color=SENS, fontsize=8.5, weight="bold")
for x, y, d in R.BREACH_PORTS:
    ax.add_patch(Rectangle((x - 8, y - 8), 16, 16, fc="#FFFFFF", ec="#9CA3AF", lw=0.7))
    ax.add_patch(Circle((x, y), max(d / 2, 1.2), fc=PORT, ec=PORT))
    ax.text(x, y - 16, f"Ø{d:g}", ha="center", color=PORT, fontsize=8.5, weight="bold")
for x, y in R.STANDOFFS:
    ax.add_patch(Circle((x, y), 1.6, fc="white", ec=INK, lw=0.8))
    ax.plot([x - 4, x + 4], [y, y], color=INK, lw=0.4); ax.plot([x, x], [y - 4, y + 4], color=INK, lw=0.4)
# dimensions
dim_h(ax, 0, P, -28, "300")
ext(ax, 0, -2, 0, -32); ext(ax, P, -2, P, -32)
dim_v(ax, P + 22, 0, P, "300")
ext(ax, P + 2, 0, P + 26, 0); ext(ax, P + 2, P, P + 26, P)
dim_h(ax, 0, 20, -12, "20"); dim_v(ax, -14, 0, 20, "20", side=-1)
dim_h(ax, 105, 150, 50, "45"); dim_h(ax, 150, 195, 50, "45")
dim_v(ax, 225, 0, 75, "75")
ext(ax, 195, 75, 229, 75)
dim_v(ax, -14, R.BUMPER_Y0, P, "150", side=-1)
dim_h(ax, 0, 12, 175, "12", off=-1)
ax.text(P / 2, P + 30, "TOP VIEW  ·  WALL PLATE LAYOUT  (not to scale; dimensions govern)", ha="center", weight="bold", fontsize=11, color=INK)
ax.set_xlim(-60, P + 70); ax.set_ylim(-55, P + 45)

# ------------------------------------------------------------------ FRONT SECTION
bx = fig.add_axes([0.54, 0.47, 0.43, 0.47]); bx.set_aspect("equal"); bx.axis("off")
H, T = R.BOX_H, R.BOX_T
bx.add_patch(Rectangle((0, 0), P, H, fc="#E0ECF8", ec=INK, lw=1.2))
bx.add_patch(Rectangle((T, T), P - 2 * T, H - T, fc="white", ec=INK, lw=0.8))
bx.add_patch(Rectangle((0, H), P, R.WALL_T * 3, fc="#9CA3AF", ec=INK, lw=0.8))     # wall (thickness exaggerated x3)
zb = H + R.WALL_T * 3 + R.STANDOFF_H
bx.add_patch(Rectangle((0, zb), P, R.BUMPER_T * 4, fc="#A78BFA", ec="#6D28D9", lw=0.8))
for x in (12, P - 12):
    bx.add_patch(Rectangle((x - 2.75, H + R.WALL_T * 3), 5.5, R.STANDOFF_H, fc="#E8C766", ec=INK, lw=0.6))
for x in (20, 280):
    bx.add_patch(Rectangle((x - 13.5, H - 1.2), 27, 1.2, fc="#FDE68A", ec=SENS, lw=0.8, ls="--"))
bx.add_patch(Rectangle((150 - 13.5, zb - 1.2), 27, 1.2, fc="#FDE68A", ec=SENS, lw=0.8))
bx.add_patch(Rectangle((142.5, T + 8), 15, 1.6, fc="#7C3AED", ec=INK, lw=0.6)); bx.add_patch(Rectangle((145, T), 10, 8, fc="#D1D5DB", ec=INK, lw=0.5))
bx.text(150, T + 14, "BMP280", ha="center", fontsize=8, color="#6D28D9")
bx.add_patch(Rectangle((P, 36), 32, 8, fc="#D1D5DB", ec=INK, lw=0.6))
bx.text(P + 16, 50, "valve", ha="center", fontsize=8)
bx.text(20, H - 9, "P3 (behind)", ha="left", fontsize=8, color=SENS); bx.text(280, H - 9, "P4 (behind)", ha="right", fontsize=8, color=SENS)
bx.text(150, zb - 9, "P5", ha="center", fontsize=8, color=SENS)
bx.text(40, H + 6, "1 mm Al wall (drawn ×3)", fontsize=8, color=INK)
dim_v(bx, -14, 0, H, f"{H:g}", side=-1)
dim_v(bx, P + 45, H + R.WALL_T * 3, zb, "15", side=1)
ext(bx, P + 2, zb, P + 49, zb); ext(bx, P + 2, H + 3, P + 49, H + 3)
dim_h(bx, 0, P, -18, "300")
dim_h(bx, 0, P, zb + 14, "300 (bumper, 0.5 mm Al)")
bx.text(150, H / 2 - 10, f"sealed air volume ≈ {R.inner_volume_litres():.2f} L\npressurised to ≈ 2.5 kPa", ha="center", fontsize=9, color="#374151")
bx.text(P / 2, zb + 42, "SECTION A–A  (cut at y = 225 through P5, viewed from −y)", ha="center", weight="bold", fontsize=11, color=INK)
bx.set_xlim(-50, P + 80); bx.set_ylim(-40, zb + 60)

# ------------------------------------------------------------------ parts table
tx = fig.add_axes([0.54, 0.16, 0.43, 0.28]); tx.axis("off")
rows = [("#", "Part", "Spec", "Qty"),
        ("1", "Pressure wall", "Aluminium sheet, 1 mm, 300 × 300", "1"),
        ("2", "Bumper (Whipple shield)", "Aluminium sheet, 0.5 mm, 300 × 150", "1"),
        ("3", "Sealed box", "Plastic container ~300 × 300 × 95, ~7.9 L", "1"),
        ("4", "Piezo disc", "27 mm brass, bonded with Fevikwik", "5"),
        ("5", "Standoff + screw + nut", "M3 × 15 hex, brass", "4"),
        ("6", "Pressure sensor", "BMP280 module, I²C 0x76", "1"),
        ("7", "Valve", "Tubeless tyre valve stem", "1"),
        ("8", "Seal", "M-seal epoxy bead + foil over ports", "—"),
        ("9", "Analog board", "Perfboard: 2× LM324, 2× LM339, 5 trimpots", "1"),
        ("10", "Controller", "ESP32 30-pin dev board", "1")]
tb = tx.table(cellText=rows[1:], colLabels=rows[0], loc="upper left", cellLoc="left", colWidths=[0.05, 0.27, 0.58, 0.07])
tb.auto_set_font_size(False); tb.set_fontsize(8.5); tb.scale(1, 1.32)
for (r, c), cell in tb.get_celld().items():
    cell.set_edgecolor("#9CA3AF"); cell.set_linewidth(0.6)
    if r == 0: cell.set_facecolor("#111827"); cell.get_text().set_color("white"); cell.get_text().set_weight("bold")

# ------------------------------------------------------------------ title block
fig.add_artist(Rectangle((0.54, 0.03), 0.43, 0.105, transform=fig.transFigure, fill=False, lw=1.2, color=INK))
fig.text(0.55, 0.11, "HULLSENSE · Strike-localisation and breach-sizing test rig", fontsize=13, weight="bold", color=INK)
fig.text(0.55, 0.085, "Team BYTEMELATER · Team lead: Yogeeshwaran C · Rajalakshmi Engineering College · SEDHACKS '26", fontsize=9, color="#374151")
fig.text(0.55, 0.062, "All dimensions in mm · Sheet A3 · Source: hardware/cad/hullsense_rig.py (CadQuery) · STEP: hullsense_rig.step", fontsize=8.5, color="#374151")
fig.text(0.55, 0.040, "Sensor coordinates match docs/dashboard/solver.js. Wall thickness exaggerated in section for clarity.", fontsize=8.5, color="#6B7280", style="italic")
fig.text(0.04, 0.05, "Breach ports are drilled, then sealed with foil and tape; a punch through the foil opens a hole of known diameter.\n"
         "Piezos P1–P4 sit 20 mm in from each corner on the underside of the wall; P5 sits on the underside of the bumper.",
         fontsize=9, color="#374151")

fig.savefig(os.path.join(HERE, "hullsense_rig_drawing.pdf"))
fig.savefig(os.path.join(HERE, "hullsense_rig_drawing.png"), dpi=110)
print("wrote drawing PDF + PNG")
