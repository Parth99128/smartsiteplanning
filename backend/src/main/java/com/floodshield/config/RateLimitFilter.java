package com.floodshield.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Simple fixed-window rate limiter per client IP (in-memory; replace with
 * Redis/Bucket4j for multi-instance deployments).
 * Default: 120 requests/minute for reads, 30/minute for mutating calls.
 */
@Component
public class RateLimitFilter extends OncePerRequestFilter {

  private static final long WINDOW_MS = 60_000;
  private static final int READ_LIMIT = 120;
  private static final int WRITE_LIMIT = 30;

  private static class Bucket {
    volatile long windowStart = System.currentTimeMillis();
    final AtomicInteger count = new AtomicInteger();
  }

  private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();

  @Override
  protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws ServletException, IOException {
    String key = clientKey(req) + "|" + (isWrite(req) ? "w" : "r");
    int limit = isWrite(req) ? WRITE_LIMIT : READ_LIMIT;
    Bucket b = buckets.computeIfAbsent(key, k -> new Bucket());
    long now = System.currentTimeMillis();
    if (now - b.windowStart > WINDOW_MS) {
      b.windowStart = now;
      b.count.set(0);
    }
    if (b.count.incrementAndGet() > limit) {
      res.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
      res.setContentType("application/json");
      res.setHeader("Retry-After", "60");
      res.getWriter().write("{\"error\":\"rate_limit_exceeded\",\"message\":\"Too many requests; slow down.\"}");
      return;
    }
    chain.doFilter(req, res);
  }

  private boolean isWrite(HttpServletRequest req) {
    String m = req.getMethod();
    return "POST".equals(m) || "PUT".equals(m) || "DELETE".equals(m) || "PATCH".equals(m);
  }

  private String clientKey(HttpServletRequest req) {
    String fwd = req.getHeader("X-Forwarded-For");
    return fwd != null ? fwd.split(",")[0].trim() : req.getRemoteAddr();
  }
}
