package com.floodshield.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/** Adds a trace id to every request (MDC + response header) and logs method/path/status/latency. */
@Component
public class RequestLoggingFilter extends OncePerRequestFilter {

  private static final Logger log = LoggerFactory.getLogger(RequestLoggingFilter.class);

  @Override
  protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws ServletException, IOException {
    String traceId = UUID.randomUUID().toString().substring(0, 8);
    MDC.put("traceId", traceId);
    res.setHeader("X-Trace-Id", traceId);
    long start = System.currentTimeMillis();
    try {
      chain.doFilter(req, res);
    } finally {
      long ms = System.currentTimeMillis() - start;
      log.info("{} {} -> {} ({} ms)", req.getMethod(), req.getRequestURI(), res.getStatus(), ms);
      MDC.clear();
    }
  }
}
