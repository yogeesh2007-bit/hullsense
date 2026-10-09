"""HULLSENSE physics model: box decay curves, hole sizing, flight scaling.

Run:  python3 analysis/hullsense_model.py
Team BYTEMELATER · SEDHACKS '26
"""
import math

RHO, PATM, CD = 1.2, 101325.0, 0.62


def box_decay(volume_m3, hole_mm, dp0_pa=2500.0, dt=1e-3, stop_pa=50.0):
    """Subsonic orifice blow-down of the demo box. Returns seconds to fall from dp0 to stop_pa."""
    area = math.pi * (hole_mm / 2000) ** 2
    dp, t = dp0_pa, 0.0
    while dp > stop_pa:
        q = CD * area * math.sqrt(2 * dp / RHO)
        dp -= (PATM + dp) / volume_m3 * q * dt
        t += dt
    return t


def flight_minutes(hole_mm, module_m3=91.0, loss_fraction=0.10, temp_k=295.0, gamma=1.4, r=287.0):
    """Choked flow to vacuum: minutes until a module loses `loss_fraction` of its air."""
    cstar = math.sqrt(gamma * r * temp_k) * (2 / (gamma + 1)) ** ((gamma + 1) / (2 * (gamma - 1)))
    area = math.pi * (hole_mm / 2000) ** 2
    tau = module_m3 / (CD * area * cstar)
    return tau * math.log(1 / (1 - loss_fraction)) / 60


def diameter_sensitivity_to_cd(cd_true, cd_assumed=CD):
    """Estimated / true diameter when the real orifice coefficient differs from the assumed one."""
    return math.sqrt(cd_true / cd_assumed)


if __name__ == "__main__":
    print("Demo box (2.5 kPa -> 50 Pa):")
    for v in (0.005, 0.008):
        for d in (1, 2, 3):
            print(f"  {v*1000:.0f} L, {d} mm hole: {box_decay(v, d):5.2f} s")
    print("Diameter error if Cd is really 0.60 / 0.65 / 0.70:",
          ", ".join(f"{diameter_sensitivity_to_cd(c):.3f}" for c in (0.60, 0.65, 0.70)))
    print("BAS-01-class module (~91 m3), time to lose 10% of its air:")
    for d in (2, 5, 10, 25):
        m = flight_minutes(d)
        print(f"  {d:>2} mm: {m:6.0f} min")
    assert abs(flight_minutes(5) - 66) < 2
    print("model checks passed")
