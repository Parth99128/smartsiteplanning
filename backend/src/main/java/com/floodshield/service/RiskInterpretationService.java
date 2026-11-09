package com.floodshield.service;

import org.springframework.stereotype.Service;

import java.util.*;

/**
 * Deterministic interpretation of stored model output: red flags, per-factor
 * ratings, intervention placement, downstream estimates and zone conflicts.
 * Every rule is a pure function of surveyed factors + the traced flow path —
 * no randomness, no hardcoded demo values.
 */
@Service
public class RiskInterpretationService {

  // Building footprint used for every flow-path request (kept in one place).
  public static final double BX = 0.35, BY = 0.35, BW = 0.25, BD = 0.25;

  // ---------- red flags ----------

  public List<Map<String, Object>> redFlags(Map<String, Object> f, Map<String, Object> hm) {
    List<Map<String, Object>> out = new ArrayList<>();
    boolean intersects = isTrue(hm.get("intersects"));
    double elev = num(f.get("elevation_m"));
    double imperv = num(f.get("impervious_pct"));
    double dd = num(f.get("drainage_density"));
    double dist = num(f.get("dist_water_m"));
    double hist = num(f.get("hist_flood_count"));
    double plinth = num(f.get("plinth_m"));
    double rain = num(f.get("rainfall_mm"));
    double landuse = num(f.get("land_use_change_pct"));

    if (intersects)
      out.add(flag("DRAINAGE_BLOCKED", "Critical", "Proposed footprint intersects the natural drainage path."));
    if (elev < 7)
      out.add(flag("LOW_ELEVATION", "High", "Site elevation " + elev + " m is in the low-lying band (< 7 m)."));
    if (imperv > 70)
      out.add(flag("HIGH_IMPERVIOUS", "High", "Impervious cover " + imperv + "% will generate high surface runoff."));
    else if (imperv > 55)
      out.add(flag("HIGH_IMPERVIOUS", "Medium", "Impervious cover " + imperv + "% is elevated."));
    if (dd < 1.0)
      out.add(flag("POOR_DRAINAGE", "High", "Drainage density " + dd + "/km² indicates insufficient stormwater capacity."));
    else if (dd < 1.5)
      out.add(flag("POOR_DRAINAGE", "Medium", "Drainage density " + dd + "/km² is below the resilient band."));
    if (dist < 150)
      out.add(flag("NEAR_WATER", "Medium", "Site is " + dist + " m from a water body/drain (< 150 m)."));
    if (hist >= 2)
      out.add(flag("FLOOD_HISTORY", "Medium", hist + " recorded flood events at this site."));
    if (plinth < 0.45)
      out.add(flag("LOW_PLINTH", "Medium", "Plinth " + plinth + " m is below the 0.45 m resilient threshold."));
    if (rain > 200)
      out.add(flag("HIGH_RAINFALL", "Medium", "Design rainfall " + rain + " mm is in the high band."));
    if (landuse > 60)
      out.add(flag("LAND_USE_CHANGE", "Medium", "Pervious-to-built conversion " + landuse + "% removes infiltration."));
    return out;
  }

  private Map<String, Object> flag(String code, String severity, String message) {
    return Map.of("code", code, "severity", severity, "message", message);
  }

  // ---------- per-factor ratings ----------

  public List<Map<String, Object>> factorRatings(Map<String, Object> f, Map<String, Object> contributions) {
    List<Map<String, Object>> out = new ArrayList<>();
    addRating(out, f, contributions, "rainfall_mm", "Rainfall", v -> v > 200 ? "High" : v > 140 ? "Moderate" : "Low");
    addRating(out, f, contributions, "elevation_m", "Elevation", v -> v < 7 ? "High" : v < 12 ? "Moderate" : "Low");
    addRating(out, f, contributions, "slope_deg", "Slope", v -> v < 1 ? "High" : v < 3 ? "Moderate" : "Low");
    addRating(out, f, contributions, "dist_water_m", "Distance to water", v -> v < 150 ? "High" : v < 400 ? "Moderate" : "Low");
    addRating(out, f, contributions, "drainage_density", "Drainage density", v -> v < 1.0 ? "High" : v < 1.8 ? "Moderate" : "Low");
    addRating(out, f, contributions, "soil_infiltration_mmhr", "Soil infiltration", v -> v < 8 ? "High" : v < 15 ? "Moderate" : "Low");
    addRating(out, f, contributions, "impervious_pct", "Impervious cover", v -> v > 70 ? "High" : v > 50 ? "Moderate" : "Low");
    addRating(out, f, contributions, "footprint_sqm", "Footprint", v -> v > 1000 ? "High" : v > 600 ? "Moderate" : "Low");
    addRating(out, f, contributions, "hist_flood_count", "Flood history", v -> v >= 2 ? "High" : v >= 1 ? "Moderate" : "Low");
    addRating(out, f, contributions, "plinth_m", "Plinth", v -> v < 0.45 ? "High" : v < 0.6 ? "Moderate" : "Low");
    addRating(out, f, contributions, "land_use_change_pct", "Land-use change", v -> v > 60 ? "High" : v > 35 ? "Moderate" : "Low");
    addRating(out, f, contributions, "catchment_sqm", "Upstream catchment", v -> v > 200000 ? "High" : v > 60000 ? "Moderate" : "Low");
    return out;
  }

  private void addRating(List<Map<String, Object>> out, Map<String, Object> f,
                         Map<String, Object> contributions, String key, String label,
                         java.util.function.Function<Double, String> rater) {
    double v = num(f.get(key));
    Object c = contributions == null ? null : contributions.get(key);
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("factor", key);
    m.put("label", label);
    m.put("value", v);
    m.put("rating", rater.apply(v));
    m.put("contribution", c instanceof Number n ? n.doubleValue() : null);
    out.add(m);
  }

  // ---------- placement + measured clearance ----------

  /** Bounding box of the traced flow path in normalized site coordinates. */
  public Map<String, Double> flowBbox(Map<String, Object> hm) {
    double x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    boolean any = false;
    Object fp = hm.get("flow_path");
    if (fp instanceof List<?> list) {
      for (Object o : list) {
        if (o instanceof Map<?, ?> p) {
          double x = num(p.get("x")), y = num(p.get("y"));
          x0 = Math.min(x0, x); y0 = Math.min(y0, y);
          x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          any = true;
        }
      }
    }
    if (!any) { x0 = 0.15; y0 = 0.18; x1 = 0.85; y1 = 0.82; }
    double pad = 0.03;
    Map<String, Double> b = new LinkedHashMap<>();
    b.put("x", clamp01(x0 - pad)); b.put("y", clamp01(y0 - pad));
    b.put("w", clamp01(x1 + pad) - clamp01(x0 - pad));
    b.put("d", clamp01(y1 + pad) - clamp01(y0 - pad));
    return b;
  }

  /** Clearance from the building footprint to the flow path, in meters. */
  public double clearDistanceM(Map<String, Object> hm) {
    return clearDistanceM(hm, BX, BY, BW, BD);
  }

  public double clearDistanceM(Map<String, Object> hm, double bx, double by, double bw, double bd) {
    Object fp = hm.get("flow_path");
    if (!(fp instanceof List<?> list) || list.isEmpty()) return -1;
    double size = num(hm.getOrDefault("size", 64));
    double cellM = num(hm.getOrDefault("cell_m", 5.0));
    if (size <= 0) size = 64;
    if (cellM <= 0) cellM = 5.0;
    double best = Double.MAX_VALUE;
    for (Object o : list) {
      if (o instanceof Map<?, ?> p) {
        double x = num(p.get("x")), y = num(p.get("y"));
        double dx = Math.max(bx - x, Math.max(0, x - (bx + bw)));
        double dy = Math.max(by - y, Math.max(0, y - (by + bd)));
        double dNorm = Math.hypot(dx, dy);
        best = Math.min(best, dNorm);
      }
    }
    if (best == Double.MAX_VALUE) return -1;
    if (best == 0) return 0;
    return Math.round(best * size * cellM * 10.0) / 10.0;
  }

  /** Nearest-clear repositioning for a blocked footprint.
   *  Answers "move the building X m north-east": searches candidate centers on
   *  a coarse grid; a candidate is clear when its bbox edge stands >= requiredM
   *  from every traced flow point. Normalized y maps to latitude (north). */
  public Map<String, Object> shiftGuidance(Map<String, Object> hm,
                                           double bx, double by, double bw, double bd) {
    return shiftGuidance(hm, bx, by, bw, bd, 12.0);
  }

  public Map<String, Object> shiftGuidance(Map<String, Object> hm, double bx, double by,
                                           double bw, double bd, double requiredM) {
    Object fp = hm.get("flow_path");
    double size = num(hm.getOrDefault("size", 64));
    double cellM = num(hm.getOrDefault("cell_m", 5.0));
    if (size <= 0) size = 64;
    if (cellM <= 0) cellM = 5.0;
    if (!(fp instanceof List<?> list) || list.isEmpty())
      return Map.of("needed", false, "reason", "no flow traced yet");
    List<double[]> pts = new ArrayList<>();
    for (Object o : list) {
      if (o instanceof Map<?, ?> p) pts.add(new double[]{num(p.get("x")), num(p.get("y"))});
    }
    if (pts.isEmpty()) return Map.of("needed", false, "reason", "no flow traced yet");
    double mPerNorm = size * cellM;
    double ccx = bx + bw / 2, ccy = by + bd / 2;
    double curM = clearanceNorm(pts, bx, by, bw, bd) * mPerNorm;
    if (curM >= requiredM)
      return Map.of("needed", false, "clearance_m", r1(curM));
    double bestCx = -1, bestCy = -1, bestD = Double.MAX_VALUE;
    for (double gx = bw / 2; gx <= 1 - bw / 2 + 1e-9; gx += 0.05) {
      for (double gy = bd / 2; gy <= 1 - bd / 2 + 1e-9; gy += 0.05) {
        double nx = gx - bw / 2, ny = gy - bd / 2;
        double clr = clearanceNorm(pts, nx, ny, bw, bd) * mPerNorm;
        if (clr >= requiredM) {
          double d = Math.hypot(gx - ccx, gy - ccy);
          if (d < bestD) { bestD = d; bestCx = gx; bestCy = gy; }
        }
      }
    }
    if (bestCx < 0)
      return Map.of("needed", true, "feasible", false,
        "note", "No clear position meets " + requiredM + " m clearance inside the site — shrink the footprint or add a drainage corridor.");
    double dxM = (bestCx - ccx) * mPerNorm;
    double dyM = (bestCy - ccy) * mPerNorm;
    double distM = Math.hypot(dxM, dyM);
    String ns = dyM > 2 ? "north" : dyM < -2 ? "south" : "";
    String ew = dxM > 2 ? "east" : dxM < -2 ? "west" : "";
    String compass = (ns + (ns.isEmpty() || ew.isEmpty() ? "" : "-") + ew);
    if (compass.isEmpty()) compass = "here";
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("needed", true);
    out.put("feasible", true);
    out.put("distance_m", r1(distM));
    out.put("compass", compass);
    out.put("dx_m", r1(dxM));
    out.put("dy_m", r1(dyM));
    out.put("new_cx", r4(bestCx));
    out.put("new_cy", r4(bestCy));
    out.put("message", "Move the building " + r1(distM) + " m " + compass + " to clear the drainage path.");
    return out;
  }

  private static double clearanceNorm(List<double[]> pts, double bx, double by, double bw, double bd) {
    double best = Double.MAX_VALUE;
    for (double[] p : pts) {
      double dx = Math.max(bx - p[0], Math.max(0, p[0] - (bx + bw)));
      double dy = Math.max(by - p[1], Math.max(0, p[1] - (by + bd)));
      best = Math.min(best, Math.hypot(dx, dy));
    }
    return best == Double.MAX_VALUE ? -1 : best;
  }

  private static double r1(double v) { return Math.round(v * 10.0) / 10.0; }

  private static double r4(double v) { return Math.round(v * 10000.0) / 10000.0; }

  public Map<String, Object> placementFor(Map<String, Object> rec, Map<String, Object> hm) {
    return placementFor(rec, hm, BX, BY, BW, BD);
  }

  public Map<String, Object> placementFor(Map<String, Object> rec, Map<String, Object> hm,
                                          double bx, double by, double bw, double bd) {
    String t = ((String) rec.getOrDefault("problem", "")) + " " + ((String) rec.getOrDefault("action", ""));
    String tl = t.toLowerCase();
    Map<String, Object> out = new LinkedHashMap<>();
    if (tl.contains("block") || tl.contains("corridor")) {
      out.put("zone", "corridor");
      out.put("bbox", flowBbox(hm));
      double clearM = clearDistanceM(hm, bx, by, bw, bd);
      out.put("clear_distance_m", clearM);
      out.put("note", clearM == 0
        ? "Footprint overlaps the traced flow path — shift it clear of this corridor."
        : "Preserve this corridor; nearest footprint edge is ~" + clearM + " m from the flow path.");
    } else if (tl.contains("impervious") || tl.contains("permeable") || tl.contains("rain garden")
        || tl.contains("green buffer") || tl.contains("conversion")) {
      out.put("zone", "outlet");
      out.put("bbox", outletBox(hm));
      out.put("note", "Place permeable surfaces / rain garden / green buffer in this low-lying outlet zone.");
    } else if (tl.contains("drainage") || tl.contains("storage") || tl.contains("recharge")) {
      out.put("zone", "midflow");
      out.put("bbox", midflowBox(hm));
      out.put("note", "Recharge pits + storage intercept flow mid-path before it reaches the outlet.");
    } else if (tl.contains("plinth")) {
      out.put("zone", "building");
      out.put("bbox", Map.of("x", clamp01(bx - 0.05), "y", clamp01(by - 0.05), "w", bw + 0.1, "d", bd + 0.1));
      out.put("note", "Raise the plinth of the proposed footprint itself.");
    } else {
      out.put("zone", "building");
      out.put("bbox", Map.of("x", clamp01(bx - 0.12), "y", clamp01(by - 0.12), "w", bw + 0.24, "d", bd + 0.24));
      out.put("note", "Maintain green cover around the footprint perimeter.");
    }
    return out;
  }

  private Map<String, Double> outletBox(Map<String, Object> hm) {
    Object o = hm.get("outlet");
    double ox = 0.85, oy = 0.82;
    if (o instanceof Map<?, ?> m) { ox = num(m.get("x")); oy = num(m.get("y")); }
    double s = 0.18;
    Map<String, Double> b = new LinkedHashMap<>();
    b.put("x", clamp01(ox - s / 2)); b.put("y", clamp01(oy - s / 2));
    b.put("w", s); b.put("d", s);
    return b;
  }

  private Map<String, Double> midflowBox(Map<String, Object> hm) {
    Object fp = hm.get("flow_path");
    double mx = 0.5, my = 0.5;
    if (fp instanceof List<?> list && list.size() > 4) {
      Object o = list.get(list.size() / 2);
      if (o instanceof Map<?, ?> m) { mx = num(m.get("x")); my = num(m.get("y")); }
    }
    double s = 0.16;
    Map<String, Double> b = new LinkedHashMap<>();
    b.put("x", clamp01(mx - s / 2)); b.put("y", clamp01(my - s / 2));
    b.put("w", s); b.put("d", s);
    return b;
  }

  // ---------- downstream ----------

  public Map<String, Object> downstream(Map<String, Object> f, Map<String, Object> hm) {
    double imperv = num(f.get("impervious_pct"));
    double rain = num(f.get("rainfall_mm"));
    double foot = num(f.get("footprint_sqm"));
    double runoff = Math.round((0.15 + 0.75 * (imperv / 100.0)) * 100.0) / 100.0;
    Object o = hm.get("outlet");
    double ox = 0.85, oy = 0.82;
    if (o instanceof Map<?, ?> m) { ox = num(m.get("x")); oy = num(m.get("y")); }
    String dir = (oy >= 0.66 ? "south" : oy <= 0.33 ? "north" : "") +
      ((oy >= 0.66 || oy <= 0.33) && (ox >= 0.66 || ox <= 0.33) ? "-" : "") +
      (ox >= 0.66 ? "east" : ox <= 0.33 ? "west" : "");
    if (dir.isEmpty()) dir = "south-east";
    double volume = Math.round(rain / 1000.0 * foot * runoff * 10.0) / 10.0;
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("runoff_coefficient", runoff);
    m.put("outlet_direction", dir);
    m.put("est_runoff_m3", volume);
    m.put("note", "An estimated " + volume + " m³ of runoff leaves toward the " + dir
      + " outlet for the design storm. Downstream drains must convey this volume.");
    return m;
  }

  // ---------- apply-all mapping (server twin of the UI patch rules) ----------

  public Map<String, Object> patchFor(Map<String, Object> rec) {
    String t = ((String) rec.getOrDefault("problem", "")) + " " + ((String) rec.getOrDefault("action", ""));
    String tl = t.toLowerCase();
    if (tl.contains("impervious") || tl.contains("conversion") || tl.contains("green buffer"))
      return Map.of("permeable_sqm", 800.0, "rain_garden", true);
    if (tl.contains("block") || tl.contains("corridor"))
      return Map.of("storage_m3", 60.0, "recharge", true);
    if (tl.contains("plinth"))
      return Map.of("plinth_m", 0.9);
    if (tl.contains("drainage") || tl.contains("storage") || tl.contains("recharge"))
      return Map.of("storage_m3", 60.0, "recharge", true);
    return Map.of("rain_garden", true, "permeable_sqm", 600.0);
  }

  // ---------- site transform (mirrors MapView) + zone conflicts ----------

  public double[] flowLatLng(double siteLat, double siteLng, double px, double py) {
    return new double[]{siteLat - 0.005 + py * 0.01, siteLng - 0.005 + px * 0.01};
  }

  public List<Map<String, Object>> zoneConflicts(List<Map<String, Object>> zones,
                                                 Map<String, Object> hm,
                                                 double siteLat, double siteLng) {
    List<Map<String, Object>> out = new ArrayList<>();
    Object fp = hm.get("flow_path");
    List<double[]> pts = new ArrayList<>();
    if (fp instanceof List<?> list) {
      for (Object o : list) {
        if (o instanceof Map<?, ?> p)
          pts.add(flowLatLng(siteLat, siteLng, num(p.get("x")), num(p.get("y"))));
      }
    }
    for (Map<String, Object> z : zones) {
      List<double[]> poly = toPoly(z.get("polygon"));
      if (poly.size() < 3 || pts.isEmpty()) continue;
      boolean hit = pts.stream().anyMatch(pt -> inside(pt[0], pt[1], poly));
      String kind = String.valueOf(z.getOrDefault("kind", ""));
      String name = String.valueOf(z.getOrDefault("name", kind));
      if (!hit) continue;
      Map<String, Object> c = new LinkedHashMap<>();
      c.put("zone_id", z.get("id"));
      c.put("zone", name);
      switch (kind) {
        case "building" -> {
          c.put("severity", "Critical");
          c.put("message", "“" + name + "” overlaps the natural drainage path — shift it clear.");
        }
        case "parking", "road" -> {
          c.put("severity", "High");
          c.put("message", "“" + name + "” sits on a high-runoff flow segment — relocate or make it permeable.");
        }
        case "open_space" -> {
          c.put("severity", "Low");
          c.put("message", "“" + name + "” crosses the flow path — keep it unpaved.");
        }
        default -> {
          c.put("severity", "Info");
          c.put("message", "“" + name + "” lies on the flow path — good placement, keep it clear.");
        }
      }
      out.add(c);
    }
    return out;
  }

  @SuppressWarnings("unchecked")
  private List<double[]> toPoly(Object polygon) {
    List<double[]> poly = new ArrayList<>();
    if (polygon instanceof List<?> list) {
      for (Object o : list) {
        if (o instanceof Map<?, ?> p) {
          Object la = p.get("lat"), ln = p.get("lng");
          if (la instanceof Number n1 && ln instanceof Number n2)
            poly.add(new double[]{n1.doubleValue(), n2.doubleValue()});
        } else if (o instanceof List<?> pair && pair.size() == 2
            && pair.get(0) instanceof Number n1 && pair.get(1) instanceof Number n2) {
          poly.add(new double[]{n1.doubleValue(), n2.doubleValue()});
        }
      }
    }
    return poly;
  }

  private boolean inside(double lat, double lng, List<double[]> poly) {
    boolean c = false;
    for (int i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
      double yi = poly.get(i)[0], xi = poly.get(i)[1];
      double yj = poly.get(j)[0], xj = poly.get(j)[1];
      if ((yi > lat) != (yj > lat) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi))
        c = !c;
    }
    return c;
  }

  // ---------- surveyed DEM stats ----------

  /** Mean elevation + mean slope (degrees) from a square surveyed grid (meters).
   *  Used to ground the risk factors in measured terrain instead of estimates. */
  public Map<String, Double> demStats(List<List<Double>> grid, double cellM) {
    int n = grid.size();
    double sum = 0;
    int count = 0;
    for (List<Double> row : grid) {
      for (Double v : row) {
        if (v != null && Double.isFinite(v)) { sum += v; count++; }
      }
    }
    if (count == 0) throw new IllegalArgumentException("elevation grid has no valid values");
    double mean = sum / count;
    double slopeSum = 0;
    int slopeN = 0;
    for (int r = 1; r < n - 1; r++) {
      for (int c = 1; c < n - 1; c++) {
        Double a = grid.get(r).get(c - 1), b = grid.get(r).get(c + 1);
        Double d = grid.get(r - 1).get(c), e = grid.get(r + 1).get(c);
        if (a == null || b == null || d == null || e == null) continue;
        double gx = (b - a) / (2 * cellM);
        double gy = (e - d) / (2 * cellM);
        slopeSum += Math.atan(Math.hypot(gx, gy)) * 180.0 / Math.PI;
        slopeN++;
      }
    }
    Map<String, Double> m = new LinkedHashMap<>();
    m.put("mean_elev", Math.round(mean * 10.0) / 10.0);
    m.put("mean_slope", slopeN == 0 ? 2.0 : Math.round((slopeSum / slopeN) * 10.0) / 10.0);
    return m;
  }

  // ---------- helpers ----------

  public static double num(Object o) {
    if (o == null) return 0;
    if (o instanceof Number n) return n.doubleValue();
    try { return Double.parseDouble(String.valueOf(o)); }
    catch (NumberFormatException e) { return 0; }
  }

  private static boolean isTrue(Object o) {
    if (o instanceof Boolean b) return b;
    return "true".equalsIgnoreCase(String.valueOf(o));
  }

  private static double clamp01(double v) { return Math.max(0, Math.min(1, v)); }
}
