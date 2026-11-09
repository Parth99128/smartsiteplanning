# FloodShield AI — Master Build Prompt (Enhanced Edition)
*Paste this entire prompt into your AI coding agent (Claude Code, Cursor, etc.) to build the project end-to-end.*

---

## 0. PROJECT VISION

Build **FloodShield AI** — a pre-construction flood risk and resilience planning platform that lets a planner enter a proposed site, see its flood risk explained visually (including in **3D**), simulate design changes in real time, and export a defensible report.

The differentiator versus a generic "risk score dashboard" hackathon project: **you can see the water move across the terrain in 3D before a single brick is laid**, and the system explains *why* a score changed in plain language, not just a number.

Do not build a fake UI with non-functional buttons. Every screen must be wired to a real backend call (demo data is fine; fake wiring is not). Never claim the system provides certified engineering, flood-safety, or construction-approval decisions — everything is a labeled prototype/estimate.

---

## 1. UNIQUE DIFFERENTIATORS (build these — they are the point of the project, not extras)

1. **3D Digital Twin Water-Flow Visualization** — an interactive 3D terrain of the site with animated particles that flow downhill along the detected drainage path, and the proposed building rendered as a 3D extrusion so you can *see* if it blocks the flow. This is the headline feature — see Section 5.
2. **Before/After 3D Comparison** — toggle between "current design" and "recommended design" and watch the flow path and flood risk re-render live in the same 3D scene.
3. **Climate Scenario Toggle** — a slider for rainfall intensity (+0%, +10%, +25%, representing near-term climate projections) that recalculates risk score live, showing the site isn't just safe "today."
4. **Explainable AI Advisory Panel** — a grounded Q&A panel (not a generic chatbot) that answers questions like "why is my risk score 68?" by referencing the actual feature-contribution output of the Random Forest model for that project.
5. **Multi-Site Comparison Mode** — evaluate 2–3 candidate plots side by side on the same risk/resilience metrics, for planners still choosing a site.
6. **Indicative Cost-vs-Benefit Slider** — for each recommended intervention (rain garden, elevated plinth, permeable paving), show a rough relative cost band vs. resilience-score gain, clearly labeled "indicative, not a quotation."
7. **Resilience Badge System** — Bronze/Silver/Gold/Platinum badge based on resilience score, for an immediate visual takeaway (useful for judges/non-technical stakeholders).
8. **Shareable Read-Only Report Link** — a public, no-login link to a rendered version of the final report, separate from the editable project.

---

## 2. FULL TECH STACK

**Frontend**
- React.js + Vite
- Tailwind CSS
- Leaflet + React-Leaflet (2D geospatial map, site selection, drainage overlay)
- **Three.js + @react-three/fiber + @react-three/drei** (3D terrain + water-flow visualization — new)
- Framer Motion (transitions, score-change animations)
- Recharts (analytics, risk breakdown, before/after charts)
- Zustand or React Context (app state — project, simulation state)

**Backend**
- Java Spring Boot, REST APIs, Maven
- WebSocket endpoint (optional but recommended) for pushing live simulation recalculation results to the 3D scene without full page reloads

**Database**
- PostgreSQL + PostGIS

**AI/ML**
- Python, Pandas, NumPy, Scikit-learn
- Random Forest for the flood-risk model
- A lightweight **slope/gradient-descent flow-path algorithm** (NumPy-based) that generates the drainage vector path AND a heightmap grid — this same data feeds both the 2D Leaflet overlay and the 3D terrain mesh
- Exposed as a REST API (Flask or FastAPI)

**Reporting**
- PDF/JSON export. For the PDF, capture a static PNG snapshot of the 3D scene (canvas `toDataURL()`) and embed it — PDFs can't be interactive, so don't try to fake that.

---

## 3. ARCHITECTURE OVERVIEW

```
/frontend        React/Vite/Tailwind + Leaflet + R3F(Three.js) + Recharts
/backend         Spring Boot REST API (Maven)
/ml-service      Python REST service: risk model + flow-path/heightmap generator
/database        PostgreSQL + PostGIS schema & migrations
/docs            API contracts, architecture diagram, data dictionary
```

Frontend → Spring Boot → PostgreSQL/PostGIS, and Spring Boot → Python ML service → returns risk score + heightmap + flow-path geometry → Spring Boot persists results → frontend renders both the 2D map and the 3D scene from the same stored geometry (single source of truth — do not compute flow paths twice).

---

## 4. BUILD ORDER (verify each phase works before starting the next)

**Phase 1 — Foundation**: monorepo scaffold, all four services running and able to talk to each other, env config, CORS.

**Phase 2 — Database**: schema for users/projects, project sites, environmental factors, flood history, drainage paths, **heightmap grids**, risk assessments, construction designs, recommendations, interventions, simulation results, resilience scores. Proper FKs, indexes, geospatial columns.

**Phase 3 — Site Analysis**: project creation form (name, location, site area, footprint, floors, built-up %, green/permeable area, soil type, drainage info), Leaflet map for site selection, backend CRUD APIs.

**Phase 4 — Flood Risk Engine**: Random Forest model using rainfall intensity, elevation, slope, distance from water/drainage, drainage density/capacity, soil infiltration, impervious %, historical flood occurrence, proposed footprint. Return risk score (0–100), risk level, top factors, and per-feature contribution values (needed later for the Advisory Panel). Use clearly-separated demo data if real datasets aren't available.

**Phase 5 — Natural Water-Flow Detection + Heightmap Generation**: generate a demo elevation grid for the site (Perlin-noise-based if no real DEM), run a slope/gradient-descent path algorithm to trace the natural drainage path, detect footprint intersection, and **export this as a heightmap JSON + flow-path polyline** — this exact payload will be consumed by both the Leaflet overlay (Phase 3 map) and the 3D scene (Phase 5B, below). Flag: intersects drainage path, low elevation, high runoff, high impervious %, insufficient drainage capacity, flood-prone location.

**Phase 5B — 3D Terrain & Water-Flow Scene (the headline feature)**
- Build a React-Three-Fiber scene that consumes the heightmap JSON from Phase 5 and renders it as a displaced plane geometry (real terrain shape, not a flat square).
- Render the flow path as an animated particle stream (`InstancedMesh` or a shader-based trail) moving downhill along the traced path.
- Extrude the proposed building footprint as a 3D box on the terrain at the correct site position; color it red if it intersects the flow path, green if clear.
- Add orbit controls (`@react-three/drei`'s `OrbitControls`), a day/dusk lighting toggle for readability, and a legend overlay (elevation gradient, flow direction arrow).
- This scene must re-render from the *same* API response used by the simulator in Phase 7 — don't hardcode a separate demo scene.

**Phase 6 — AI Recommendation Engine**: for every flagged risk, generate an intervention with problem detected, recommended action, reason, expected effect, priority. No unsupported engineering guarantees — label everything as a prototype estimate.

**Phase 7 — What-If Design Simulator**: sliders/inputs for footprint, built-up %, green area, permeable area, drainage corridor, rain garden, recharge structures, stormwater storage, plinth elevation. On change, recalculate risk via the ML service and update: (a) the Recharts before/after comparison, and (b) the **same 3D scene from Phase 5B**, so the user watches the building/flow relationship change in 3D as they adjust the design. Include the Climate Scenario Toggle (rainfall +0/+10/+25%) here.

**Phase 8 — Resilience Score**: 0–100 score from site selection, drainage, water storage, permeability, elevation, green infrastructure. Display via dashboard cards, a radial gauge chart, and the Bronze/Silver/Gold/Platinum badge.

**Phase 9 — Main Dashboard**: project overview, 2D map, 3D scene (collapsible/expandable panel), risk score, resilience score, risk factors, red flags, recommendations, analytics, before/after comparison. Clean data visualization, not decoration for its own sake.

**Phase 10 — Site Plan Overlay**: simple 2D site-plan editor (building, road, parking, green area, drainage, open space) overlaid with the detected flow path; highlight conflicts.

**Phase 11 — AI Advisory Panel**: a Q&A panel where the user can ask things like "why is this risky" or "what does moving the building 10m help with," and the answer is generated *from the stored feature-contribution and recommendation data for that specific project* — not a generic canned response.

**Phase 12 — Multi-Site Comparison Mode**: let a user open 2–3 saved projects side by side with synced metric cards (and, if time allows, side-by-side mini 3D scenes).

**Phase 13 — Reporting**: "Generate Report" containing project info, site analysis, risk score, factors, map snapshot, **3D scene snapshot**, red flags, recommendations, before/after design, resilience score, cost-vs-benefit summary, technical assumptions, and model limitations. PDF + JSON export. Include the shareable read-only public link.

**Phase 14 — Final UI/UX & Demo Mode**: responsive, modern, government/planning-appropriate visual language (see Section 6). Loading/error/empty states, form validation, toast notifications, API error handling. One-click demo mode that walks through: select site → analyze → detect risk factors → show 3D drainage path → detect conflict → generate recommendations → apply interventions → run what-if simulation in 3D → show improved resilience + badge upgrade → generate final report.

---

## 5. VISUAL DESIGN DIRECTION

- Palette: a calm, credible "planning department" feel — deep blue/teal for water and risk elements, warm amber/red reserved strictly for warnings and red flags (don't overuse red or it loses meaning), neutral grays for structure.
- Typography: one clean sans-serif for UI (e.g., Inter), numerals in a tabular/monospace variant for scores so they don't jitter when animating.
- Score changes (risk, resilience) should animate with Framer Motion rather than snapping instantly — this is what makes the what-if simulator feel alive.
- The 3D scene should have a restrained, technical look (subtle grid, elevation-gradient terrain coloring, thin flow-path lines) — avoid a "video game" aesthetic; this needs to read as a planning tool, not a toy.
- Keep the 2D Leaflet map and 3D scene visually consistent (same color coding for risk/flow/building) so a user can mentally map one to the other instantly.
- Dashboard density: prioritize 4–6 key cards above the fold; push secondary detail below or into tabs.

---

## 6. GUARDRAILS (keep from the original spec)

- Do not claim certified engineering, flood-safety, or construction-approval outcomes anywhere in the UI or reports.
- Clearly label all demo data, simulated values, and prototype estimates as such, including in the PDF report's "Technical Assumptions and Limitations" section.
- Keep demo data in a clearly separated data layer so it can be swapped for real datasets (real DEM, real rainfall/IMD data, real soil survey data) later without touching business logic.

---

## 7. INSTRUCTION TO THE AGENT

Before writing large amounts of code: produce the complete folder structure, the full database schema, the API contract (including the new heightmap/flow-path payload shape shared between the 2D map and 3D scene), and an implementation plan matching the phases above. Then implement one phase at a time, and confirm each phase works before moving to the next. Flag clearly if any requested library (e.g., `@react-three/fiber`) needs a specific pinned version to avoid breaking changes.
