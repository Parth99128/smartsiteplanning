package com.floodshield.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.floodshield.repository.ProjectRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * Real-data loop: turns a map pin into measured drainage factors from the
 * pilot-city municipal registry (migration 003), with provenance + confidence.
 *
 * Graceful when the registry is absent (003 not applied yet) or the pin is
 * outside pilot bboxes: returns city=null and geo-derived fallbacks so all
 * existing flows keep working.
 */
@Service
public class SiteContextService {

  private static final Logger log = LoggerFactory.getLogger(SiteContextService.class);

  final ProjectRepository repo;
  final ObjectMapper om = new ObjectMapper();

  static final Set<String> BURNABLE = Set.of("storm", "open_drain", "nalla", "canal", "river", "lake_link");
  static final double FRAME = 0.01; // ±0.005° site frame (matches frontend toGeo + elevation.js)

  public SiteContextService(ProjectRepository repo) {
    this.repo = repo;
  }

  public boolean registryAvailable() {
    try {
      repo.listCities();
      return true;
    } catch (Exception e) {
      return false;
    }
  }

  /** Build context for ANY pin. Never throws for missing registry — returns fallback. */
  public Map<String, Object> build(double lat, double lng, double radiusM) {
    double radius = Math.max(100, Math.min(2000, radiusM));
    if (!Double.isFinite(lat) || !Double.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180)
      throw new IllegalArgumentException("lat must be [-90,90], lng [-180,180]");
    try {
      Optional<String> cityOpt = repo.findCityCode(lat, lng);
      if (cityOpt.isEmpty()) return fallback(lat, lng, radius, "outside-pilot-cities");
      String city = cityOpt.get();
      List<Map<String, Object>> drains = repo.nearbyDrains(city, lat, lng, radius, 150);
      List<Map<String, Object>> inlets = repo.nearbyInlets(city, lat, lng, radius, 100);
      Map<String, Object> out = assemble(city, lat, lng, radius, drains, inlets);
      // Buried-sewer cores (Pune): nearest-150 can be all sewer (unburnable).
      // Fall back to the nearest open drains so the DEM burn still has material.
      @SuppressWarnings("unchecked")
      List<?> burns = out.get("burn_lines") instanceof List<?> b ? b : List.of();
      if (burns.isEmpty()) {
        List<Map<String, Object>> open = repo.nearbyBurnableDrains(city, lat, lng, radius, 60);
        if (!open.isEmpty()) {
          List<Map<String, Object>> extra = buildBurnLines(open, lng - 0.005, lat - 0.005);
          out.put("burn_lines", extra.size() > 60 ? extra.subList(0, 60) : extra);
          out.put("burn_lines_total", extra.size());
          @SuppressWarnings("unchecked")
          List<String> w = out.get("warnings") instanceof List<?> wl
            ? new ArrayList<>((List<String>) wl) : new ArrayList<>();
          w.add("nearest registry lines are buried sewers - surface burn uses farther open drains");
          out.put("warnings", w);
        }
      }
      return out;
    } catch (IllegalArgumentException e) {
      throw e;
    } catch (Exception e) {
      log.warn("site-context fallback (registry unavailable?): {}", e.toString());
      return fallback(lat, lng, radius, "registry-unavailable");
    }
  }

  private Map<String, Object> fallback(double lat, double lng, double radius, String reason) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("city", null);
    out.put("lat", lat);
    out.put("lng", lng);
    out.put("radius_m", radius);
    out.put("confidence", 0.5);
    out.put("drains", List.of());
    out.put("inlets", List.of());
    out.put("burn_lines", List.of());
    out.put("segments", List.of());
    out.put("factors", Map.of());
    out.put("provenance", Map.of());
    out.put("warnings", List.of(reason + " — using geo-derived planning estimate; drop municipal KMLs per database/gis_raw/README.md"));
    return out;
  }

  Map<String, Object> assemble(String city, double lat, double lng, double radius,
                               List<Map<String, Object>> drains, List<Map<String, Object>> inlets) {
    double west = lng - 0.005, south = lat - 0.005;
    List<Map<String, Object>> drainOut = new ArrayList<>();
    List<Map<String, Object>> burnLines = new ArrayList<>();
    List<Map<String, Object>> segments = new ArrayList<>();
    double minDist = Double.MAX_VALUE, totalLenM = 0;
    boolean hasTertiary = false;

    for (Map<String, Object> d : drains) {
      String id = String.valueOf(d.get("id"));
      String kind = String.valueOf(d.getOrDefault("kind", "storm"));
      String typeLabel = String.valueOf(d.getOrDefault("type_label", ""));
      double dist = num(d.get("dist_m"));
      double len = num(d.get("len_m"));
      minDist = Math.min(minDist, dist);
      totalLenM += len;
      if (typeLabel.equalsIgnoreCase("tertiary")) hasTertiary = true;

      List<List<Double>> line = parseGeoJsonLine(String.valueOf(d.get("geojson")));
      List<List<Double>> norm = normalize(line, west, south);
      List<List<Double>> trimmed = trim(norm);

      Map<String, Object> row = new LinkedHashMap<>();
      row.put("id", id);
      row.put("kind", kind);
      row.put("type", typeLabel);
      row.put("dia_mm", d.get("dia_mm"));
      row.put("width_m", d.get("width_m"));
      row.put("invert_m", d.get("invert_m"));
      row.put("invert_measured", d.get("invert_m") != null
        && !String.valueOf(d.getOrDefault("source", "")).contains("srtm90m-invert"));
      row.put("status", String.valueOf(d.getOrDefault("status", "unknown")));
      row.put("dist_m", r1(dist));
      row.put("len_m", r1(len));
      row.put("geom", trimmed); // normalized 0..1 site frame for 2D/3D overlays
      drainOut.add(row);

      if (BURNABLE.contains(kind) && trimmed.size() >= 2)
        burnLines.add(Map.of("pts", trimmed, "depth_m", burnDepth(kind, typeLabel)));
      Map<String, Object> seg = new LinkedHashMap<>();
      seg.put("id", id);
      seg.put("kind", kind);
      if (d.get("dia_mm") != null) seg.put("dia_mm", num(d.get("dia_mm")));
      if (d.get("width_m") != null) seg.put("width_m", num(d.get("width_m")));
      seg.put("status", String.valueOf(d.getOrDefault("status", "unknown")));
      String st = String.valueOf(d.getOrDefault("status", "")).toLowerCase();
      if (st.contains("bad")) seg.put("blocked_pct", 40); // GCC field survey: degraded section
      segments.add(seg);
    }

    List<Map<String, Object>> inletOut = new ArrayList<>();
    for (Map<String, Object> p : inlets) {
      double[] ll = parseWktPoint(String.valueOf(p.get("wkt")));
      Map<String, Object> row = new LinkedHashMap<>();
      row.put("id", String.valueOf(p.get("id")));
      row.put("kind", String.valueOf(p.getOrDefault("kind", "chamber")));
      row.put("dist_m", r1(num(p.get("dist_m"))));
      if (ll != null) {
        row.put("lng", ll[0]);
        row.put("lat", ll[1]);
        row.put("x", r4((ll[0] - west) / FRAME));
        row.put("y", r4((ll[1] - south) / FRAME));
      }
      inletOut.add(row);
    }

    double areaKm2 = Math.PI * Math.pow(radius / 1000.0, 2);
    double density = drains.isEmpty() ? 0 : clamp((totalLenM / 1000.0) / areaKm2, 0, 10);
    double distDrain = drains.isEmpty() ? -1 : r1(minDist);

    double confidence;
    List<String> warnings = new ArrayList<>();
    if (drains.isEmpty()) {
      confidence = 0.55;
      warnings.add("no municipal drains within " + (int) radius + " m — OSM/front-end diff only");
    } else if (drains.size() <= 5) confidence = 0.7;
    else confidence = 0.85;
    if (city.equals("bengaluru") && !hasTertiary) {
      confidence = Math.min(confidence, 0.75);
      warnings.add("tertiary drains incomplete in this ward (CAG-2021) — confidence capped 0.75");
    }
    if (!inlets.isEmpty() && confidence > 0.55) confidence = Math.min(0.9, confidence + 0.03);

    Map<String, Object> factors = new LinkedHashMap<>();
    Map<String, Object> provenance = new LinkedHashMap<>();
    if (!drains.isEmpty()) {
      factors.put("dist_water_m", distDrain);
      factors.put("drainage_density", r1(density));
      provenance.put("dist_water_m", Map.of("source", "municipal-registry", "city", city, "confidence", confidence));
      provenance.put("drainage_density", Map.of("source", "postgis-sum-" + (int) radius + "m", "city", city, "confidence", confidence));
    }

    Map<String, Object> out = new LinkedHashMap<>();
    out.put("city", city);
    out.put("lat", lat);
    out.put("lng", lng);
    out.put("radius_m", radius);
    out.put("confidence", r2(confidence));
    out.put("factors", factors);
    out.put("provenance", provenance);
    out.put("drains", drainOut);
    out.put("inlets", inletOut);
    out.put("burn_lines", burnLines.size() > 60 ? burnLines.subList(0, 60) : burnLines);
    out.put("burn_lines_total", burnLines.size());
    out.put("segments", segments.size() > 150 ? segments.subList(0, 150) : segments);
    out.put("segments_total", segments.size());
    out.put("warnings", warnings);
    return out;
  }

  /** Build burn entries from raw registry rows (shared by assemble + sewer-core fallback). */
  List<Map<String, Object>> buildBurnLines(List<Map<String, Object>> rows, double west, double south) {
    List<Map<String, Object>> out = new ArrayList<>();
    for (Map<String, Object> d : rows) {
      String kind = String.valueOf(d.getOrDefault("kind", "storm"));
      if (!BURNABLE.contains(kind)) continue;
      List<List<Double>> trimmed = trim(normalize(parseGeoJsonLine(String.valueOf(d.get("geojson"))), west, south));
      if (trimmed.size() >= 2)
        out.add(Map.of("pts", trimmed,
          "depth_m", burnDepth(kind, String.valueOf(d.getOrDefault("type_label", "")))));
    }
    return out;
  }

  static double burnDepth(String kind, String typeLabel) {
    String t = (typeLabel == null ? "" : typeLabel.toLowerCase());
    if (kind.equals("river")) return 1.5;
    if (kind.equals("canal")) return 1.2;
    if (t.contains("primary")) return 1.2;
    if (t.contains("secondary")) return 1.0;
    if (t.contains("tertiary")) return 0.6;
    if (kind.equals("nalla")) return 1.0;
    return 1.0;
  }

  List<List<Double>> parseGeoJsonLine(String geojson) {
    try {
      @SuppressWarnings("unchecked")
      Map<String, Object> g = om.readValue(geojson, Map.class);
      Object coords = g.get("coordinates");
      if ("LineString".equals(g.get("type")) && coords instanceof List<?> l) {
        List<List<Double>> out = new ArrayList<>();
        for (Object p : l) {
          if (p instanceof List<?> xy && xy.size() >= 2)
            out.add(List.of(num(xy.get(0)), num(xy.get(1))));
        }
        return out;
      }
      if ("MultiLineString".equals(g.get("type")) && coords instanceof List<?> ml && !ml.isEmpty()
        && ml.get(0) instanceof List<?> first) {
        List<List<Double>> out = new ArrayList<>();
        for (Object p : first) {
          if (p instanceof List<?> xy && xy.size() >= 2)
            out.add(List.of(num(xy.get(0)), num(xy.get(1))));
        }
        return out;
      }
    } catch (Exception ignored) { }
    return List.of();
  }

  static double[] parseWktPoint(String wkt) {
    try {
      String t = wkt.substring(wkt.indexOf('(') + 1, wkt.indexOf(')')).trim();
      String[] xy = t.split("\\s+");
      return new double[]{Double.parseDouble(xy[0]), Double.parseDouble(xy[1])};
    } catch (Exception e) {
      return null;
    }
  }

  List<List<Double>> normalize(List<List<Double>> line, double west, double south) {
    List<List<Double>> out = new ArrayList<>();
    for (List<Double> p : line) {
      out.add(List.of(r4((p.get(0) - west) / FRAME), r4((p.get(1) - south) / FRAME)));
    }
    return out;
  }

  /** Keep points near the site frame; stride long lines to ≤120 pts. */
  List<List<Double>> trim(List<List<Double>> norm) {
    List<List<Double>> inFrame = new ArrayList<>();
    for (List<Double> p : norm) {
      if (p.get(0) > -0.05 && p.get(0) < 1.05 && p.get(1) > -0.05 && p.get(1) < 1.05)
        inFrame.add(p);
    }
    if (inFrame.size() <= 120) return inFrame;
    int stride = (int) Math.ceil(inFrame.size() / 120.0);
    List<List<Double>> out = new ArrayList<>();
    for (int i = 0; i < inFrame.size(); i += stride) out.add(inFrame.get(i));
    return out;
  }

  static double num(Object o) {
    if (o == null) return 0;
    if (o instanceof Number n) return n.doubleValue();
    try { return Double.parseDouble(String.valueOf(o)); } catch (NumberFormatException e) { return 0; }
  }

  static double r1(double v) { return Math.round(v * 10.0) / 10.0; }
  static double r2(double v) { return Math.round(v * 100.0) / 100.0; }
  static double r4(double v) { return Math.round(v * 10000.0) / 10000.0; }
  static double clamp(double v, double lo, double hi) { return Math.max(lo, Math.min(hi, v)); }
}
