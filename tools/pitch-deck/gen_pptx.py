#!/usr/bin/env python3
"""Generate the FloodShield AI hackathon pitch deck (16:9 PPTX).

Content mirrors docs/pitch-deck.md (the team's approved 10-slide structure).
Live registry stats are baked in as evidence the system runs on real data.
Re-run any time: python tools/pitch-deck/gen_pptx.py
Output: docs/FloodShieldAI-PitchDeck.pptx
"""
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Pt

BG = RGBColor(0x0B, 0x15, 0x26)
TEAL = RGBColor(0x22, 0xD3, 0xEE)
AMBER = RGBColor(0xFB, 0xBF, 0x24)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
MUTED = RGBColor(0x94, 0xA3, 0xB8)
GREEN = RGBColor(0x34, 0xD3, 0x99)

prs = Presentation()
prs.slide_width = Emu(12192000)
prs.slide_height = Emu(6858000)
BLANK = prs.slide_layouts[6]


def bg(slide):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = BG


def box(slide, l, t, w, h):
    from pptx.enum.shapes import MSO_SHAPE
    shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(l), Emu(t), Emu(w), Emu(h))
    shp.line.fill.background()
    return shp


def text(slide, l, t, w, h, runs, size=20, bold=False, color=WHITE, align=PP_ALIGN.LEFT):
    """runs: str or list of (text, {bold, color, size}) segments."""
    tb = slide.shapes.add_textbox(Emu(l), Emu(t), Emu(w), Emu(h))
    tf = tb.text_frame
    tf.word_wrap = True
    if isinstance(runs, str):
        runs = [(runs, {})]
    for i, (txt, fmt) in enumerate(runs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run()
        r.text = txt
        r.font.size = Pt(fmt.get("size", size))
        r.font.bold = fmt.get("bold", bold)
        r.font.color.rgb = fmt.get("color", color)
    return tb


def title_slide(title, kicker=None, sub=None):
    s = prs.slides.add_slide(BLANK)
    bg(s)
    if kicker:
        text(s, 600000, 900000, 10900000, 600000, kicker, size=20, color=TEAL, bold=True)
    text(s, 600000, 1700000, 10900000, 1500000, title, size=44, bold=True)
    if sub:
        text(s, 600000, 3400000, 10900000, 2500000, sub, size=20, color=MUTED)
    return s


def bullets(slide, items, top=2200000, size=20):
    y = top
    for it in items:
        text(slide, 900000, y, 10300000, 700000, [("•  ", {"color": TEAL, "bold": True}), (it, {})], size=size)
        y += 800000


W = 12192000
# 1 — Title
s = title_slide("FloodShield AI", kicker="PRE-CONSTRUCTION FLOOD RISK & RESILIENCE PLANNER",
                sub="Predict. Redesign. Prevent.\n\nDon't build first and mitigate later — predict, redesign and flood-proof before construction begins.")
text(s, 600000, 5600000, 10900000, 600000, "Team + members  |  Live demo: pin → risk → redesign → safer plan", size=16, color=MUTED)

# 2 — Problem
s = title_slide("Flood risk begins BEFORE construction", sub="Urban expansion → impervious surface → runoff → drainage stress → urban flooding.\nCurrent systems monitor and respond. Fixing a blocked drain after construction costs crores — moving a line on a plan costs nothing.")
bullets(s, ["Construction blocks natural flow paths, kills infiltration, overloads storm drains",
            "After handover, retrofit is 10–50× costlier than a planning-stage change",
            "Gap: flood maps show WHERE water goes — none tell you HOW to build differently"], top=4200000, size=17)

# 3 — Comparison
s = title_slide("Why existing approaches are not enough")
rows = [("Traditional", "FloodShield AI"),
        ("Detect flooding", "Prevent / reduce risk"),
        ("Static flood maps", "Construction-aware analysis"),
        ("Existing conditions", "Evaluates the PROPOSED development"),
        ("Shows a risk number", "Recommends exact interventions"),
        ("Reactive", "Preventive + what-if simulation")]
y = 2000000
for a, b in rows:
    bold = a == "Traditional"
    text(s, 900000, y, 5000000, 500000, a, size=18, bold=bold, color=TEAL if bold else WHITE)
    text(s, 6200000, y, 5000000, 500000, b, size=18, bold=bold, color=AMBER if bold else WHITE)
    y += 700000

# 4 — Solution
s = title_slide("Our solution",
                sub="PROPOSED SITE → SITE ANALYSIS → FLOOD RISK MODEL → PROBLEM DETECTION → AI RECOMMENDATIONS → DESIGN SIMULATOR → SAFER DESIGN")
text(s, 600000, 4200000, 10900000, 1200000,
     'From "where will flooding happen?"  to  "how should we build differently?"', size=24, bold=True, color=TEAL)

# 5 — How it works (with REAL evidence)
s = title_slide("How it works — on real data, not just prediction")
bullets(s, ["12 factors: rainfall, elevation, slope, drain distance, drainage density, soil, impervious %, footprint, flood history, plinth, land-use change, catchment",
            "Random-Forest risk engine (12 features) + gradient-descent flow tracer over measured 30 m DEM",
            "LIVE REGISTRY: 148,365 municipal drains across Chennai (10,270), Bengaluru (6,809), Pune (131,286) + 24,421 chambers",
            "85% of segments carry MEASURED invert levels — physics (Manning) cross-checks the ML score",
            "Single source of truth: 2D map + 3D twin render the same stored PostGIS payload"], top=2300000, size=16)

# 6 — Innovations
s = title_slide("More than a flood map")
innov = [("🗺️ Natural flow detection", "traced drainage paths + building-intersection flags on real DEM"),
         ("🧭 Shift guidance", '"Move the building 18 m north-east" — nearest-clear placement, one click to apply'),
         ("🤖 AI recommendations", "site-specific mitigations with map placement + cost bands + BOQ"),
         ("🔄 What-if + schemes", "sliders, presets, climate uplift, save/compare/apply A/B/C designs"),
         ("🏗️ Resilience + compliance", "6-parameter badge + no-waterlogging sheet + basement & drain designers")]
y = 2100000
for t, d in innov:
    text(s, 900000, y, 10300000, 700000, [(t + "  ", {"bold": True, "color": TEAL}), (d, {"color": MUTED})], size=18)
    y += 850000

# 7 — Demo story
s = title_slide("Demo: the 60-second story")
steps = ["1. Developer drops a pin → residential complex, 800 m² footprint",
         "2. System: HIGH risk 78 — building sits ON the traced drainage path",
         "3. Banner: 'Move the building 18 m north-east' → one click, block shifts",
         "4. Simulator: permeable + storage + plinth → risk 78 → 54, badge Silver → Gold",
         "5. Report: compliance sheet + BOQ + shareable link — the climax: red turns green LIVE"]
bullets(s, steps, top=2200000, size=19)

# 8 — Tech
s = title_slide("Technology (boring on purpose — demo is the star)")
bullets(s, ["Frontend: React + Leaflet + Three.js (2D map + 3D digital twin from one payload)",
            "Backend: Spring Boot REST · Database: PostgreSQL + PostGIS (148k drain geometries)",
            "AI: Python + scikit-learn Random Forest + Manning hydraulics cross-check",
            "Deployed: Docker (db :5432 · ml :8000 · api :8080 · app :5173), health-checked"], top=2300000, size=18)

# 9 — Impact
s = title_slide("Impact")
bullets(s, ["🏗️ Developers: catch a blocked drain before the foundation is poured",
            "🏙️ Planners: evaluate proposals on measured evidence, not PDFs",
            "🌱 Environment: natural corridors + infiltration preserved by design",
            "👨‍👩‍👧 Communities: fewer flooded streets, basements and ground floors",
            "Prevention is cheaper and safer when it happens before construction. (No invented savings figures.)"],
         top=2200000, size=18)

# 10 — Vision
s = title_slide("From flood maps → climate-resilient construction",
                sub="Next: real-time rainfall re-scoring · IoT water-level sensors · BIM integration · municipal sanction support · multi-hazard (heat + landslide)")
text(s, 600000, 5400000, 10900000, 800000, '"Build for the future, not for the last flood."', size=26, bold=True, color=AMBER)

out = "docs/FloodShieldAI-PitchDeck.pptx"
prs.save(out)
print(f"saved {out} ({prs.slides.__len__()} slides)")
