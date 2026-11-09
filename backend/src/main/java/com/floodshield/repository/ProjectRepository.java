package com.floodshield.repository;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.security.SecureRandom;
import java.util.*;

/**
 * Postgres + PostGIS persistence for projects and derived artefacts.
 * Replaces the former in-memory demo store. Every read/write is explicit SQL
 * so behaviour is identical locally, in Docker, and in production.
 */
@Repository
public class ProjectRepository {

  private final JdbcTemplate jdbc;
  private final ObjectMapper om = new ObjectMapper();
  private final SecureRandom random = new SecureRandom();
  private static final String TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

  public ProjectRepository(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public String newShareToken() {
    StringBuilder sb = new StringBuilder("sh_");
    for (int i = 0; i < 12; i++) sb.append(TOKEN_ALPHABET.charAt(random.nextInt(TOKEN_ALPHABET.length())));
    return sb.toString();
  }

  // ---------- projects ----------

  public List<Map<String, Object>> listProjects() {
    String sql = """
      SELECT p.id, p.name, p.share_token, p.created_at,
             ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
             s.site_area_sqm, s.footprint_sqm, s.floors, s.builtup_pct,
             s.green_sqm, s.permeable_sqm, s.soil_type, s.drainage_info,
             (SELECT risk_score FROM risk_assessments r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_risk,
             (SELECT risk_level FROM risk_assessments r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_level,
             (SELECT resilience_score FROM risk_assessments r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_resilience,
             (SELECT badge FROM risk_assessments r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_badge
      FROM projects p LEFT JOIN project_sites s ON s.project_id = p.id
      ORDER BY p.id
      """;
    return jdbc.queryForList(sql);
  }

  public Optional<Map<String, Object>> findProject(long id) {
    String sql = """
      SELECT p.id, p.name, p.share_token, p.created_at,
             ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
             s.site_area_sqm, s.footprint_sqm, s.floors, s.builtup_pct,
             s.green_sqm, s.permeable_sqm, s.soil_type, s.drainage_info
      FROM projects p LEFT JOIN project_sites s ON s.project_id = p.id
      WHERE p.id = ?
      """;
    try {
      return Optional.of(jdbc.queryForMap(sql, id));
    } catch (EmptyResultDataAccessException e) {
      return Optional.empty();
    }
  }

  public Optional<Map<String, Object>> findByShareToken(String token) {
    String sql = """
      SELECT p.id, p.name, p.share_token, p.created_at,
             ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
             s.site_area_sqm, s.footprint_sqm, s.floors, s.builtup_pct,
             s.green_sqm, s.permeable_sqm
      FROM projects p LEFT JOIN project_sites s ON s.project_id = p.id
      WHERE p.share_token = ?
      """;
    try {
      return Optional.of(jdbc.queryForMap(sql, token));
    } catch (EmptyResultDataAccessException e) {
      return Optional.empty();
    }
  }

  public long createProject(String name, double lat, double lng,
                            Double siteArea, Double footprint, Integer floors,
                            Double builtupPct, Double greenSqm, Double permeableSqm,
                            String soilType, String drainageInfo) {
    validateLatLng(lat, lng);
    String token = newShareToken();
    String insertProject = "INSERT INTO projects(name, share_token) VALUES (?, ?) RETURNING id";
    Long id;
    try {
      id = jdbc.queryForObject(insertProject, Long.class, name, token);
    } catch (Exception e) {
      throw new IllegalStateException("project insert failed: " + e.getMessage(), e);
    }
    if (id == null) throw new IllegalStateException("project insert returned no id");
    try {
      jdbc.update("""
        INSERT INTO project_sites(project_id, location, site_area_sqm, footprint_sqm, floors,
          builtup_pct, green_sqm, permeable_sqm, soil_type, drainage_info)
        VALUES (?, ST_GeogFromText(?), ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        id, "SRID=4326;POINT(" + lng + " " + lat + ")",
        siteArea, footprint, floors == null ? 1 : floors,
        builtupPct, greenSqm, permeableSqm, soilType, drainageInfo);
    } catch (Exception e) {
      // roll back the orphaned project row so retries don't leak
      try { jdbc.update("DELETE FROM projects WHERE id = ?", id); } catch (Exception ignored) { }
      throw new IllegalStateException("site insert failed (is PostGIS available?): " + e.getMessage(), e);
    }
    ensureEnvironmentalFactors(id, footprint, lat, lng);
    return id;
  }

  public void updateProjectLocation(long id, double lat, double lng) {
    validateLatLng(lat, lng);
    int n = jdbc.update("UPDATE project_sites SET location = ST_GeogFromText(?) WHERE project_id = ?",
      "SRID=4326;POINT(" + lng + " " + lat + ")", id);
    if (n == 0) {
      jdbc.update("INSERT INTO project_sites(project_id, location) VALUES (?, ST_GeogFromText(?))",
        id, "SRID=4326;POINT(" + lng + " " + lat + ")");
    }
    // New ground under the pin → re-derive geo factors, preserving design fields.
    refreshGeoFactors(id, lat, lng);
  }

  private static void validateLatLng(double lat, double lng) {
    if (!Double.isFinite(lat) || !Double.isFinite(lng))
      throw new IllegalArgumentException("lat/lng must be finite numbers");
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180)
      throw new IllegalArgumentException("lat must be [-90,90], lng [-180,180]");
  }

  // ---------- environmental factors (location-derived, dynamic) ----------

  /**
   * Deterministic geo-estimator: turns ANY map pick into a distinct,
   * planning-grade factor set. Same rounded coordinate (~100m grid) always
   * yields the same factors, so analyses are reproducible. These are
   * estimates to be replaced by survey data — never certified values.
   */
  public Map<String, Object> deriveFactors(double lat, double lng, Double footprintOverride) {
    validateLatLng(lat, lng);
    long seed = Objects.hash(Math.round(lat * 1000), Math.round(lng * 1000));
    Random rnd = new Random(seed);
    // Regional monsoon shaping: wetter + lower toward the south-west lowlands.
    double rainBase = 170 + Math.max(0, (24.0 - lat)) * 6 + Math.max(0, (lng - 72.0)) * -4;
    double rainfall = clamp(round1(rainBase + rnd.nextDouble(-25, 25)), 80, 320);
    double elevation = clamp(round1(2 + rnd.nextDouble() * 20 + (lat > 23.2 ? 3 : 0)), 2, 28);
    double slope = clamp(round1(0.5 + rnd.nextDouble() * 6.5), 0.5, 8);
    double distWater = clamp(round1(20 + rnd.nextDouble() * 1400), 20, 1500);
    // Near urban core → denser impervious, sparser infiltration.
    double urbanK = Math.exp(-(Math.pow(lat - 23.05, 2) + Math.pow(lng - 72.55, 2)) / 0.02);
    double impervious = clamp(round1(35 + urbanK * 35 + rnd.nextDouble(-12, 12)), 20, 95);
    double drainage = clamp(round1(0.4 + rnd.nextDouble() * 2.4 + (impervious > 70 ? -0.4 : 0.3)), 0.4, 3.0);
    double infiltration = clamp(round1(6 + rnd.nextDouble() * 26 - (impervious > 70 ? 6 : 0)), 4, 35);
    double footprint = footprintOverride != null && footprintOverride > 0 ? footprintOverride : 800.0;
    int hist = (elevation < 7 && distWater < 200) ? 2 + rnd.nextInt(3)
      : (elevation < 10 || distWater < 400) ? 1 + rnd.nextInt(2) : rnd.nextInt(2);
    double landuse = clamp(round1(impervious * 0.8 + rnd.nextGaussian() * 8), 5, 95);
    double catchment = clamp(Math.pow(10, 3.7 + rnd.nextDouble() * 2.0), 5000, 2000000);
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("rainfall_mm", rainfall);
    m.put("elevation_m", elevation);
    m.put("slope_deg", slope);
    m.put("dist_water_m", distWater);
    m.put("drainage_density", drainage);
    m.put("soil_infiltration_mmhr", infiltration);
    m.put("impervious_pct", impervious);
    m.put("footprint_sqm", round1(footprint));
    m.put("hist_flood_count", (double) hist);
    m.put("plinth_m", 0.3);
    m.put("land_use_change_pct", landuse);
    m.put("catchment_sqm", Math.round(catchment * 10.0) / 10.0);
    m.put("_provenance", "geo-derived-planning-estimate-v1");
    return m;
  }

  /** Ensures one factors row exists; derives footprint from the site record. */
  public void ensureEnvironmentalFactors(long projectId, Double footprintOverride, Double lat, Double lng) {
    Integer count = jdbc.queryForObject(
      "SELECT COUNT(*) FROM environmental_factors WHERE project_id = ?", Integer.class, projectId);
    if (count != null && count > 0) return;
    Double footprint = footprintOverride;
    double la = lat != null ? lat : Double.NaN;
    double ln = lng != null ? lng : Double.NaN;
    if (footprint == null || !Double.isFinite(la)) {
      try {
        Map<String, Object> site = jdbc.queryForMap(
          "SELECT footprint_sqm, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng" +
          " FROM project_sites WHERE project_id = ?", projectId);
        if (footprint == null && site.get("footprint_sqm") instanceof Number n) footprint = n.doubleValue();
        if (!Double.isFinite(la) && site.get("lat") instanceof Number n) la = n.doubleValue();
        if (!Double.isFinite(ln) && site.get("lng") instanceof Number n) ln = n.doubleValue();
      } catch (EmptyResultDataAccessException ignored) { }
    }
    if (!Double.isFinite(la) || !Double.isFinite(ln)) { la = 23.082; ln = 72.493; }
    Map<String, Object> d = deriveFactors(la, ln, footprint);
    jdbc.update("""
      INSERT INTO environmental_factors(project_id, rainfall_mm, elevation_m, slope_deg,
        dist_water_m, drainage_density, soil_infiltration_mmhr, impervious_pct,
        footprint_sqm, hist_flood_count, plinth_m, land_use_change_pct, catchment_sqm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id) DO NOTHING
      """, projectId,
      toDouble(d.get("rainfall_mm")), toDouble(d.get("elevation_m")),
      toDouble(d.get("slope_deg")), toDouble(d.get("dist_water_m")),
      toDouble(d.get("drainage_density")), toDouble(d.get("soil_infiltration_mmhr")),
      toDouble(d.get("impervious_pct")), toDouble(d.get("footprint_sqm")),
      toInt(d.get("hist_flood_count")), toDouble(d.get("plinth_m")),
      toDouble(d.get("land_use_change_pct")), toDouble(d.get("catchment_sqm")));
  }

  /** Back-compat overload (uses stored site location). */
  public void ensureEnvironmentalFactors(long projectId, Double footprintOverride) {
    ensureEnvironmentalFactors(projectId, footprintOverride, null, null);
  }

  /** Re-derive GEO fields after a map move; keep design fields (footprint/plinth). */
  public void refreshGeoFactors(long projectId, double lat, double lng) {
    Map<String, Object> cur;
    try {
      cur = loadFactors(projectId);
    } catch (Exception e) {
      ensureEnvironmentalFactors(projectId, null, lat, lng);
      return;
    }
    Map<String, Object> d = deriveFactors(lat, lng, toDouble(cur.get("footprint_sqm")));
    jdbc.update("""
      UPDATE environmental_factors SET rainfall_mm = ?, elevation_m = ?, slope_deg = ?,
        dist_water_m = ?, drainage_density = ?, soil_infiltration_mmhr = ?,
        impervious_pct = ?, hist_flood_count = ? WHERE project_id = ?
      """,
      toDouble(d.get("rainfall_mm")), toDouble(d.get("elevation_m")),
      toDouble(d.get("slope_deg")), toDouble(d.get("dist_water_m")),
      toDouble(d.get("drainage_density")), toDouble(d.get("soil_infiltration_mmhr")),
      toDouble(d.get("impervious_pct")), toInt(d.get("hist_flood_count")), projectId);
  }

  public Map<String, Object> loadFactors(long projectId) {
    ensureEnvironmentalFactors(projectId, null);
    Map<String, Object> m = jdbc.queryForMap(
      "SELECT rainfall_mm, elevation_m, slope_deg, dist_water_m, drainage_density," +
      " soil_infiltration_mmhr, impervious_pct, footprint_sqm, hist_flood_count, plinth_m," +
      " land_use_change_pct, catchment_sqm" +
      " FROM environmental_factors WHERE project_id = ?", projectId);
    // normalise numeric types for the ML service
    Map<String, Object> out = new LinkedHashMap<>();
    for (var e : m.entrySet()) {
      Object v = e.getValue();
      out.put(e.getKey(), v instanceof Number n ? n.doubleValue() : v);
    }
    return out;
  }

  public void upsertFactors(long projectId, Map<String, Object> factors) {
    Map<String, Object> cur = loadFactors(projectId);
    Map<String, Object> merged = new LinkedHashMap<>(cur);
    for (var e : factors.entrySet()) {
      if (e.getValue() != null) merged.put(e.getKey(), e.getValue());
    }
    jdbc.update("""
      INSERT INTO environmental_factors(project_id, rainfall_mm, elevation_m, slope_deg,
        dist_water_m, drainage_density, soil_infiltration_mmhr, impervious_pct,
        footprint_sqm, hist_flood_count, plinth_m, land_use_change_pct, catchment_sqm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET
        rainfall_mm = EXCLUDED.rainfall_mm, elevation_m = EXCLUDED.elevation_m,
        slope_deg = EXCLUDED.slope_deg, dist_water_m = EXCLUDED.dist_water_m,
        drainage_density = EXCLUDED.drainage_density,
        soil_infiltration_mmhr = EXCLUDED.soil_infiltration_mmhr,
        impervious_pct = EXCLUDED.impervious_pct, footprint_sqm = EXCLUDED.footprint_sqm,
        hist_flood_count = EXCLUDED.hist_flood_count, plinth_m = EXCLUDED.plinth_m,
        land_use_change_pct = EXCLUDED.land_use_change_pct, catchment_sqm = EXCLUDED.catchment_sqm
      """,
      projectId,
      toDouble(merged.get("rainfall_mm")), toDouble(merged.get("elevation_m")),
      toDouble(merged.get("slope_deg")), toDouble(merged.get("dist_water_m")),
      toDouble(merged.get("drainage_density")), toDouble(merged.get("soil_infiltration_mmhr")),
      toDouble(merged.get("impervious_pct")), toDouble(merged.get("footprint_sqm")),
      toInt(merged.get("hist_flood_count")), toDouble(merged.get("plinth_m")),
      toDouble(merged.get("land_use_change_pct")), toDouble(merged.get("catchment_sqm")));
  }

  // ---------- analysis artefacts ----------

  public void saveAnalysis(long projectId, Map<String, Object> risk,
                           Map<String, Object> heightmap, List<Map<String, Object>> recommendations,
                           double climateUplift) {
    saveAssessment(projectId, risk, heightmap, recommendations, climateUplift,
      null, null, null, null, null, "analysis");
  }

  public void saveAssessment(long projectId, Map<String, Object> risk,
                             Map<String, Object> heightmap, List<Map<String, Object>> recommendations,
                             double climateUplift, Double resilienceScore, String badge,
                             Object breakdown, Object flags, Object ratings, String runType) {
    double riskScore = toDouble(risk.get("risk_score"));
    String riskLevel = String.valueOf(risk.getOrDefault("risk_level", "Unknown"));
    String contributions = toJson(risk.get("contributions"));
    String topFactors = toJson(risk.get("top_factors"));
    jdbc.update("""
      INSERT INTO risk_assessments(project_id, risk_score, risk_level, contributions,
        top_factors, resilience_score, badge, climate_uplift_pct,
        resilience_breakdown, flags, factor_ratings, run_type)
      VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?)
      """, projectId, riskScore, riskLevel, contributions, topFactors,
      resilienceScore, badge, climateUplift,
      toJson(breakdown), toJson(flags), toJson(ratings), runType);

    if (heightmap != null) {
      int size = toInt(heightmap.getOrDefault("size", 64));
      double cellM = toDouble(heightmap.getOrDefault("cell_m", 5.0));
      jdbc.update("""
        INSERT INTO heightmap_grids(project_id, size, cell_m, payload)
        VALUES (?, ?, ?, ?::jsonb)
        ON CONFLICT (project_id) DO UPDATE SET size = EXCLUDED.size,
          cell_m = EXCLUDED.cell_m, payload = EXCLUDED.payload
        """, projectId, size, cellM, toJson(heightmap));
      Object intersects = heightmap.get("intersects");
      boolean ib = intersects instanceof Boolean b ? b : "true".equalsIgnoreCase(String.valueOf(intersects));
      jdbc.update("""
        INSERT INTO drainage_paths(project_id, intersects_building)
        VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET intersects_building = EXCLUDED.intersects_building
        """, projectId, ib);
    }

    if (recommendations != null) {
      jdbc.update("DELETE FROM recommendations WHERE project_id = ?", projectId);
      for (var r : recommendations) {
        jdbc.update("""
          INSERT INTO recommendations(project_id, problem, action, reason, effect,
            priority, cost_band, gain_pts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          """, projectId,
          str(r.get("problem")), str(r.get("action")), str(r.get("reason")),
          str(r.get("effect")), str(r.get("priority")), str(r.get("cost_band")),
          toDouble(r.get("gain_pts")));
      }
    }
  }

  public void saveSimulation(long projectId, Map<String, Object> input, Map<String, Object> sim) {
    saveSimulation(projectId, input, sim, "simulation");
  }

  public void saveSimulation(long projectId, Map<String, Object> input, Map<String, Object> sim, String runType) {
    double riskScore = toDouble(sim.get("risk_score"));
    Object res = sim.get("resilience_score");
    Double resScore = res == null ? null : toDouble(res);
    jdbc.update("INSERT INTO simulation_results(project_id, input, risk_score, resilience_score)" +
      " VALUES (?, ?::jsonb, ?, ?)", projectId, toJson(input), riskScore, resScore);
    // also record a risk_assessments row so compare/report see the latest what-if
    String riskLevel = String.valueOf(sim.getOrDefault("risk_level", "Unknown"));
    Object badge = sim.get("badge");
    jdbc.update("""
      INSERT INTO risk_assessments(project_id, risk_score, risk_level, contributions,
        top_factors, resilience_score, badge, climate_uplift_pct,
        resilience_breakdown, flags, factor_ratings, run_type)
      VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?)
      """, projectId, riskScore, riskLevel,
      toJson(sim.get("contributions")), toJson(sim.get("top_factors")),
      resScore, badge == null ? null : String.valueOf(badge),
      toDouble(input.getOrDefault("climate_uplift_pct", 0)),
      toJson(sim.get("resilience_breakdown")), toJson(sim.get("flags")), toJson(sim.get("factor_ratings")),
      runType);
    Object hm = sim.get("heightmap");
    if (hm instanceof Map<?, ?> hmm) {
      @SuppressWarnings("unchecked")
      Map<String, Object> heightmap = (Map<String, Object>) hmm;
      int size = toInt(heightmap.getOrDefault("size", 64));
      double cellM = toDouble(heightmap.getOrDefault("cell_m", 5.0));
      jdbc.update("""
        INSERT INTO heightmap_grids(project_id, size, cell_m, payload)
        VALUES (?, ?, ?, ?::jsonb)
        ON CONFLICT (project_id) DO UPDATE SET size = EXCLUDED.size,
          cell_m = EXCLUDED.cell_m, payload = EXCLUDED.payload
        """, projectId, size, cellM, toJson(heightmap));
    }
  }

  public Map<String, Object> lastAnalysis(long projectId) {
    List<Map<String, Object>> rows = jdbc.queryForList(
      "SELECT risk_score, risk_level, contributions, top_factors, resilience_score, badge," +
      " climate_uplift_pct, resilience_breakdown, flags, factor_ratings, run_type, created_at" +
      " FROM risk_assessments" +
      " WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", projectId);
    if (rows.isEmpty()) return Map.of();
    Map<String, Object> r = new LinkedHashMap<>(rows.get(0));
    r.put("contributions", parseJson(str(r.get("contributions"))));
    r.put("top_factors", parseJson(str(r.get("top_factors"))));
    r.put("resilience_breakdown", parseJson(str(r.get("resilience_breakdown"))));
    r.put("flags", parseJson(str(r.get("flags"))));
    r.put("factor_ratings", parseJson(str(r.get("factor_ratings"))));
    return r;
  }

  public Map<String, Object> heightmap(long projectId) {
    try {
      Map<String, Object> row = jdbc.queryForMap(
        "SELECT size, cell_m, payload FROM heightmap_grids WHERE project_id = ?", projectId);
      Object payload = row.get("payload");
      if (payload == null) return Map.of();
      if (payload instanceof Map<?, ?> m) {
        @SuppressWarnings("unchecked")
        Map<String, Object> mm = (Map<String, Object>) m;
        return mm;
      }
      Object parsed = parseJson(String.valueOf(payload));
      if (parsed instanceof Map<?, ?> m) {
        @SuppressWarnings("unchecked")
        Map<String, Object> mm = (Map<String, Object>) m;
        return mm;
      }
      return Map.of();
    } catch (EmptyResultDataAccessException e) {
      return Map.of();
    }
  }

  public List<Map<String, Object>> recommendations(long projectId) {
    return jdbc.queryForList(
      "SELECT problem, action, reason, effect, priority, cost_band, gain_pts" +
      " FROM recommendations WHERE project_id = ? ORDER BY id", projectId);
  }

  public Map<String, Object> lastSimulation(long projectId) {
    List<Map<String, Object>> rows = jdbc.queryForList(
      "SELECT input, risk_score, resilience_score, created_at FROM simulation_results" +
      " WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", projectId);
    return rows.isEmpty() ? Map.of() : rows.get(0);
  }

  // ---------- site zones ----------

  static final Set<String> ZONE_KINDS = Set.of(
    "building", "parking", "road", "open_space", "drainage", "green");

  public long addZone(long projectId, String kind, String name, Object polygon) {
    if (!ZONE_KINDS.contains(kind)) throw new IllegalArgumentException("kind must be one of " + ZONE_KINDS);
    if (name == null || name.trim().isEmpty() || name.trim().length() > 120)
      throw new IllegalArgumentException("name is required (max 120 chars)");
    String polyJson = toJson(polygon);
    Object parsed = parseJson(polyJson);
    if (!(parsed instanceof List<?> list) || list.size() < 3)
      throw new IllegalArgumentException("polygon must have at least 3 points [{lat,lng}...]");
    Long id = jdbc.queryForObject(
      "INSERT INTO site_zones(project_id, kind, name, polygon) VALUES (?, ?, ?, ?::jsonb) RETURNING id",
      Long.class, projectId, kind, name.trim(), polyJson);
    if (id == null) throw new IllegalStateException("zone insert returned no id");
    return id;
  }

  public List<Map<String, Object>> zones(long projectId) {
    List<Map<String, Object>> rows = jdbc.queryForList(
      "SELECT id, kind, name, polygon, created_at FROM site_zones WHERE project_id = ? ORDER BY id", projectId);
    List<Map<String, Object>> out = new ArrayList<>();
    for (Map<String, Object> r : rows) {
      Map<String, Object> m = new LinkedHashMap<>(r);
      m.put("polygon", parseJson(str(r.get("polygon"))));
      out.add(m);
    }
    return out;
  }

  public int deleteZone(long projectId, long zoneId) {
    return jdbc.update("DELETE FROM site_zones WHERE id = ? AND project_id = ?", zoneId, projectId);
  }

  // ---------- site plans ----------

  public long addSitePlan(long projectId, String filename, String contentType, byte[] image,
                          double swLat, double swLng, double neLat, double neLng) {
    if (image == null || image.length == 0) throw new IllegalArgumentException("image is empty");
    if (image.length > 5 * 1024 * 1024) throw new IllegalArgumentException("image max 5 MB");
    if (!(swLat < neLat && swLng < neLng)) throw new IllegalArgumentException("bounds must satisfy sw < ne");
    Long id = jdbc.queryForObject(
      "INSERT INTO site_plans(project_id, filename, content_type, image, sw_lat, sw_lng, ne_lat, ne_lng)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      Long.class, projectId, filename, contentType, image, swLat, swLng, neLat, neLng);
    if (id == null) throw new IllegalStateException("site plan insert returned no id");
    return id;
  }

  public List<Map<String, Object>> sitePlans(long projectId) {
    return jdbc.queryForList(
      "SELECT id, filename, content_type, octet_length(image) AS bytes," +
      " sw_lat, sw_lng, ne_lat, ne_lng, created_at FROM site_plans" +
      " WHERE project_id = ? ORDER BY id", projectId);
  }

  public Optional<Map<String, Object>> sitePlanImage(long planId) {
    try {
      return Optional.of(jdbc.queryForMap(
        "SELECT content_type, image FROM site_plans WHERE id = ?", planId));
    } catch (EmptyResultDataAccessException e) {
      return Optional.empty();
    }
  }

  public int deleteSitePlan(long projectId, long planId) {
    return jdbc.update("DELETE FROM site_plans WHERE id = ? AND project_id = ?", planId, projectId);
  }

  public Map<String, Object> siteDesign(long projectId) {
    try {
      return jdbc.queryForMap(
        "SELECT green_sqm, permeable_sqm FROM project_sites WHERE project_id = ?", projectId);
    } catch (EmptyResultDataAccessException e) {
      return Map.of();
    }
  }

  // ---------- pilot-city drain registry (migration 003; optional until applied) ----------

  public List<Map<String, Object>> listCities() {
    return jdbc.queryForList(
      "SELECT code, name, bbox_north, bbox_south, bbox_east, bbox_west," +
      " drain_count, inlet_count, source, updated_at FROM cities ORDER BY code");
  }

  public Optional<String> findCityCode(double lat, double lng) {
    List<String> rows = jdbc.query(
      "SELECT code FROM cities WHERE ? BETWEEN bbox_south AND bbox_north" +
      " AND ? BETWEEN bbox_west AND bbox_east LIMIT 1",
      (rs, i) -> rs.getString(1), lat, lng);
    return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
  }

  public List<Map<String, Object>> nearbyDrains(String city, double lat, double lng,
                                               double radiusM, int limit) {
    String pt = "SRID=4326;POINT(" + lng + " " + lat + ")";
    return jdbc.queryForList(
      "SELECT id, kind, type_label, width_m, dia_mm, invert_m, status, source," +
      " ST_Distance(geom, ST_GeogFromText(?)) AS dist_m," +
      " ST_Length(geom) AS len_m, ST_AsGeoJSON(geom) AS geojson" +
      " FROM drain_lines WHERE city = ?" +
      " AND ST_DWithin(geom, ST_GeogFromText(?), ?)" +
      " ORDER BY dist_m LIMIT ?", pt, city, pt, radiusM, limit);
  }

  /** Nearest open (surface) drains only — guarantees DEM-burn material even where
   *  dense buried sewers dominate the nearest-N query. */
  public List<Map<String, Object>> nearbyBurnableDrains(String city, double lat, double lng,
                                                        double radiusM, int limit) {
    String pt = "SRID=4326;POINT(" + lng + " " + lat + ")";
    return jdbc.queryForList(
      "SELECT id, kind, type_label, width_m, dia_mm, invert_m, status, source," +
      " ST_Distance(geom, ST_GeogFromText(?)) AS dist_m," +
      " ST_Length(geom) AS len_m, ST_AsGeoJSON(geom) AS geojson" +
      " FROM drain_lines WHERE city = ? AND kind <> 'sewer'" +
      " AND ST_DWithin(geom, ST_GeogFromText(?), ?)" +
      " ORDER BY dist_m LIMIT ?", pt, city, pt, radiusM, limit);
  }

  public List<Map<String, Object>> nearbyInlets(String city, double lat, double lng,
                                               double radiusM, int limit) {
    String pt = "SRID=4326;POINT(" + lng + " " + lat + ")";
    return jdbc.queryForList(
      "SELECT id, kind, source," +
      " ST_Distance(geom, ST_GeogFromText(?)) AS dist_m," +
      " ST_AsText(geom::geometry) AS wkt" +
      " FROM drain_points WHERE city = ?" +
      " AND ST_DWithin(geom, ST_GeogFromText(?), ?)" +
      " ORDER BY dist_m LIMIT ?", pt, city, pt, radiusM, limit);
  }

  public void saveSiteContext(long projectId, String city, double lat, double lng,
                              Double confidence, Object payloadJson) {
    jdbc.update("""
      INSERT INTO site_contexts(project_id, city, lat, lng, confidence, payload)
      VALUES (?, ?, ?, ?, ?, ?::jsonb)
      ON CONFLICT (project_id) DO UPDATE SET city = EXCLUDED.city, lat = EXCLUDED.lat,
        lng = EXCLUDED.lng, confidence = EXCLUDED.confidence, payload = EXCLUDED.payload,
        created_at = now()
      """, projectId, city, lat, lng, confidence, toJson(payloadJson));
  }

  public Map<String, Object> loadSiteContext(long projectId) {
    try {
      Map<String, Object> row = jdbc.queryForMap(
        "SELECT city, lat, lng, confidence, payload, created_at FROM site_contexts WHERE project_id = ?",
        projectId);
      Map<String, Object> out = new LinkedHashMap<>(row);
      out.put("payload", parseJson(str(row.get("payload"))));
      return out;
    } catch (EmptyResultDataAccessException e) {
      return Map.of();
    }
  }

  // ---------- building placement (draggable proposed footprint, migration 004) ----------

  static final double PLACE_CX = 0.475, PLACE_CY = 0.475, PLACE_SIZE = 0.25;

  public Map<String, Double> getPlacement(long projectId) {
    try {
      Map<String, Object> row = jdbc.queryForMap(
        "SELECT cx, cy FROM building_placement WHERE project_id = ?", projectId);
      return Map.of("cx", toDouble(row.get("cx")), "cy", toDouble(row.get("cy")));
    } catch (EmptyResultDataAccessException e) {
      return Map.of("cx", PLACE_CX, "cy", PLACE_CY);
    } catch (Exception e) {
      // 004 not applied yet — legacy fixed bbox stays in effect
      return Map.of("cx", PLACE_CX, "cy", PLACE_CY);
    }
  }

  public Map<String, Double> savePlacement(long projectId, double cx, double cy) {
    if (!Double.isFinite(cx) || !Double.isFinite(cy) || cx < 0 || cx > 1 || cy < 0 || cy > 1)
      throw new IllegalArgumentException("cx/cy must be in [0,1]");
    jdbc.update("""
      INSERT INTO building_placement(project_id, cx, cy)
      VALUES (?, ?, ?)
      ON CONFLICT (project_id) DO UPDATE SET cx = EXCLUDED.cx, cy = EXCLUDED.cy,
        updated_at = now()
      """, projectId, cx, cy);
    return Map.of("cx", cx, "cy", cy);
  }

  /** Flow-path building bbox derived from the placement center (fixed 0.25 size). */
  public static Map<String, Double> placementBbox(double cx, double cy) {
    double s = PLACE_SIZE;
    double x = Math.max(0, Math.min(1 - s, cx - s / 2));
    double y = Math.max(0, Math.min(1 - s, cy - s / 2));
    return Map.of("x", x, "y", y, "w", s, "d", s);
  }

  // ---------- design schemes (migration 005; cap 6 per project) ----------

  static final int SCHEME_CAP = 6;

  public Map<String, Object> saveScheme(long projectId, String name,
                                        Map<String, Object> input, Map<String, Object> result) {
    Integer n;
    try {
      n = jdbc.queryForObject(
        "SELECT COUNT(*) FROM design_schemes WHERE project_id = ?", Integer.class, projectId);
    } catch (Exception e) {
      throw new IllegalStateException("Design schemes unavailable — apply migration 005.", e);
    }
    if (n != null && n >= SCHEME_CAP)
      throw new IllegalStateException("Scheme limit reached (6 per site) — delete one first.");
    Long sid = jdbc.queryForObject(
      "INSERT INTO design_schemes(project_id, name, input, result)" +
      " VALUES (?, ?, ?::jsonb, ?::jsonb) RETURNING id",
      Long.class, projectId, name.trim(), toJson(input), toJson(result));
    if (sid == null) throw new IllegalStateException("scheme insert returned no id");
    return schemeRow(projectId, sid);
  }

  public List<Map<String, Object>> schemes(long projectId) {
    List<Map<String, Object>> rows;
    try {
      rows = jdbc.queryForList(
        "SELECT id, name, input, result, created_at FROM design_schemes" +
        " WHERE project_id = ? ORDER BY id", projectId);
    } catch (Exception e) {
      return List.of(); // 005 not applied yet — no schemes, no crash
    }
    List<Map<String, Object>> out = new ArrayList<>();
    for (Map<String, Object> r : rows) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("id", r.get("id"));
      m.put("name", r.get("name"));
      m.put("input", parseJson(str(r.get("input"))));
      m.put("result", parseJson(str(r.get("result"))));
      m.put("created_at", r.get("created_at"));
      out.add(m);
    }
    return out;
  }

  private Map<String, Object> schemeRow(long projectId, long schemeId) {
    List<Map<String, Object>> all = schemes(projectId);
    return all.stream().filter((m) -> ((Number) m.get("id")).longValue() == schemeId)
      .findFirst().orElse(Map.of("id", schemeId));
  }

  public int deleteScheme(long projectId, long schemeId) {
    return jdbc.update("DELETE FROM design_schemes WHERE id = ? AND project_id = ?", schemeId, projectId);
  }

  // ---------- site assets (migration 006; point pins) ----------

  static final Set<String> ASSET_KINDS = Set.of("recharge_pit", "sump", "pump");

  public long addAsset(long projectId, String kind, String name,
                       double lat, double lng, Double capacityM3) {
    if (!ASSET_KINDS.contains(kind)) throw new IllegalArgumentException("kind must be one of " + ASSET_KINDS);
    if (!Double.isFinite(lat) || lat < -90 || lat > 90 || !Double.isFinite(lng) || lng < -180 || lng > 180)
      throw new IllegalArgumentException("lat/lng out of range");
    String nm = name == null ? "" : name.trim();
    if (nm.length() > 120) throw new IllegalArgumentException("name max 120 chars");
    Long id = jdbc.queryForObject(
      "INSERT INTO site_assets(project_id, kind, name, lat, lng, capacity_m3)" +
      " VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      Long.class, projectId, kind, nm, lat, lng, capacityM3);
    if (id == null) throw new IllegalStateException("asset insert returned no id");
    return id;
  }

  public List<Map<String, Object>> assets(long projectId) {
    try {
      return jdbc.queryForList(
        "SELECT id, kind, name, lat, lng, capacity_m3, created_at FROM site_assets" +
        " WHERE project_id = ? ORDER BY id", projectId);
    } catch (Exception e) {
      return List.of(); // 006 not applied yet
    }
  }

  public int deleteAsset(long projectId, long assetId) {
    try {
      return jdbc.update("DELETE FROM site_assets WHERE id = ? AND project_id = ?", assetId, projectId);
    } catch (Exception e) {
      return 0;
    }
  }

  // ---------- helpers ----------

  private String toJson(Object o) {
    if (o == null) return "null";
    if (o instanceof String s) {
      // already JSON text?
      String t = s.trim();
      if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))
        || t.equals("null")) return s;
    }
    try { return om.writeValueAsString(o); }
    catch (JsonProcessingException e) { throw new IllegalStateException("JSON encode failed", e); }
  }

  private Object parseJson(String s) {
    if (s == null || s.isBlank() || s.equals("null")) return null;
    try { return om.readValue(s, Object.class); }
    catch (Exception e) { return s; }
  }

  private static String str(Object o) { return o == null ? null : String.valueOf(o); }

  private static double round1(double v) { return Math.round(v * 10.0) / 10.0; }

  private static double clamp(double v, double lo, double hi) { return Math.max(lo, Math.min(hi, v)); }

  private static double toDouble(Object o) {
    if (o == null) return 0;
    if (o instanceof Number n) return n.doubleValue();
    return Double.parseDouble(String.valueOf(o));
  }

  private static int toInt(Object o) {
    if (o == null) return 0;
    if (o instanceof Number n) return n.intValue();
    return (int) Math.round(Double.parseDouble(String.valueOf(o)));
  }
}
