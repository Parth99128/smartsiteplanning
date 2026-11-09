# FloodShield AI — Pre-construction Flood Risk & Resilience Platform

> Planning-grade estimates. Verify with a licensed engineer before construction decisions.

## Quick start

1. **Configure secrets:**
```powershell
Copy-Item .env.example .env
# edit .env — set POSTGRES_PASSWORD
```

2. **Train the model (CPU only, in `ml-service/`):**
```powershell
cd ml-service
pip install -r requirements.txt
# Production: train from a surveyed dataset
python train.py --data data/flood_training.csv --out models/rf_flood_model.pkl
# Dev/CI only: analytical synthetic data (explicit opt-in)
python train.py --synthetic --samples 5000 --out models/rf_flood_model.pkl
python app.py  # serves on :8000
```
No GPU required. RandomForest trains on CPU in ~10-30s. See `docs/training-guide.md`.
The ML service refuses to serve inference without a trained bundle (`/health` reports `model_loaded`).

3. **Database:**
```powershell
docker compose up db -d
# schema auto-applies from database/schema.sql on first init.
# Existing installs: psql $DATABASE_URL -f database/migrations/001_drop_demo.sql
```

4. **Backend (Java 21, Maven):**
```powershell
cd backend
mvn spring-boot:run  # :8080
```

5. **Frontend:**
```powershell
cd frontend
npm install
npm run dev  # :5173
```

6. **All via Docker:**
```powershell
docker compose up --build
```

## Structure
```
/frontend  React+Vite+Tailwind+Leaflet+R3F+Recharts+FramerMotion
/backend   Spring Boot REST (:8080) + Postgres/PostGIS persistence
/ml-service FastAPI risk + flow-path + heightmap (:8000)
/database  Postgres+PostGIS schema/migrations (no demo rows)
/docs      contracts, architecture, training guide
```

## Flow
Create project → Analyze → 3D drainage → What-if simulation → Badge → Report + share link.

All risk artefacts are persisted in Postgres so reports and comparisons are reproducible.
The 3D twin renders only stored analysis output — never placeholder terrain.

See `docs/implementation-plan.md` + `docs/api-contract.md`.
