"""FloodShield ML API: /predict /flowpath /simulate /recommend /health (FastAPI, CPU).

Production rules:
- The Random-Forest bundle is REQUIRED. If models/rf_flood_model.pkl is absent
  or corrupt the service reports model_loaded=false and every inference
  endpoint returns 503 — it never silently falls back to heuristics.
- All inputs are range-validated with Pydantic. No silent defaults hide
  missing survey data.
- /flowpath traces a caller-supplied surveyed DEM when elevation_grid is
  present (production). Seed-based analytical terrain is available only with
  allow_synthetic=true and is labelled synthetic in the response.
"""
import logging
import os
from typing import Any, Dict, List, Optional

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from flow_path import generate_from_grid, generate_synthetic
from hydraulics import check_network

log = logging.getLogger("floodshield-ml")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

MODEL_PATH = os.getenv("MODEL_PATH", "models/rf_flood_model.pkl")
MODEL_VERSION = os.getenv("MODEL_VERSION", "rf-v2")
_CANDIDATES = [MODEL_PATH, os.path.join(os.path.dirname(__file__), "models", "rf_flood_model.pkl")]
FEATURES = ["rainfall_mm", "elevation_m", "slope_deg", "dist_water_m", "drainage_density",
            "soil_infiltration_mmhr", "impervious_pct", "footprint_sqm", "hist_flood_count", "plinth_m",
            "land_use_change_pct", "catchment_sqm"]

bundle: Optional[Dict[str, Any]] = None
bundle_error: Optional[str] = None
for _p in _CANDIDATES:
    if os.path.exists(_p):
        try:
            loaded = joblib.load(_p)
            if "model" not in loaded or "scaler" not in loaded:
                raise ValueError("bundle missing model/scaler keys")
            bundle = loaded
            log.info("[ml] loaded model %s (version=%s)", _p, MODEL_VERSION)
            break
        except Exception as e:  # noqa: BLE001
            bundle_error = str(e)
            log.error("[ml] model load failed for %s: %s", _p, e)
if bundle is None and bundle_error is None:
    bundle_error = f"model file not found (checked: {_CANDIDATES}); run train.py"
    log.error("[ml] %s", bundle_error)

app = FastAPI(title="FloodShield ML", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class Feats(BaseModel):
    rainfall_mm: float = Field(..., ge=0, le=600)
    elevation_m: float = Field(..., ge=-50, le=4000)
    slope_deg: float = Field(..., ge=0, le=60)
    dist_water_m: float = Field(..., ge=0, le=20000)
    drainage_density: float = Field(..., ge=0, le=10)
    soil_infiltration_mmhr: float = Field(..., ge=0, le=200)
    impervious_pct: float = Field(..., ge=0, le=100)
    footprint_sqm: float = Field(..., ge=0, le=100000)
    hist_flood_count: int = Field(..., ge=0, le=50)
    plinth_m: float = Field(..., ge=0, le=5)
    land_use_change_pct: float = Field(..., ge=0, le=100)
    catchment_sqm: float = Field(..., ge=0, le=2000000)


class SimReq(Feats):
    green_sqm: float = Field(0, ge=0, le=100000)
    permeable_sqm: float = Field(0, ge=0, le=100000)
    storage_m3: float = Field(0, ge=0, le=10000)
    rain_garden: bool = False
    recharge: bool = False
    climate_uplift_pct: float = Field(0, ge=0, le=100)
    # Optional real-drain loop: [{id, dia_mm?, width_m?, kind?, status?, blocked_pct?}]
    segments: Optional[List[Dict[str, Any]]] = None


class ResReq(SimReq):
    """Resilience breakdown request: SimReq factors+design plus flow context."""
    intersects_building: bool = False


class FlowReq(BaseModel):
    seed: int = Field(42, ge=0, le=10_000_000)
    size: int = Field(64, ge=8, le=256)
    cell_m: float = Field(5.0, ge=0.1, le=100)
    building: Optional[Dict[str, float]] = None
    elevation_grid: Optional[List[List[float]]] = None
    allow_synthetic: bool = False
    # Real-drain loop: normalized polylines [[[x,y],...]] in 0..1 site frame,
    # or [{pts:[[x,y]...], depth_m:1.0}]. Carved into the DEM before tracing.
    burn_lines: Optional[List[Any]] = None
    burn_depth_m: float = Field(1.0, ge=0.2, le=3.0)


class HydraulicsReq(BaseModel):
    segments: List[Dict[str, Any]] = Field(default_factory=list)
    rainfall_mm: float = Field(..., ge=0, le=600)
    catchment_sqm: float = Field(48000, ge=100, le=2000000)
    impervious_pct: float = Field(65, ge=0, le=100)
    slope_deg: float = Field(1.0, ge=0, le=60)
    duration_hr: float = Field(1.0, ge=0.25, le=24)


class DesignDrainsReq(BaseModel):
    """Size a site's internal storm run: smallest standard RCC dia carrying
    the design storm (rational + Manning, planning-grade, not a GFC design)."""
    roof_sqm: float = Field(800, ge=0, le=100000)
    paved_sqm: float = Field(400, ge=0, le=100000)
    design_rain_mmh: float = Field(100, ge=25, le=200)
    slope_frac: float = Field(0.005, ge=0.001, le=0.1)


def _require_bundle():
    if bundle is None:
        raise HTTPException(status_code=503, detail={
            "code": "MODEL_NOT_LOADED",
            "message": "Risk model is not loaded. Train it with train.py and mount models/.",
            "detail": bundle_error,
        })


def predict_one(f: dict):
    _require_bundle()
    m, sc = bundle["model"], bundle["scaler"]
    x = np.array([[f[k] for k in FEATURES]], dtype=float)
    if not np.isfinite(x).all():
        raise HTTPException(status_code=422, detail="features contain non-finite values")
    score = float(m.predict(sc.transform(x))[0])
    imps = m.feature_importances_
    contribs = {k: round(float(v * (score / 100) * 10), 2) for k, v in zip(FEATURES, imps)}
    score = max(2, min(98, score))
    top = sorted(contribs, key=contribs.get, reverse=True)[:3]
    level = "Low" if score < 35 else "Moderate" if score < 60 else "High" if score < 80 else "Severe"
    return score, level, top, contribs


def _clamp(v, lo=0.0, hi=100.0):
    return max(lo, min(hi, float(v)))


def resilience_breakdown(f: dict, sim: dict, intersects: bool = False):
    """Explainable 0-100 sub-scores from surveyed factors + design inputs.

    All six parameters are transparent planning formulas (documented in
    docs/methodology); overall is the weighted mean. Not a certification.
    """
    elev = f.get("elevation_m", 8)
    dist = f.get("dist_water_m", 120)
    hist = f.get("hist_flood_count", 0)
    site = 100 - max(0, 8 - elev) * 4 - max(0, 150 - dist) / 150 * 25 - hist * 6

    dd = f.get("drainage_density", 1.2)
    drainage = dd / 3 * 70 + (0 if intersects else 30)

    storage = sim.get("storage_m3", 0) * 1.0 + (20 if sim.get("recharge") else 0)

    perm = ((100 - f.get("impervious_pct", 65)) * 0.75
            + min(15, sim.get("permeable_sqm", 0) / 1200 * 15)
            + f.get("soil_infiltration_mmhr", 12) / 35 * 10)

    elev_b = f.get("plinth_m", 0.3) / 0.9 * 100

    green = (min(100, sim.get("green_sqm", 0) / 1000 * 50)
             + (30 if sim.get("rain_garden") else 0)
             + (20 if sim.get("recharge") else 0))

    parts = {
        "site_selection": round(_clamp(site), 1),
        "drainage": round(_clamp(drainage), 1),
        "water_storage": round(_clamp(storage), 1),
        "permeability": round(_clamp(perm), 1),
        "building_elevation": round(_clamp(elev_b), 1),
        "green_infrastructure": round(_clamp(green), 1),
    }
    overall = round(parts["site_selection"] * 0.20 + parts["drainage"] * 0.20
                    + parts["water_storage"] * 0.15 + parts["permeability"] * 0.20
                    + parts["building_elevation"] * 0.10 + parts["green_infrastructure"] * 0.15, 1)
    badge = "Bronze" if overall < 40 else "Silver" if overall < 60 else "Gold" if overall < 80 else "Platinum"
    return overall, badge, parts


def resilience(f: dict, sim: dict):
    s, badge, _ = resilience_breakdown(f, sim, False)
    return s, badge


def recommend(f: dict, flags: dict):
    recs = []
    if f["impervious_pct"] > 60:
        recs.append({"problem": "High impervious cover", "action": "Permeable paving + rain garden",
                     "reason": "Cuts runoff at source", "effect": "-8 to -14 risk pts",
                     "priority": "High", "cost_band": "Medium", "gain_pts": 11})
    if flags.get("intersects"):
        recs.append({"problem": "Building blocks natural drainage path", "action": "Shift footprint / leave drainage corridor",
                     "reason": "Keeps flow path clear", "effect": "-10 to -18 risk pts",
                     "priority": "Critical", "cost_band": "Design-stage", "gain_pts": 14})
    if f["plinth_m"] < 0.45:
        recs.append({"problem": "Low plinth elevation", "action": "Raise plinth to 0.6-0.9m",
                     "reason": "Keeps floor above shallow flooding", "effect": "-4 to -8 risk pts",
                     "priority": "High", "cost_band": "Medium", "gain_pts": 6})
    if f["drainage_density"] < 1.5:
        recs.append({"problem": "Insufficient drainage capacity", "action": "Add recharge pits + 50m3 storm storage",
                     "reason": "Buffers peak rainfall", "effect": "-5 to -10 risk pts",
                     "priority": "Medium", "cost_band": "Higher", "gain_pts": 8})
    if f.get("land_use_change_pct", 0) > 60:
        recs.append({"problem": "Large pervious-to-built conversion", "action": "Green buffer + cap built-up conversion",
                     "reason": "Preserves infiltration where land use changed most", "effect": "-4 to -9 risk pts",
                     "priority": "Medium", "cost_band": "Medium", "gain_pts": 7})
    if not recs:
        recs.append({"problem": "Residual monsoon risk", "action": "Maintain green cover + desilt drains yearly",
                     "reason": "Prevents drift", "effect": "-2 to -4 risk pts",
                     "priority": "Low", "cost_band": "Lower", "gain_pts": 3})
    return recs


@app.get("/health")
def health():
    return {"model_loaded": bundle is not None, "model_version": MODEL_VERSION,
            "features": FEATURES, "error": bundle_error if bundle is None else None}


@app.get("/version")
def version():
    meta_path = os.path.join(os.path.dirname(MODEL_PATH), "meta.json") \
        if os.path.isabs(MODEL_PATH) or os.path.dirname(MODEL_PATH) \
        else os.path.join(os.path.dirname(__file__), "models", "meta.json")
    meta: Any = None
    try:
        if os.path.exists(meta_path):
            import json
            with open(meta_path) as fh:
                meta = json.load(fh)
    except Exception:  # noqa: BLE001
        meta = None
    return {"service": "floodshield-ml", "model_version": MODEL_VERSION,
            "model_loaded": bundle is not None, "training_meta": meta}


@app.post("/predict")
def predict(f: Feats):
    d = f.model_dump()
    s, lvl, top, c = predict_one(d)
    return {"risk_score": round(s, 1), "risk_level": lvl, "top_factors": top,
            "contributions": c, "model_version": MODEL_VERSION,
            "disclaimer": "Planning-grade estimate. Verify with a licensed engineer."}


@app.post("/hydraulics")
def hydraulics_ep(r: HydraulicsReq):
    """Physics cross-check: runoff vs summed drain capacity (planning proxy)."""
    if len(r.segments) > 500:
        raise HTTPException(status_code=422, detail="segments max 500")
    return check_network(r.segments, r.rainfall_mm, r.catchment_sqm,
                         r.impervious_pct, r.slope_deg, r.duration_hr)


@app.post("/design-drains")
def design_drains(r: DesignDrainsReq):
    from hydraulics import pipe_capacity_m3s
    q = 0.95 * (r.design_rain_mmh / 1000.0 / 3600.0) * r.roof_sqm \
        + 0.85 * (r.design_rain_mmh / 1000.0 / 3600.0) * r.paved_sqm
    std = [150, 200, 250, 300, 400, 450, 600, 900, 1200]
    pick, cap = std[-1], pipe_capacity_m3s(std[-1], slope_frac=r.slope_frac)
    for d in std:
        c = pipe_capacity_m3s(d, slope_frac=r.slope_frac)
        if c >= q * 1.15:  # 15% freeboard practice
            pick, cap = d, c
            break
    area = 3.1416 * (pick / 1000.0) ** 2 / 4
    runs = 1 if pick <= 600 else 2
    q_barrel = q / runs
    cap_total = cap * runs
    vel = q_barrel / max(1e-9, area)
    note = ("Single run at 1:%d slope with 15%% freeboard." % round(1 / r.slope_frac))
    if pick >= 1200 and cap < q * 1.15:
        note = "Flow exceeds a single 1200mm run — split into parallel runs or add on-site storage."
    elif runs == 2:
        note = "Prefer 2 parallel %dmm runs over one oversized barrel for cleaning access." % pick
    return {"q_m3s": round(q, 3), "dia_mm": pick, "runs": runs,
            "capacity_m3s": round(cap_total, 3),
            "velocity_ms": round(vel, 2),
            "self_cleansing": bool(vel >= 0.6),
            "note": note + " Lay at >=1.0m cover; verify inverts against the municipal outfall before GFC.",
            "method": "rational+manning-v1 (planning-grade, not a GFC design)"}


@app.post("/flowpath")
def flowpath(r: FlowReq):
    try:
        if r.elevation_grid is not None:
            return generate_from_grid(r.elevation_grid, r.cell_m, r.building,
                                      r.burn_lines, r.burn_depth_m)
        if not r.allow_synthetic:
            raise HTTPException(status_code=422, detail={
                "code": "SURVEY_DEM_REQUIRED",
                "message": "elevation_grid is required for production flow-path analysis. "
                           "Set allow_synthetic=true only for local dev/CI.",
            })
        return generate_synthetic(r.seed, r.size, r.cell_m, r.building)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/simulate")
def simulate(r: SimReq):
    d = r.model_dump()
    d["rainfall_mm"] = d["rainfall_mm"] * (1 + d.pop("climate_uplift_pct", 0) / 100)
    uplift = r.climate_uplift_pct
    s, lvl, top, c = predict_one({k: d[k] for k in FEATURES})
    if d.get("rain_garden"):
        s -= 5
    if d.get("recharge"):
        s -= 3
    s -= min(8, d.get("storage_m3", 0) / 100 * 8)
    s -= min(6, d.get("permeable_sqm", 0) / 2000 * 6)
    s = max(2, min(98, s))
    res, badge, parts = resilience_breakdown({k: d[k] for k in FEATURES}, d, False)
    # Real-drain loop (optional): physics check + surcharge flags alongside the RF score.
    hyd = None
    segs = d.get("segments")
    if segs:
        try:
            hyd = check_network(segs, d["rainfall_mm"], d.get("catchment_sqm", 48000),
                                d.get("impervious_pct", 65), d.get("slope_deg", 1.0))
            if hyd["margin_ratio"] < -0.2:
                s = min(98, s + 6)  # drains cannot carry the storm — lift risk, documented
                lvl = "Low" if s < 35 else "Moderate" if s < 60 else "High" if s < 80 else "Severe"
        except Exception:  # never let hydraulics break the RF path
            hyd = None
    hm = generate_synthetic(seed=int(d.get("footprint_sqm", 800)) % 9999,
                            building={"x": .35, "y": .35, "w": .25, "d": .25})
    hm["synthetic"] = True
    hm["source"] = "analytical-synthetic-v1"
    out = {"risk_score": round(s, 1), "risk_level": lvl, "top_factors": top, "contributions": c,
           "resilience_score": res, "badge": badge, "resilience_breakdown": parts,
           "heightmap": hm,
           "model_version": MODEL_VERSION, "climate_uplift_pct": uplift,
           "disclaimer": "Planning-grade estimate. Verify with a licensed engineer."}
    if hyd is not None:
        out["hydraulics"] = hyd
    return out


@app.post("/resilience")
def resilience_ep(r: ResReq):
    d = r.model_dump()
    factors = {k: d[k] for k in FEATURES}
    design = {"green_sqm": d.get("green_sqm", 0), "permeable_sqm": d.get("permeable_sqm", 0),
              "storage_m3": d.get("storage_m3", 0), "rain_garden": d.get("rain_garden", False),
              "recharge": d.get("recharge", False)}
    res, badge, parts = resilience_breakdown(factors, design, r.intersects_building)
    return {"resilience_score": res, "badge": badge, "resilience_breakdown": parts,
            "model_version": MODEL_VERSION}


@app.post("/recommend")
def recommend_ep(f: Feats):
    d = f.model_dump()
    flags = {"intersects": d["dist_water_m"] < 150 or d["impervious_pct"] > 60}
    return {"recommendations": recommend(d, flags), "model_version": MODEL_VERSION}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
