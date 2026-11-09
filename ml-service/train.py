"""FloodShield risk-model training (CPU, no GPU).

Production usage — train from a surveyed dataset CSV:
    python train.py --data data/flood_training.csv --target risk_score \\
        --out models/rf_flood_model.pkl --trees 300

    CSV must contain the 12 feature columns:
    rainfall_mm, elevation_m, slope_deg, dist_water_m, drainage_density,
    soil_infiltration_mmhr, impervious_pct, footprint_sqm, hist_flood_count, plinth_m,
    land_use_change_pct, catchment_sqm
    plus the target column (default: risk_score, 0..100).

Dev/CI usage — analytical synthetic data (explicit opt-in only):
    python train.py --synthetic --samples 5000 --out models/rf_flood_model.pkl

Outputs:
    <out>            joblib bundle {model, scaler, features, model_version}
    <out-dir>/meta.json   RMSE / MAE / R2, params, data hash, timestamp
"""
import argparse
import hashlib
import json
import os
import sys
import time

import numpy as np

FEATURES = ["rainfall_mm", "elevation_m", "slope_deg", "dist_water_m", "drainage_density",
            "soil_infiltration_mmhr", "impervious_pct", "footprint_sqm", "hist_flood_count", "plinth_m",
            "land_use_change_pct", "catchment_sqm"]

RANGES = {
    "rainfall_mm": (0, 600), "elevation_m": (-50, 4000), "slope_deg": (0, 60),
    "dist_water_m": (0, 20000), "drainage_density": (0, 10),
    "soil_infiltration_mmhr": (0, 200), "impervious_pct": (0, 100),
    "footprint_sqm": (0, 100000), "hist_flood_count": (0, 50), "plinth_m": (0, 5),
    "land_use_change_pct": (0, 100), "catchment_sqm": (0, 2000000),
}


def generate_synthetic(n=5000, seed=42):
    """Analytical test data. Explicitly synthetic — never production training data."""
    rng = np.random.default_rng(seed)
    rainfall = rng.uniform(80, 320, n)
    elev = rng.uniform(2, 25, n)
    slope = rng.uniform(0.5, 8, n)
    dist = rng.uniform(20, 1500, n)
    drain = rng.uniform(0.4, 3.0, n)
    infil = rng.uniform(4, 35, n)
    imperv = rng.uniform(20, 95, n)
    foot = rng.uniform(200, 1500, n)
    hist = rng.integers(0, 5, n)
    plinth = rng.uniform(0.0, 1.2, n)
    landuse = np.clip(imperv * 0.8 + rng.normal(0, 8, n), 5, 95)
    catchm = 10 ** rng.uniform(3.7, 5.7, n)  # ~5k..500k sqm upstream area
    score = (0.22 * (rainfall / 320 * 100) + 0.16 * ((25 - elev) / 23 * 100) + 0.10 * ((8 - slope) / 7.5 * 100)
             + 0.12 * np.clip((500 - dist) / 480, 0, 1) * 100 + 0.10 * ((3 - drain) / 2.6 * 100)
             + 0.08 * ((35 - infil) / 31 * 100) + 0.10 * (imperv) + 0.05 * (foot / 1500 * 100)
             + 0.05 * (hist / 4 * 100) - 0.06 * (plinth / 1.2 * 100)
             + 0.05 * (landuse) + 0.03 * np.clip(catchm / 500000 * 100, 0, 100))
    score += rng.normal(0, 5, n)
    X = np.column_stack([rainfall, elev, slope, dist, drain, infil, imperv, foot, hist, plinth,
                         landuse, catchm])
    return X, np.clip(score, 2, 98), "synthetic-v2"


def load_csv(path, target):
    import pandas as pd  # local import so --synthetic devs don't need pandas edge cases
    df = pd.read_csv(path)
    missing = [c for c in FEATURES + [target] if c not in df.columns]
    if missing:
        raise ValueError(f"dataset {path} missing columns: {missing}")
    df = df.dropna(subset=FEATURES + [target])
    if len(df) < 50:
        raise ValueError(f"dataset {path} has only {len(df)} usable rows (need >= 50)")
    for col, (lo, hi) in RANGES.items():
        bad = ((df[col] < lo) | (df[col] > hi)).sum()
        if bad:
            raise ValueError(f"column {col} has {bad} values outside [{lo},{hi}] — clean the dataset")
    bad_t = ((df[target] < 0) | (df[target] > 100)).sum()
    if bad_t:
        raise ValueError(f"target {target} has {bad_t} values outside [0,100]")
    X = df[FEATURES].to_numpy(dtype=float)
    y = df[target].to_numpy(dtype=float)
    h = hashlib.sha256(pd.util.hash_pandas_object(df[FEATURES + [target]], index=False).values.tobytes()).hexdigest()[:16]
    return X, y, f"csv:{os.path.basename(path)}#{h}"


def main():
    ap = argparse.ArgumentParser(description="Train FloodShield flood-risk model")
    ap.add_argument("--data", default=None, help="path to surveyed training CSV")
    ap.add_argument("--target", default="risk_score", help="target column in CSV")
    ap.add_argument("--synthetic", action="store_true", help="use analytical synthetic data (dev/CI only)")
    ap.add_argument("--samples", type=int, default=5000)
    ap.add_argument("--trees", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="models/rf_flood_model.pkl")
    ap.add_argument("--model-version", default=None)
    a = ap.parse_args()

    from sklearn.ensemble import RandomForestRegressor
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    from sklearn.model_selection import train_test_split
    from sklearn.preprocessing import StandardScaler
    import joblib

    if a.synthetic:
        print("[train] WARNING: analytical SYNTHETIC data (dev/CI only, not for production).")
        X, y, data_id = generate_synthetic(a.samples, a.seed)
    elif a.data:
        print(f"[train] loading surveyed dataset {a.data} ...")
        X, y, data_id = load_csv(a.data, a.target)
    else:
        print("[train] ERROR: provide --data data/flood_training.csv for production, "
              "or --synthetic explicitly for dev/CI.", file=sys.stderr)
        print("  example: python train.py --data data/flood_training.csv --out models/rf_flood_model.pkl",
              file=sys.stderr)
        sys.exit(2)

    print(f"[train] rows={len(X)} features={FEATURES}")
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=a.seed)
    sc = StandardScaler()
    Xtr_s, Xte_s = sc.fit_transform(Xtr), sc.transform(Xte)
    rf = RandomForestRegressor(n_estimators=a.trees, max_depth=14, min_samples_leaf=3,
                               n_jobs=-1, random_state=a.seed)
    rf.fit(Xtr_s, ytr)
    pred = rf.predict(Xte_s)
    rmse = float(mean_squared_error(yte, pred) ** 0.5)
    mae = float(mean_absolute_error(yte, pred))
    r2 = float(r2_score(yte, pred))
    print(f"[train] val RMSE={rmse:.2f} MAE={mae:.2f} R2={r2:.3f} mean_pred={pred.mean():.1f}")

    version = a.model_version or f"rf-{time.strftime('%Y%m%d')}-{a.trees}t"
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    joblib.dump({"model": rf, "scaler": sc, "features": FEATURES, "model_version": version}, a.out)
    meta = {"model_version": version, "rmse": rmse, "mae": mae, "r2": r2,
            "samples": int(len(X)), "trees": a.trees, "seed": a.seed,
            "features": FEATURES, "data_id": data_id, "synthetic": bool(a.synthetic),
            "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    with open(os.path.join(os.path.dirname(a.out) or ".", "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print(f"[train] saved -> {a.out} (+ meta.json) version={version}")
    if a.synthetic:
        print("[train] NOTE: synthetic bundle is for dev/CI. Retrain with --data before any real assessment.")


if __name__ == "__main__":
    main()
