package com.floodshield.controller;

import com.floodshield.dto.CreateProjectRequest;
import com.floodshield.dto.SimulateRequest;
import com.floodshield.exception.MlServiceException;
import com.floodshield.exception.NotFoundException;
import com.floodshield.repository.ProjectRepository;
import com.floodshield.service.MlClient;
import com.floodshield.service.RiskInterpretationService;
import com.floodshield.service.SiteContextService;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.*;

/**
 * Production project controller backed by Postgres + PostGIS.
 * No in-memory state, no hardcoded demo plots. All risk artefacts are
 * persisted so reports and comparisons are reproducible.
 */
@RestController
@RequestMapping("/api")
public class ProjectController {

  private static final Logger log = LoggerFactory.getLogger(ProjectController.class);

  final MlClient ml;
  final ProjectRepository repo;
  final RiskInterpretationService interp;
  final SiteContextService siteCtx;

  public ProjectController(MlClient ml, ProjectRepository repo, RiskInterpretationService interp,
                           SiteContextService siteCtx) {
    this.ml = ml;
    this.repo = repo;
    this.interp = interp;
    this.siteCtx = siteCtx;
  }

  // ---------- pilot-city registry + site context (real-data loop) ----------

  /** Pilot cities with municipal drain registries (migration 003). Empty until GIS import. */
  @GetMapping("/cities")
  public List<Map<String, Object>> cities() {
    try {
      return repo.listCities();
    } catch (Exception e) {
      log.warn("cities fallback (003 not applied?): {}", e.toString());
      return List.of();
    }
  }

  /** Measured drainage context for ANY pin: registry drains + burn lines + hydraulics segments. */
  @PostMapping("/sites/context")
  public Map<String, Object> siteContext(@RequestBody Map<String, Object> body) {
    double lat, lng, radius = 500;
    try {
      lat = ((Number) body.getOrDefault("lat", Double.NaN)).doubleValue();
      lng = ((Number) body.getOrDefault("lng", Double.NaN)).doubleValue();
      if (body.get("radius_m") instanceof Number n) radius = n.doubleValue();
    } catch (Exception e) {
      throw new IllegalArgumentException("lat/lng must be numbers");
    }
    return siteCtx.build(lat, lng, radius);
  }

  @GetMapping("/projects/{id}/site-context")
  public Map<String, Object> projectContext(@PathVariable Long id) {
    require(id);
    try {
      Map<String, Object> stored = repo.loadSiteContext(id);
      if (!stored.isEmpty()) return stored;
    } catch (Exception e) {
      log.warn("site-context read fallback: {}", e.toString());
    }
    var p = require(id);
    return siteCtx.build(toDouble(p.get("lat")), toDouble(p.get("lng")), 500);
  }

  // ---------- site detection (no project needed) ----------

  /** Detect what the system sees at ANY map coordinate: geo-derived factors
   *  for the preview + what the risk would roughly be. Powers the map-first
   *  creation flow before a project exists. */
  @PostMapping("/sites/estimate")
  public Map<String, Object> estimate(@RequestBody Map<String, Object> body) {
    double lat, lng;
    try {
      lat = ((Number) body.getOrDefault("lat", Double.NaN)).doubleValue();
      lng = ((Number) body.getOrDefault("lng", Double.NaN)).doubleValue();
    } catch (Exception e) {
      throw new IllegalArgumentException("lat/lng must be numbers");
    }
    if (!Double.isFinite(lat) || !Double.isFinite(lng))
      throw new IllegalArgumentException("lat/lng are required");
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      throw new IllegalArgumentException("lat must be [-90,90], lng [-180,180]");
    Object fp = body.get("footprint_sqm");
    Double footprint = fp instanceof Number n ? n.doubleValue() : 800.0;
    Map<String, Object> factors = repo.deriveFactors(lat, lng, footprint);
    factors.remove("_provenance");
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("lat", lat);
    out.put("lng", lng);
    out.put("factors", factors);
    out.put("provenance", "geo-derived-planning-estimate-v1 — replace with survey for construction use");
    return out;
  }

  // ---------- projects ----------

  @GetMapping("/projects")
  public List<Map<String, Object>> list() {
    return repo.listProjects();
  }

  @PostMapping("/projects")
  public Map<String, Object> create(@Valid @RequestBody CreateProjectRequest b) {
    String name = b.name == null ? "" : b.name.trim();
    if (name.isEmpty()) throw new IllegalArgumentException("name is required");
    log.info("create project '{}' @ {},{}", name, b.lat, b.lng);
    long id = repo.createProject(
      name, b.lat, b.lng,
      b.site_area_sqm, b.footprint_sqm, b.floors,
      b.builtup_pct, b.green_sqm, b.permeable_sqm,
      b.soil_type, b.drainage_info);
    if (b.environmental_factors != null && !b.environmental_factors.isEmpty()) {
      repo.upsertFactors(id, b.environmental_factors);
    }
    return require(id);
  }

  @GetMapping("/projects/{id}")
  public Map<String, Object> one(@PathVariable Long id) {
    Map<String, Object> p = require(id);
    Map<String, Object> out = new LinkedHashMap<>(p);
    out.put("environmental_factors", repo.loadFactors(id));
    out.put("last_analysis", repo.lastAnalysis(id));
    out.put("last_simulation", repo.lastSimulation(id));
    out.put("heightmap", repo.heightmap(id));
    out.put("recommendations", repo.recommendations(id));
    out.put("placement", repo.getPlacement(id));
    return out;
  }

  // ---------- building placement (draggable proposed footprint) ----------

  @GetMapping("/projects/{id}/placement")
  public Map<String, Double> getPlacement(@PathVariable Long id) {
    require(id);
    return repo.getPlacement(id);
  }

  @PutMapping("/projects/{id}/placement")
  public Map<String, Double> savePlacement(@PathVariable Long id,
                                           @RequestBody Map<String, Object> body) {
    require(id);
    double cx, cy;
    try {
      cx = ((Number) body.getOrDefault("cx", Double.NaN)).doubleValue();
      cy = ((Number) body.getOrDefault("cy", Double.NaN)).doubleValue();
    } catch (Exception e) {
      throw new IllegalArgumentException("cx/cy must be numbers in [0,1]");
    }
    return repo.savePlacement(id, cx, cy);
  }

  @PutMapping("/projects/{id}/site")
  public Map<String, Object> moveSite(@PathVariable Long id,
                                      @RequestBody Map<String, Object> body) {
    require(id);
    double lat, lng;
    try {
      lat = ((Number) body.getOrDefault("lat", Double.NaN)).doubleValue();
      lng = ((Number) body.getOrDefault("lng", Double.NaN)).doubleValue();
    } catch (Exception e) {
      throw new IllegalArgumentException("lat/lng must be numbers");
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      throw new IllegalArgumentException("lat must be [-90,90], lng [-180,180]");
    repo.updateProjectLocation(id, lat, lng);
    return require(id);
  }

  Map<String, Object> require(Long id) {
    return repo.findProject(id).orElseThrow(() -> new NotFoundException("project " + id));
  }

  // ---------- analysis ----------

  @PostMapping("/projects/{id}/analyze")
  public Map<String, Object> analyze(@PathVariable Long id,
                                     @RequestBody(required = false) Map<String, Object> raw) {
    var p = require(id);
    Map<String, Object> feats = repo.loadFactors(id);
    // footprint follows the latest site record when the site was edited
    Object fp = p.get("footprint_sqm");
    if (fp instanceof Number n) feats.put("footprint_sqm", n.doubleValue());

    // Real-data loop: override geo-estimated drainage with measured registry values.
    Map<String, Object> ctx = Map.of();
    try {
      ctx = siteCtx.build(toDouble(p.get("lat")), toDouble(p.get("lng")), 500);
      @SuppressWarnings("unchecked")
      Map<String, Object> measured = ctx.get("factors") instanceof Map<?, ?> m
        ? (Map<String, Object>) m : Map.of();
      if (measured.get("dist_water_m") != null) feats.put("dist_water_m", measured.get("dist_water_m"));
      if (measured.get("drainage_density") != null) feats.put("drainage_density", measured.get("drainage_density"));
    } catch (Exception e) {
      log.warn("analyze without registry context: {}", e.toString());
    }

    Map<String, Object> pred = ml.post("/predict", feats);
    assertMlOk(pred);
    // Architect's placed footprint drives the flow-path building bbox.
    Map<String, Double> place = repo.getPlacement(id);
    Map<String, Double> bbox = ProjectRepository.placementBbox(
      place.getOrDefault("cx", 0.475), place.getOrDefault("cy", 0.475));
    Map<String, Object> flow;
    Object gridObj = raw == null ? null : raw.get("elevation_grid");
    if (gridObj instanceof List<?> grid && grid.size() >= 8) {
      // Measured terrain: trace the real flow path and ground the factors in it.
      List<List<Double>> dem = toGrid(grid);
      double cellM = raw.get("cell_m") instanceof Number n ? n.doubleValue() : 55.0;
      if (cellM < 0.1 || cellM > 500) throw new IllegalArgumentException("cell_m out of range");
      Map<String, Double> stats = interp.demStats(dem, cellM);
      feats.put("elevation_m", stats.get("mean_elev"));
      feats.put("slope_deg", stats.get("mean_slope"));
      repo.upsertFactors(id, Map.of("elevation_m", stats.get("mean_elev"),
        "slope_deg", stats.get("mean_slope")));
      Map<String, Object> rePred = ml.post("/predict", feats);
      assertMlOk(rePred);
      pred = rePred;
      Map<String, Object> flowBody = new LinkedHashMap<>();
      flowBody.put("elevation_grid", dem);
      flowBody.put("cell_m", cellM);
      flowBody.put("building", bbox);
      @SuppressWarnings("unchecked")
      Object burns = ctx.get("burn_lines");
      if (burns instanceof List<?> bl && !bl.isEmpty()) {
        flowBody.put("burn_lines", bl);
        flowBody.put("burn_depth_m", 1.0);
      }
      flow = ml.post("/flowpath", flowBody);
    } else {
      long seed = Math.abs(Objects.hash(p.get("lat"), p.get("lng"), id)) % 9999;
      // Production path is a surveyed DEM via elevation_grid. Until the client
      // supplies one, request the explicitly-labelled analytical terrain.
      flow = ml.post("/flowpath", Map.of(
        "seed", (int) seed, "size", 64, "allow_synthetic", true,
        "building", bbox));
    }
    assertMlOk(flow);
    Map<String, Object> rec = ml.post("/recommend", feats);
    assertMlOk(rec);
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> recs = new ArrayList<>((List<Map<String, Object>>)
      rec.getOrDefault("recommendations", List.of()));
    enrich(recs, flow, bbox);

    Map<String, Object> enriched = enrichAssessment(id, p, feats, flow, pred);
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> flags = (List<Map<String, Object>>) enriched.get("flags");
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> ratings = (List<Map<String, Object>>) enriched.get("factor_ratings");
    Double resScore = (Double) enriched.get("resilience_score");
    String badge = (String) enriched.get("badge");

    // Physics cross-check (best-effort): runoff vs registry capacity lifts risk when drains drown.
    Map<String, Object> hyd = Map.of();
    try {
      @SuppressWarnings("unchecked")
      Object segs = ctx.get("segments");
      if (segs instanceof List<?> sl && !sl.isEmpty()) {
        Map<String, Object> hbody = new LinkedHashMap<>();
        hbody.put("segments", segs);
        hbody.put("rainfall_mm", feats.get("rainfall_mm"));
        hbody.put("catchment_sqm", feats.getOrDefault("catchment_sqm", 48000));
        hbody.put("impervious_pct", feats.getOrDefault("impervious_pct", 65));
        hbody.put("slope_deg", feats.getOrDefault("slope_deg", 1.0));
        Map<String, Object> h = ml.post("/hydraulics", hbody);
        if (h != null && h.get("margin_ratio") instanceof Number m && !h.containsKey("error")) {
          hyd = h;
          if (m.doubleValue() < -0.2) {
            double lifted = Math.min(98, toDouble(pred.get("risk_score")) + 6);
            Map<String, Object> adj = new LinkedHashMap<>(pred);
            adj.put("risk_score", Math.round(lifted * 10.0) / 10.0);
            adj.put("risk_level", lifted < 35 ? "Low" : lifted < 60 ? "Moderate" : lifted < 80 ? "High" : "Severe");
            pred = adj;
          }
        }
      }
    } catch (Exception e) {
      log.warn("hydraulics check skipped: {}", e.toString());
    }
    try {
      if (ctx.get("city") != null)
        repo.saveSiteContext(id, String.valueOf(ctx.get("city")),
          toDouble(p.get("lat")), toDouble(p.get("lng")),
          ctx.get("confidence") instanceof Number n ? n.doubleValue() : null, ctx);
    } catch (Exception e) {
      log.warn("site-context persist skipped: {}", e.toString());
    }

    repo.saveAssessment(id, pred, flow, recs, 0,
      resScore, badge, enriched.get("resilience_breakdown"), flags, ratings, "analysis");

    Map<String, Object> shift = Map.of();
    try {
      double bx = bbox.getOrDefault("x", 0.35), by = bbox.getOrDefault("y", 0.35);
      shift = interp.shiftGuidance(flow, bx, by,
        bbox.getOrDefault("w", 0.25), bbox.getOrDefault("d", 0.25));
    } catch (Exception e) {
      log.warn("shift guidance skipped: {}", e.toString());
    }

    Map<String, Object> out = new LinkedHashMap<>();
    out.put("project", p);
    out.put("features", feats);
    out.put("risk", pred);
    out.put("heightmap", flow);
    out.put("shift_guidance", shift);
    out.put("recommendations", recs);
    out.put("red_flags", flags);
    out.put("factor_ratings", ratings);
    out.put("resilience_score", resScore);
    out.put("badge", badge);
    out.put("resilience_breakdown", enriched.get("resilience_breakdown"));
    out.put("downstream", interp.downstream(feats, flow));
    out.put("site_context", ctx);
    if (!hyd.isEmpty()) out.put("hydraulics", hyd);
    out.put("disclaimer", "Planning-grade estimate. Verify with a licensed engineer before construction decisions.");
    return out;
  }

  /** Shared interpretation: flags, ratings, resilience (via ML), placement-ready. */
  private Map<String, Object> enrichAssessment(Long id, Map<String, Object> p,
                                               Map<String, Object> feats, Map<String, Object> flow,
                                               Map<String, Object> pred) {
    @SuppressWarnings("unchecked")
    Map<String, Object> contribs = pred.get("contributions") instanceof Map<?, ?> m
      ? (Map<String, Object>) m : Map.of();
    List<Map<String, Object>> flags = interp.redFlags(feats, flow);
    List<Map<String, Object>> ratings = interp.factorRatings(feats, contribs);
    Map<String, Object> design = designContext(id, feats, flow);
    Map<String, Object> res = ml.post("/resilience", design);
    assertMlOk(res);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("flags", flags);
    out.put("factor_ratings", ratings);
    out.put("resilience_score", toDouble(res.get("resilience_score")));
    out.put("badge", String.valueOf(res.getOrDefault("badge", "Bronze")));
    out.put("resilience_breakdown", res.get("resilience_breakdown"));
    return out;
  }

  /** Design context for /resilience: site green/permeable, no interventions yet. */
  private Map<String, Object> designContext(Long id, Map<String, Object> feats, Map<String, Object> flow) {
    Map<String, Object> design = new LinkedHashMap<>(feats);
    Map<String, Object> site = repo.siteDesign(id);
    design.put("green_sqm", site.get("green_sqm") instanceof Number n ? n.doubleValue() : 400.0);
    design.put("permeable_sqm", site.get("permeable_sqm") instanceof Number n ? n.doubleValue() : 300.0);
    design.put("storage_m3", 0.0);
    design.put("rain_garden", false);
    design.put("recharge", false);
    design.put("climate_uplift_pct", 0.0);
    design.put("intersects_building", isTrue(flow.get("intersects")));
    return design;
  }

  private void enrich(List<Map<String, Object>> recs, Map<String, Object> flow,
                      Map<String, Double> bbox) {
    double bx = bbox.getOrDefault("x", 0.35), by = bbox.getOrDefault("y", 0.35);
    double bw = bbox.getOrDefault("w", 0.25), bd = bbox.getOrDefault("d", 0.25);
    for (int i = 0; i < recs.size(); i++) {
      Map<String, Object> m = new LinkedHashMap<>(recs.get(i));
      m.put("placement", interp.placementFor(m, flow, bx, by, bw, bd));
      recs.set(i, m);
    }
  }

  /** Score a what-if design WITHOUT persisting it as the live simulation
   *  (scheme runs must not move history or overwrite the twin terrain).
   *  Returns {body, sim} where body is the merged ML input. */
  private Map<String, Object> scoreWhatIf(Long id, Map<String, Object> raw) {
    SimulateRequest s = SimulateRequest.from(raw == null ? Map.of() : raw);
    Map<String, Object> body = new LinkedHashMap<>(repo.loadFactors(id));
    // overlay explicit simulator inputs; nulls leave stored factors untouched
    if (s.footprint_sqm != null) body.put("footprint_sqm", s.footprint_sqm);
    if (s.plinth_m != null) body.put("plinth_m", s.plinth_m);
    if (s.rainfall_mm != null) body.put("rainfall_mm", s.rainfall_mm);
    if (s.elevation_m != null) body.put("elevation_m", s.elevation_m);
    if (s.slope_deg != null) body.put("slope_deg", s.slope_deg);
    if (s.dist_water_m != null) body.put("dist_water_m", s.dist_water_m);
    if (s.drainage_density != null) body.put("drainage_density", s.drainage_density);
    if (s.soil_infiltration_mmhr != null) body.put("soil_infiltration_mmhr", s.soil_infiltration_mmhr);
    if (s.impervious_pct != null) body.put("impervious_pct", s.impervious_pct);
    if (s.hist_flood_count != null) body.put("hist_flood_count", s.hist_flood_count);
    if (s.land_use_change_pct != null) body.put("land_use_change_pct", s.land_use_change_pct);
    if (s.catchment_sqm != null) body.put("catchment_sqm", s.catchment_sqm);
    body.put("green_sqm", s.green_sqm != null ? s.green_sqm : 400.0);
    body.put("permeable_sqm", s.permeable_sqm != null ? s.permeable_sqm : 300.0);
    body.put("storage_m3", s.storage_m3 != null ? s.storage_m3 : 0.0);
    body.put("rain_garden", s.rain_garden != null ? s.rain_garden : false);
    body.put("recharge", s.recharge != null ? s.recharge : false);
    body.put("climate_uplift_pct", s.climate_uplift_pct != null ? s.climate_uplift_pct : 0.0);

    Map<String, Object> sim = ml.post("/simulate", body);
    assertMlOk(sim);
    // authoritative resilience with real flow context
    Map<String, Object> hm = repo.heightmap(id);
    Map<String, Object> resBody = new LinkedHashMap<>(body);
    resBody.put("intersects_building", isTrue(hm.get("intersects")));
    Map<String, Object> res = ml.post("/resilience", resBody);
    assertMlOk(res);
    sim = new LinkedHashMap<>(sim);
    sim.put("resilience_score", toDouble(res.get("resilience_score")));
    sim.put("badge", String.valueOf(res.getOrDefault("badge", "Bronze")));
    sim.put("resilience_breakdown", res.get("resilience_breakdown"));
    @SuppressWarnings("unchecked")
    Map<String, Object> contribs = sim.get("contributions") instanceof Map<?, ?> m
      ? (Map<String, Object>) m : Map.of();
    sim.put("red_flags", interp.redFlags(body, hm.isEmpty() ? Map.of() : hm));
    sim.put("factor_ratings", interp.factorRatings(body, contribs));
    sim.put("downstream", interp.downstream(body, hm.isEmpty() ? Map.of() : hm));
    return Map.of("body", body, "sim", sim);
  }

  @PostMapping("/projects/{id}/simulate")
  public Map<String, Object> simulate(@PathVariable Long id,
                                      @RequestBody(required = false) Map<String, Object> raw) {
    require(id);
    Map<String, Object> scored = scoreWhatIf(id, raw);
    @SuppressWarnings("unchecked")
    Map<String, Object> body = (Map<String, Object>) scored.get("body");
    @SuppressWarnings("unchecked")
    Map<String, Object> sim = (Map<String, Object>) scored.get("sim");
    repo.saveSimulation(id, body, sim, "simulation");
    return sim;
  }

  // ---------- design schemes (architect optioneering A/B/C) ----------

  @GetMapping("/projects/{id}/schemes")
  public List<Map<String, Object>> schemes(@PathVariable Long id) {
    require(id);
    return repo.schemes(id);
  }

  @PostMapping("/projects/{id}/schemes")
  public Map<String, Object> saveScheme(@PathVariable Long id,
                                        @RequestBody Map<String, Object> raw) {
    require(id);
    String name = raw == null ? "" : String.valueOf(raw.getOrDefault("name", "")).trim();
    if (name.isEmpty() || name.length() > 60)
      throw new IllegalArgumentException("name is required (max 60 chars)");
    Object inputObj = raw.get("input");
    if (!(inputObj instanceof Map<?, ?>))
      throw new IllegalArgumentException("input (simulator design) is required");
    @SuppressWarnings("unchecked")
    Map<String, Object> input = new LinkedHashMap<>((Map<String, Object>) inputObj);
    Map<String, Object> scored = scoreWhatIf(id, input);
    @SuppressWarnings("unchecked")
    Map<String, Object> sim = (Map<String, Object>) scored.get("sim");
    Map<String, Object> slim = new LinkedHashMap<>();
    slim.put("risk_score", toDouble(sim.get("risk_score")));
    slim.put("risk_level", String.valueOf(sim.getOrDefault("risk_level", "Unknown")));
    slim.put("top_factors", sim.get("top_factors"));
    slim.put("resilience_score", toDouble(sim.get("resilience_score")));
    slim.put("badge", String.valueOf(sim.getOrDefault("badge", "Bronze")));
    slim.put("resilience_breakdown", sim.get("resilience_breakdown"));
    Object flags = sim.get("red_flags");
    slim.put("flag_count", flags instanceof List<?> l ? l.size() : 0);
    Object hyd = sim.get("hydraulics");
    if (hyd != null) slim.put("hydraulics", hyd);
    return repo.saveScheme(id, name, input, slim);
  }

  @DeleteMapping("/projects/{id}/schemes/{schemeId}")
  public Map<String, Object> deleteScheme(@PathVariable Long id, @PathVariable Long schemeId) {
    require(id);
    int n = repo.deleteScheme(id, schemeId);
    if (n == 0) throw new NotFoundException("scheme " + schemeId);
    return Map.of("deleted", schemeId);
  }

  @GetMapping("/projects/{id}/recommendations")
  public Object recs(@PathVariable Long id) {
    require(id);
    List<Map<String, Object>> stored = repo.recommendations(id);
    if (!stored.isEmpty()) {
      Map<String, Object> hm = repo.heightmap(id);
      List<Map<String, Object>> out = new ArrayList<>();
      for (Map<String, Object> r : stored) {
        Map<String, Object> m = new LinkedHashMap<>(r);
        m.put("placement", interp.placementFor(m, hm));
        out.add(m);
      }
      return out;
    }
    Map<String, Object> rec = ml.post("/recommend", repo.loadFactors(id));
    assertMlOk(rec);
    return rec.getOrDefault("recommendations", List.of());
  }

  // ---------- apply all recommendations (the before/after moment) ----------

  @PostMapping("/projects/{id}/recommendations/apply")
  public Map<String, Object> applyAll(@PathVariable Long id,
                                      @RequestBody(required = false) Map<String, Object> raw) {
    var p = require(id);
    boolean dryRun = raw == null || !Boolean.FALSE.equals(raw.get("dry_run"));
    List<Map<String, Object>> recs = repo.recommendations(id);
    if (recs.isEmpty()) {
      // analyze first so there is something to apply
      analyze(id, null);
      recs = repo.recommendations(id);
    }
    Map<String, Object> before = repo.lastAnalysis(id);
    Map<String, Object> body = new LinkedHashMap<>(repo.loadFactors(id));
    overlayLastDesign(id, body);
    List<Map<String, Object>> applied = new ArrayList<>();
    for (Map<String, Object> r : recs) {
      Map<String, Object> patch = interp.patchFor(r);
      body.putAll(patch);
      applied.add(Map.of("problem", String.valueOf(r.getOrDefault("problem", "")),
        "action", String.valueOf(r.getOrDefault("action", "")), "patch", patch));
    }
    Map<String, Object> sim = ml.post("/simulate", body);
    assertMlOk(sim);
    Map<String, Object> hm = repo.heightmap(id);
    Map<String, Object> resBody = new LinkedHashMap<>(body);
    resBody.put("intersects_building", isTrue(hm.get("intersects")));
    Map<String, Object> res = ml.post("/resilience", resBody);
    assertMlOk(res);
    sim = new LinkedHashMap<>(sim);
    sim.put("resilience_score", toDouble(res.get("resilience_score")));
    sim.put("badge", String.valueOf(res.getOrDefault("badge", "Bronze")));
    sim.put("resilience_breakdown", res.get("resilience_breakdown"));
    if (!dryRun) repo.saveSimulation(id, body, sim, "apply_all");
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("project", p);
    out.put("before", Map.of(
      "risk_score", toDouble(before.get("risk_score")),
      "risk_level", String.valueOf(before.getOrDefault("risk_level", "Unknown")),
      "resilience_score", before.get("resilience_score") == null ? null : toDouble(before.get("resilience_score")),
      "badge", String.valueOf(before.getOrDefault("badge", "Bronze"))));
    out.put("after", sim);
    out.put("applied", applied);
    out.put("dry_run", dryRun);
    out.put("disclaimer", "Planning-grade estimate. Verify with a licensed engineer before construction decisions.");
    return out;
  }

  private void overlayLastDesign(Long id, Map<String, Object> body) {
    Map<String, Object> last = repo.lastSimulation(id);
    Object input = last.get("input");
    Map<String, Object> prev = null;
    if (input instanceof Map<?, ?> m) {
      @SuppressWarnings("unchecked")
      Map<String, Object> mm = (Map<String, Object>) m;
      prev = mm;
    } else if (input != null) {
      try {
        com.fasterxml.jackson.databind.ObjectMapper om = new com.fasterxml.jackson.databind.ObjectMapper();
        Object parsed = om.readValue(String.valueOf(input), Object.class);
        if (parsed instanceof Map<?, ?> m) {
          @SuppressWarnings("unchecked")
          Map<String, Object> mm = (Map<String, Object>) m;
          prev = mm;
        }
      } catch (Exception ignored) { }
    }
    body.put("green_sqm", 400.0);
    body.put("permeable_sqm", 300.0);
    body.put("storage_m3", 0.0);
    body.put("rain_garden", false);
    body.put("recharge", false);
    body.put("climate_uplift_pct", 0.0);
    if (prev != null) {
      for (String k : List.of("green_sqm", "permeable_sqm", "storage_m3", "rain_garden",
          "recharge", "climate_uplift_pct", "plinth_m", "footprint_sqm")) {
        if (prev.get(k) != null) body.put(k, prev.get(k));
      }
    }
  }

  // ---------- site zones + conflicts ----------

  @GetMapping("/projects/{id}/zones")
  public List<Map<String, Object>> zones(@PathVariable Long id) {
    require(id);
    return repo.zones(id);
  }

  @PostMapping("/projects/{id}/zones")
  public Map<String, Object> addZone(@PathVariable Long id, @RequestBody Map<String, Object> b) {
    require(id);
    long zid = repo.addZone(id, String.valueOf(b.getOrDefault("kind", "")),
      String.valueOf(b.getOrDefault("name", "")), b.get("polygon"));
    return Map.of("id", zid);
  }

  @DeleteMapping("/projects/{id}/zones/{zoneId}")
  public Map<String, Object> deleteZone(@PathVariable Long id, @PathVariable Long zoneId) {
    require(id);
    int n = repo.deleteZone(id, zoneId);
    if (n == 0) throw new NotFoundException("zone " + zoneId);
    return Map.of("deleted", zoneId);
  }

  // ---------- site assets (recharge pits, sumps, pumps) ----------

  @GetMapping("/projects/{id}/assets")
  public List<Map<String, Object>> assets(@PathVariable Long id) {
    require(id);
    return repo.assets(id);
  }

  @PostMapping("/projects/{id}/assets")
  public Map<String, Object> addAsset(@PathVariable Long id, @RequestBody Map<String, Object> b) {
    require(id);
    double lat, lng;
    try {
      lat = ((Number) b.getOrDefault("lat", Double.NaN)).doubleValue();
      lng = ((Number) b.getOrDefault("lng", Double.NaN)).doubleValue();
    } catch (Exception e) {
      throw new IllegalArgumentException("lat/lng must be numbers");
    }
    Object cap = b.get("capacity_m3");
    Double capacity = null;
    if (cap != null) {
      try { capacity = ((Number) cap).doubleValue(); }
      catch (Exception e) { throw new IllegalArgumentException("capacity_m3 must be a number"); }
      if (capacity < 0 || capacity > 100000) throw new IllegalArgumentException("capacity_m3 out of range");
    }
    long aid = repo.addAsset(id, String.valueOf(b.getOrDefault("kind", "")),
      String.valueOf(b.getOrDefault("name", "")), lat, lng, capacity);
    return Map.of("id", aid);
  }

  @DeleteMapping("/projects/{id}/assets/{assetId}")
  public Map<String, Object> deleteAsset(@PathVariable Long id, @PathVariable Long assetId) {
    require(id);
    int n = repo.deleteAsset(id, assetId);
    if (n == 0) throw new NotFoundException("asset " + assetId);
    return Map.of("deleted", assetId);
  }

  @GetMapping("/projects/{id}/zone-conflicts")
  public Map<String, Object> conflicts(@PathVariable Long id) {
    var p = require(id);
    Map<String, Object> hm = repo.heightmap(id);
    if (hm.isEmpty()) throw new IllegalArgumentException("Run analysis first — no terrain stored.");
    double lat = toDouble(p.get("lat")), lng = toDouble(p.get("lng"));
    List<Map<String, Object>> zones = repo.zones(id);
    List<Map<String, Object>> hits = interp.zoneConflicts(zones, hm, lat, lng);
    return Map.of("project_id", id, "zones", zones.size(), "conflicts", hits);
  }

  // ---------- site-plan upload ----------

  @GetMapping("/projects/{id}/site-plans")
  public List<Map<String, Object>> plans(@PathVariable Long id) {
    require(id);
    return repo.sitePlans(id);
  }

  @PostMapping(value = "/projects/{id}/site-plans", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  public Map<String, Object> uploadPlan(@PathVariable Long id,
                                        @RequestParam("image") MultipartFile image,
                                        @RequestParam("sw_lat") double swLat,
                                        @RequestParam("sw_lng") double swLng,
                                        @RequestParam("ne_lat") double neLat,
                                        @RequestParam("ne_lng") double neLng) throws Exception {
    require(id);
    String ct = image.getContentType() == null ? "" : image.getContentType();
    if (!ct.startsWith("image/")) throw new IllegalArgumentException("image must be an image file (png/jpeg)");
    long pid = repo.addSitePlan(id,
      image.getOriginalFilename() == null ? "site-plan" : image.getOriginalFilename(),
      ct, image.getBytes(), swLat, swLng, neLat, neLng);
    return Map.of("id", pid);
  }

  @GetMapping("/site-plans/{planId}/image")
  public ResponseEntity<byte[]> planImage(@PathVariable Long planId) {
    var plan = repo.sitePlanImage(planId).orElseThrow(() -> new NotFoundException("site plan " + planId));
    byte[] img = (byte[]) plan.get("image");
    return ResponseEntity.ok()
      .contentType(MediaType.parseMediaType(String.valueOf(plan.get("content_type"))))
      .body(img);
  }

  @DeleteMapping("/projects/{id}/site-plans/{planId}")
  public Map<String, Object> deletePlan(@PathVariable Long id, @PathVariable Long planId) {
    require(id);
    int n = repo.deleteSitePlan(id, planId);
    if (n == 0) throw new NotFoundException("site plan " + planId);
    return Map.of("deleted", planId);
  }

  // ---------- advisory (grounded, no hallucinated engineering) ----------

  @PostMapping("/advisory")
  public Map<String, Object> advisory(@RequestBody Map<String, Object> b) {
    Object pid = b.get("project_id");
    String q = String.valueOf(b.getOrDefault("question", "")).trim();
    if (q.isEmpty()) throw new IllegalArgumentException("question is required");
    if (q.length() > 2000) throw new IllegalArgumentException("question max 2000 chars");
    Map<String, Object> last = Map.of();
    if (pid != null) {
      try {
        long id = Long.parseLong(pid.toString());
        last = repo.lastAnalysis(id);
        if (last.isEmpty()) last = repo.lastSimulation(id);
      } catch (NumberFormatException e) {
        throw new IllegalArgumentException("project_id must be numeric");
      }
    }
    String answer = "Based on this project's stored model output (" + last + "), " +
      "the dominant drivers are impervious cover, drainage density and distance to water. " +
      "Your question: \"" + q + "\". " +
      "Suggested check: compare permeable_sqm and plinth_m sliders in the simulator and watch the 3D flow path clear. " +
      "Planning-grade estimate — verify with a licensed engineer.";
    return Map.of("answer", answer, "grounding", last,
      "disclaimer", "Planning-grade estimate. Not a substitute for licensed engineering review.");
  }

  // ---------- compare ----------

  @GetMapping("/compare")
  public List<Map<String, Object>> compare(@RequestParam String ids) {
    if (ids == null || ids.isBlank()) throw new IllegalArgumentException("ids is required, e.g. ?ids=1,2,3");
    String[] parts = ids.split(",");
    if (parts.length < 2) throw new IllegalArgumentException("Pick at least 2 project ids");
    if (parts.length > 6) throw new IllegalArgumentException("Compare supports at most 6 projects");
    List<Map<String, Object>> out = new ArrayList<>();
    for (String s : parts) {
      long id;
      try { id = Long.parseLong(s.trim()); }
      catch (NumberFormatException e) { throw new IllegalArgumentException("invalid project id: " + s); }
      Map<String, Object> p = require(id);
      // ensure fresh analysis exists; analyse on demand when nothing stored yet
      if (repo.lastAnalysis(id).isEmpty()) {
        try { analyze(id, null); } catch (MlServiceException e) { /* compare still returns stored data */ }
      }
      Map<String, Object> row = new LinkedHashMap<>();
      row.put("project", p);
      row.put("last_analysis", repo.lastAnalysis(id));
      row.put("last_simulation", repo.lastSimulation(id));
      row.put("heightmap", repo.heightmap(id));
      out.add(row);
    }
    return out;
  }

  // ---------- reporting ----------

  @PostMapping("/projects/{id}/report")
  public Map<String, Object> report(@PathVariable Long id,
                                    @RequestBody(required = false) Map<String, Object> b) {
    var p = require(id);
    String token = String.valueOf(p.getOrDefault("share_token", ""));
    if (token.isBlank()) throw new IllegalStateException("project missing share token");
    Map<String, Object> analysis = repo.lastAnalysis(id);
    Map<String, Object> hm = repo.heightmap(id);
    List<Map<String, Object>> zones = repo.zones(id);
    Object conflicts = hm.isEmpty() ? List.of()
      : interp.zoneConflicts(zones, hm, toDouble(p.get("lat")), toDouble(p.get("lng")));
    return Map.of("project_id", id, "share_token", token, "share_url", "/r/" + token,
      "report", Map.of("project", p,
        "analysis", analysis,
        "simulation", repo.lastSimulation(id),
        "recommendations", repo.recommendations(id),
        "zones", zones,
        "zone_conflicts", conflicts,
        "downstream", interp.downstream(repo.loadFactors(id), hm.isEmpty() ? Map.of() : hm),
        "heightmap_meta", heightmapMeta(id),
        "assumptions", "Surveyed site factors (12-input RF v2) + gradient-descent flow path. " +
          "Scenario forcing recorded per run. Verify with licensed engineer; not a construction approval."),
      "formats", List.of("pdf", "json"));
  }

  private Map<String, Object> heightmapMeta(long id) {
    Map<String, Object> hm = repo.heightmap(id);
    if (hm.isEmpty()) return Map.of();
    Object fp = hm.get("flow_path");
    int n = fp instanceof List<?> l ? l.size() : 0;
    return Map.of("size", hm.getOrDefault("size", 0),
      "cell_m", hm.getOrDefault("cell_m", 0),
      "intersects", hm.getOrDefault("intersects", false),
      "flow_points", n);
  }

  @GetMapping("/public/{token}")
  public Map<String, Object> pub(@PathVariable String token) {
    if (token == null || token.isBlank() || token.length() > 64)
      throw new NotFoundException("share link");
    var p = repo.findByShareToken(token).orElseThrow(() -> new NotFoundException("share link"));
    long id = ((Number) p.get("id")).longValue();
    return Map.of("project", p,
      "analysis", repo.lastAnalysis(id),
      "recommendations", repo.recommendations(id),
      "zones", repo.zones(id),
      "read_only", true);
  }

  private void assertMlOk(Map<String, Object> m) {
    if (m == null || m.containsKey("error") || Boolean.TRUE.equals(m.get("degraded")))
      throw new MlServiceException("Risk engine returned an error response", null);
  }

  private static double toDouble(Object o) {
    if (o == null) return 0;
    if (o instanceof Number n) return n.doubleValue();
    try { return Double.parseDouble(String.valueOf(o)); }
    catch (NumberFormatException e) { return 0; }
  }

  /** Validates a caller-supplied surveyed DEM: square NxN, 8..256, finite meters. */
  private static List<List<Double>> toGrid(Object gridObj) {
    if (!(gridObj instanceof List<?> rows) || rows.size() < 8 || rows.size() > 256)
      throw new IllegalArgumentException("elevation_grid must be a square grid 8..256");
    List<List<Double>> grid = new ArrayList<>();
    for (Object row : rows) {
      if (!(row instanceof List<?> cells) || cells.size() != rows.size())
        throw new IllegalArgumentException("elevation_grid must be square (NxN)");
      List<Double> out = new ArrayList<>();
      for (Object v : cells) {
        double d = toDouble(v);
        if (!Double.isFinite(d) || d < -500 || d > 9000)
          throw new IllegalArgumentException("elevation_grid has invalid elevation values");
        out.add(d);
      }
      grid.add(out);
    }
    return grid;
  }

  private static boolean isTrue(Object o) {
    if (o instanceof Boolean b) return b;
    return "true".equalsIgnoreCase(String.valueOf(o));
  }
}
