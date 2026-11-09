"""FloodShield AI — planning-grade hydraulics (Manning + rational, CPU, no deps beyond numpy).

This is the REAL-DATA loop that grounds the Random Forest:
  RF predicts from 12 surveyed factors (statistical),
  hydraulics checks drain capacity vs runoff (physics).
The ensemble in the backend weights both by registry confidence.

All formulas are documented planning proxies (see docs/methodology) —
NOT a substitute for a licensed SWMM model or certified design.
"""
import math

G = 9.81


def _slope(slope_deg=None, slope_frac=None):
    if slope_frac is not None and slope_frac > 0:
        return max(1e-4, min(0.2, float(slope_frac)))
    if slope_deg is not None:
        return max(1e-4, min(0.2, math.tan(math.radians(max(0.1, float(slope_deg))))))
    return 0.005


def pipe_capacity_m3s(dia_mm, slope_deg=None, slope_frac=None, n=0.013):
    """Full-flowing circular pipe (Manning). Returns m3/s."""
    d = max(0.1, float(dia_mm) / 1000.0)
    s = _slope(slope_deg, slope_frac)
    area = math.pi * d * d / 4.0
    r = d / 4.0
    return (1.0 / n) * area * (r ** (2.0 / 3.0)) * math.sqrt(s)


def open_channel_capacity_m3s(width_m, depth_m=None, slope_deg=None, slope_frac=None,
                              n=0.03, kind="storm"):
    """Rectangular open drain / nalla proxy. Depth defaults to 0.5*width capped 1.2m."""
    w = max(0.3, float(width_m))
    d = depth_m or min(1.2, 0.5 * w)
    s = _slope(slope_deg, slope_frac)
    nn = 0.013 if kind in ("storm", "sewer") else n
    area = w * d
    perim = w + 2 * d
    r = area / max(1e-6, perim)
    return (1.0 / nn) * area * (r ** (2.0 / 3.0)) * math.sqrt(s)


def segment_capacity(seg, slope_deg=1.0):
    """Capacity of one registry segment. seg: {dia_mm?, width_m?, kind?}."""
    kind = (seg.get("kind") or "storm").lower()
    dia = seg.get("dia_mm")
    w = seg.get("width_m")
    cond = (seg.get("status") or "").lower()
    # Documented planning proxies: silted/badly-rated sections carry less.
    # 'Bad' comes from GCC Chennai field surveys (STATUS field).
    silt_factor = 0.6 if ("silt" in cond or "bad" in cond) else 0.8 if "proposed" in cond else 1.0
    # field verify override: officer tags blocked_pct 0..100
    blocked = float(seg.get("blocked_pct", 0) or 0)
    if blocked:
        silt_factor *= max(0.1, 1.0 - blocked / 100.0)
    if dia and float(dia) > 0:
        q = pipe_capacity_m3s(float(dia), slope_deg=slope_deg)
    elif w and float(w) > 0:
        q = open_channel_capacity_m3s(float(w), slope_deg=slope_deg, kind=kind)
    else:
        # unknown section: assume 0.9m tertiary open drain (conservative, documented)
        q = open_channel_capacity_m3s(0.9, slope_deg=slope_deg, kind=kind)
    return q * silt_factor


def rational_runoff_m3s(rainfall_mm, catchment_sqm, impervious_pct, duration_hr=1.0):
    """Q = C * i * A. C from impervious (0.3 pervious .. 0.9 fully built)."""
    c = 0.3 + 0.6 * (max(0, min(100, float(impervious_pct))) / 100.0)
    i = max(0, float(rainfall_mm)) / max(0.25, float(duration_hr))  # mm/hr
    a = max(100, float(catchment_sqm))
    return c * (i / 1000.0 / 3600.0) * a


def check_network(segments, rainfall_mm, catchment_sqm, impervious_pct,
                  slope_deg=1.0, duration_hr=1.0):
    """Compare total runoff vs summed capacity. Surcharge flags per segment.

    Share model (transparent): each segment is assumed to carry an equal share
    of total runoff (1/N). A segment surcharges when share > its capacity.
    This is a planning screen, not a branched hydraulic simulation.
    """
    segs = segments or []
    q_run = rational_runoff_m3s(rainfall_mm, catchment_sqm, impervious_pct, duration_hr)
    caps = [(s.get("id", f"seg-{i}"), segment_capacity(s, slope_deg)) for i, s in enumerate(segs)]
    q_cap = sum(c for _, c in caps)
    n = max(1, len(caps))
    share = q_run / n
    surcharged = [sid for sid, c in caps if share > c]
    margin = (q_cap - q_run) / max(1e-9, q_run)  # +ve spare, -ve deficit
    return {
        "q_runoff_m3s": round(q_run, 3),
        "q_capacity_m3s": round(q_cap, 3),
        "margin_ratio": round(margin, 3),
        "surcharged_ids": surcharged,
        "surcharged_count": len(surcharged),
        "segments": len(caps),
        "method": "manning-rational-v1 (planning proxy, equal-share)",
    }
