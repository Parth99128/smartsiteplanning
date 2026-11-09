package com.floodshield.service;

import com.floodshield.exception.MlServiceException;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.boot.web.client.RestTemplateBuilder;

import java.time.Duration;
import java.util.Map;

/**
 * Gateway to the FastAPI ML service. All calls go through timeouts + circuit breaker
 * so a hung ML pod never blocks web threads.
 */
@Service
public class MlClient {

  private static final Logger log = LoggerFactory.getLogger(MlClient.class);

  final String mlUrl;
  final RestTemplate rt;

  public MlClient(@Value("${ml.service.url:http://localhost:8000}") String mlUrl,
                  @Value("${ml.service.timeout-ms:10000}") long timeoutMs,
                  RestTemplateBuilder builder) {
    this.mlUrl = mlUrl;
    this.rt = builder
      .setConnectTimeout(Duration.ofMillis(Math.min(timeoutMs, 3000)))
      .setReadTimeout(Duration.ofMillis(timeoutMs))
      .build();
  }

  @CircuitBreaker(name = "mlService", fallbackMethod = "fallback")
  @Retry(name = "mlService")
  public Map post(String path, Object body) {
    HttpHeaders h = new HttpHeaders();
    h.setContentType(MediaType.APPLICATION_JSON);
    ResponseEntity<Map> r = rt.postForEntity(mlUrl + path, new HttpEntity<>(body, h), Map.class);
    return r.getBody() != null ? r.getBody() : Map.of();
  }

  @SuppressWarnings("unused")
  Map fallback(String path, Object body, Throwable t) {
    log.warn("ML fallback for {}: {}", path, t.toString());
    throw new MlServiceException("Risk engine unavailable for " + path, t);
  }

  /** Liveness probe used by health indicator. */
  public boolean ping() {
    try {
      ResponseEntity<String> r = rt.getForEntity(mlUrl + "/health", String.class);
      return r.getStatusCode().is2xxSuccessful();
    } catch (Exception e) {
      return false;
    }
  }
}
