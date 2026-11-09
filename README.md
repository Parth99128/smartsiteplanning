# FloodShield AI

Pre-construction flood risk and resilience analysis. Create a site → analyze it → view the 3D drainage twin → run a what-if simulation → download a report and share link.

> Planning-grade estimates only. Verify with a licensed engineer before construction decisions.

---

## What you need

| Tool | Version | Needed for |
|------|---------|------------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | latest | Database, ML service, backend |
| [Node.js](https://nodejs.org/) | 18+ | Frontend |
| [Python](https://www.python.org/) | 3.11 | Training the ML model (one time) |

Optional, only if you run the backend without Docker: **Java 21 + Maven**.

---

## Quick start (recommended)

### 1. Clone and enter the project

```powershell
git clone <your-repo-url> climate
cd climate
```

### 2. Create your `.env`

```powershell
Copy-Item .env.example .env
```

Open `.env` and set a password:

```ini
POSTGRES_PASSWORD=change-me-in-production
```

> The password is only used the first time the database is created. If you already have a database volume, it must match that volume's password (see Troubleshooting).

### 3. Train the ML model (one time)

The trained model file is **not committed** to git, so a fresh clone must create it.

**Quick dev model (synthetic data, ~30 seconds):**

```powershell
cd ml-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python train.py --synthetic --samples 5000 --out models/rf_flood_model.pkl
deactivate
cd ..
```

**Production model (your surveyed dataset):**

```powershell
python train.py --data data/flood_training.csv --target risk_score --out models/rf_flood_model.pkl
```

See [docs/training-guide.md](docs/training-guide.md) for CSV column requirements.

> On macOS/Linux, activate with `source .venv/bin/activate`.

### 4. Start everything

**Windows (one command):**

```powershell
powershell -ExecutionPolicy Bypass -File .\start-all.ps1
```

This starts the database, ML service, and backend in Docker, waits for the backend, then opens the frontend in a new window.

**Any OS (manual):**

```powershell
# Terminal 1 – database, ML service, backend
docker compose up -d --build db ml-service backend

# Terminal 2 – frontend
cd frontend
npm install
npm run dev
```

### 5. Open the app

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8080 |
| ML service | http://localhost:8000 |
| Postgres | localhost:5432 |

Check that the backend is up:

```powershell
curl http://localhost:8080/actuator/health
```

---

## Run everything in Docker

If you don't want a local Node.js install, run the whole stack (including the frontend) in containers:

```powershell
docker compose up --build -d
```

Then open http://localhost:5173.

Stop everything:

```powershell
docker compose down
```

---

## Everyday commands

```powershell
docker compose ps                 # what is running
docker compose logs -f backend    # follow backend logs
docker compose restart backend    # restart one service
docker compose down               # stop all containers
```

Native backend (no Docker for backend):

```powershell
cd backend
mvn spring-boot:run
```

---

## Troubleshooting

**Docker is not running**
Start Docker Desktop and wait until it says "Engine running", then retry.

**`password authentication failed for user "floodshield"`**
An existing database volume was created with a different password than your `.env`.
Either set `POSTGRES_PASSWORD` in `.env` to the old password, or reset the database
(**this deletes all data**):

```powershell
docker compose down -v
docker compose up -d --build db ml-service backend
```

**ML service returns 503 `MODEL_NOT_LOADED`**
No trained model is present. Run the training step in Quick Start step 3, then restart:

```powershell
docker compose restart ml-service
```

**Port already in use (5173 / 8080 / 8000 / 5432)**
Stop the conflicting process, or change the port in `docker-compose.yml` and the matching
URL in `.env`.

**Frontend loads but API calls fail**
Confirm the backend is healthy at http://localhost:8080/actuator/health. The frontend
defaults to `http://localhost:8080` and `http://localhost:8000`.

**PowerShell blocks the startup script**
Run it with an explicit policy:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-all.ps1
```

---

## Project structure

```
climate/
├─ frontend/      React + Vite + Tailwind + Leaflet + three.js + Recharts
├─ backend/       Spring Boot REST API (:8080), Postgres/PostGIS persistence
├─ ml-service/    FastAPI risk + flow-path + heightmap service (:8000)
├─ database/      Postgres/PostGIS schema and migrations
├─ docs/          API contract, architecture, data dictionary, training guide
├─ docker-compose.yml
└─ start-all.ps1  One-command Windows startup
```

---

## Docs

- [API contract](docs/api-contract.md)
- [Architecture](docs/architecture.md)
- [Data dictionary](docs/data-dictionary.md)
- [Training guide](docs/training-guide.md)
- [Implementation plan](docs/implementation-plan.md)

---

## Disclaimer

FloodShield AI provides planning-grade flood risk estimates. It is not a substitute for
site surveys, hydrological modelling, or a licensed engineer's assessment.
