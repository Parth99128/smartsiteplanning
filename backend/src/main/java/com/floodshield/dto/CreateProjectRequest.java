package com.floodshield.dto;

import jakarta.validation.constraints.*;
import java.util.Map;

public class CreateProjectRequest {

  @NotBlank(message = "name is required")
  @Size(max = 200, message = "name max 200 chars")
  public String name;

  @NotNull(message = "lat is required")
  @DecimalMin(value = "-90.0", message = "lat must be >= -90")
  @DecimalMax(value = "90.0", message = "lat must be <= 90")
  public Double lat;

  @NotNull(message = "lng is required")
  @DecimalMin(value = "-180.0", message = "lng must be >= -180")
  @DecimalMax(value = "180.0", message = "lng must be <= 180")
  public Double lng;

  @PositiveOrZero(message = "site_area_sqm must be >= 0")
  public Double site_area_sqm;

  @PositiveOrZero(message = "footprint_sqm must be >= 0")
  public Double footprint_sqm;

  @Min(value = 1, message = "floors must be >= 1")
  @Max(value = 100, message = "floors must be <= 100")
  public Integer floors = 1;

  @DecimalMin(value = "0.0") @DecimalMax(value = "100.0")
  public Double builtup_pct;

  public Double green_sqm;
  public Double permeable_sqm;
  public String soil_type;
  public String drainage_info;

  /** Optional surveyed environmental factors. When absent, the service derives
   *  planning-grade defaults from the site record and stores them explicitly
   *  so every analysis is traceable — never silent hardcoded demo values. */
  public Map<String, Object> environmental_factors;
}
