# WHERE + HOW to train (std laptop, no GPU) — READ THIS FIRST

## TL;DR
Train from a surveyed dataset CSV in `ml-service/`, on CPU. No GPU needed, no Colab needed.

## Where
- File: `ml-service/train.py`
- Input (production): `ml-service/data/flood_training.csv` (you provide — IMD rainfall, DEM elevation, soil survey)
- Output: `ml-service/models/rf_flood_model.pkl` (+ `meta.json` with RMSE/MAE/R²)
- Consumed by: `ml-service/app.py` (`POST /predict`, `/simulate`, `/recommend`)

## Production training (surveyed data)
```powershell
cd C:\Users\Parth\climate\ml-service
pip install -r requirements.txt
python train.py --data data/flood_training.csv --target risk_score --trees 300 --out models/rf_flood_model.pkl
python app.py
# test:
# curl -Method POST http://localhost:8000/health
```

CSV requirements:
- Columns: `rainfall_mm, elevation_m, slope_deg, dist_water_m, drainage_density, soil_infiltration_mmhr, impervious_pct, footprint_sqm, hist_flood_count, plinth_m, land_use_change_pct, catchment_sqm` + target (default `risk_score` 0..100).
- Minimum 50 clean rows. Out-of-range values fail fast with a clear error.
- `meta.json` records a hash of the training data + metrics for auditability.

## Dev/CI training (analytical synthetic, explicit opt-in only)
```powershell
python train.py --synthetic --samples 5000 --trees 200 --out models/rf_flood_model.pkl
```
Synthetic bundles are labelled `synthetic: true` and must never back real assessments.

## Options
```
--data data/flood_training.csv  # surveyed dataset (production)
--target risk_score              # target column
--synthetic                     # analytical data (dev/CI only)
--samples 5000                  # synthetic rows (with --synthetic)
--trees 200                     # 100 if slow, 300 if fast
--seed 42
--out models/rf_flood_model.pkl
--model-version rf-20260101-300t
```

## Retrain when?
- When survey data grows, features change, or validation metrics drift. Version every bundle with `--model-version`; `/version` exposes it.
- To swap datasets: replace the CSV, not the code — no business-logic change.

## Troubleshooting
- `ModuleNotFoundError: sklearn` → `pip install -r requirements.txt`
- `MemoryError` → lower `--trees`
- `MODEL_NOT_LOADED (503)` → run `train.py` first and mount `models/`; the service never serves heuristic fallbacks.
- No internet? `requirements.txt` needs one-time install; afterwards fully offline.

## What NOT to do
- Don't train in frontend or backend — only `ml-service/`.
- Don't use GPU/Colab/Kaggle — unnecessary for RF.
- Don't train per-request — train once, infer per-request (<20ms).
- Don't ship `--synthetic` weights for real assessments.
