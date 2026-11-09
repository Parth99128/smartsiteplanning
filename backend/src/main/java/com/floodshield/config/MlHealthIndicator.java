package com.floodshield.config;

import com.floodshield.service.MlClient;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/** Surfaces ML-service reachability in /actuator/health. */
@Component("mlService")
public class MlHealthIndicator implements HealthIndicator {

  private final MlClient ml;

  public MlHealthIndicator(MlClient ml) { this.ml = ml; }

  @Override
  public Health health() {
    boolean up = ml.ping();
    return (up ? Health.up() : Health.down())
      .withDetail("mlService", up ? "reachable" : "unreachable")
      .build();
  }
}
