package com.floodshield.dto;

import jakarta.validation.constraints.*;
import java.util.Map;

/** Validated payload for what-if simulation runs. All fields optional except
 *  via business rules; values are range-checked so bad sliders fail fast. */
public class SimulateRequest {

  @PositiveOrZero public Double footprint_sqm;
  @DecimalMin("0.0") @DecimalMax("1.5") public Double plinth_m;
  @PositiveOrZero public Double permeable_sqm;
  @PositiveOrZero public Double storage_m3;
  public Boolean rain_garden;
  public Boolean recharge;
  public Double green_sqm;

  @DecimalMin("0.0") @DecimalMax("100.0")
  public Double climate_uplift_pct = 0.0;

  public Double builtup_pct;
  public Double rainfall_mm;
  public Double elevation_m;
  public Double slope_deg;
  public Double dist_water_m;
  public Double drainage_density;
  public Double soil_infiltration_mmhr;
  public Double impervious_pct;
  public Integer hist_flood_count;
  public Double land_use_change_pct;
  public Double catchment_sqm;

  @SuppressWarnings("unchecked")
  public static SimulateRequest from(Map<String, Object> m) {
    SimulateRequest r = new SimulateRequest();
    if (m == null) return r;
    r.footprint_sqm = num(m.get("footprint_sqm"));
    r.plinth_m = num(m.get("plinth_m"));
    r.permeable_sqm = num(m.get("permeable_sqm"));
    r.storage_m3 = num(m.get("storage_m3"));
    r.rain_garden = bool(m.get("rain_garden"));
    r.recharge = bool(m.get("recharge"));
    r.green_sqm = num(m.get("green_sqm"));
    r.climate_uplift_pct = numOr(m.get("climate_uplift_pct"), 0.0);
    r.builtup_pct = num(m.get("builtup_pct"));
    r.rainfall_mm = num(m.get("rainfall_mm"));
    r.elevation_m = num(m.get("elevation_m"));
    r.slope_deg = num(m.get("slope_deg"));
    r.dist_water_m = num(m.get("dist_water_m"));
    r.drainage_density = num(m.get("drainage_density"));
    r.soil_infiltration_mmhr = num(m.get("soil_infiltration_mmhr"));
    r.impervious_pct = num(m.get("impervious_pct"));
    r.land_use_change_pct = num(m.get("land_use_change_pct"));
    r.catchment_sqm = num(m.get("catchment_sqm"));
    Object h = m.get("hist_flood_count");
    if (h instanceof Number n) r.hist_flood_count = n.intValue();
    return r;
  }

  private static Double num(Object o) {
    if (o == null) return null;
    if (o instanceof Number n) return n.doubleValue();
    try { return Double.parseDouble(String.valueOf(o)); }
    catch (NumberFormatException e) { throw new IllegalArgumentException("expected numeric value, got: " + o); }
  }

  private static Double numOr(Object o, double dflt) {
    Double v = num(o);
    return v == null ? dflt : v;
  }

  private static Boolean bool(Object o) {
    if (o == null) return null;
    if (o instanceof Boolean b) return b;
    String s = String.valueOf(o).toLowerCase();
    if (s.equals("true") || s.equals("1")) return true;
    if (s.equals("false") || s.equals("0")) return false;
    throw new IllegalArgumentException("expected boolean, got: " + o);
  }
}
