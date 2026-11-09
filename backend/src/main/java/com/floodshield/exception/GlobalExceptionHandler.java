package com.floodshield.exception;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/** RFC-7807-flavored error responses with trace ids; no stack traces leaked to clients. */
@RestControllerAdvice
public class GlobalExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  private ResponseEntity<Map<String, Object>> body(HttpStatus status, String code, String message, String path) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("timestamp", Instant.now().toString());
    m.put("status", status.value());
    m.put("error", status.getReasonPhrase());
    m.put("code", code);
    m.put("message", message);
    m.put("path", path);
    m.put("traceId", UUID.randomUUID().toString().substring(0, 8));
    return ResponseEntity.status(status).body(m);
  }

  @ExceptionHandler(NotFoundException.class)
  public ResponseEntity<Map<String, Object>> notFound(NotFoundException ex, HttpServletRequest req) {
    return body(HttpStatus.NOT_FOUND, "NOT_FOUND", ex.getMessage(), req.getRequestURI());
  }

  @ExceptionHandler(MlServiceException.class)
  public ResponseEntity<Map<String, Object>> mlDown(MlServiceException ex, HttpServletRequest req) {
    log.warn("ML service failure on {}: {}", req.getRequestURI(), ex.getMessage());
    return body(HttpStatus.BAD_GATEWAY, "ML_SERVICE_UNAVAILABLE",
      "Risk engine temporarily unavailable; retry shortly.", req.getRequestURI());
  }

  @ExceptionHandler(DataAccessException.class)
  public ResponseEntity<Map<String, Object>> dbDown(DataAccessException ex, HttpServletRequest req) {
    log.warn("DB failure on {}: {}", req.getRequestURI(), ex.getMostSpecificCause().getMessage());
    return body(HttpStatus.SERVICE_UNAVAILABLE, "DB_UNAVAILABLE",
      "Database temporarily unavailable; retry shortly.", req.getRequestURI());
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<Map<String, Object>> invalid(MethodArgumentNotValidException ex, HttpServletRequest req) {
    String msg = ex.getBindingResult().getFieldErrors().stream()
      .map(fe -> fe.getField() + " " + fe.getDefaultMessage())
      .collect(Collectors.joining("; "));
    return body(HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", msg, req.getRequestURI());
  }

  @ExceptionHandler({MethodArgumentTypeMismatchException.class, HttpMessageNotReadableException.class,
      IllegalArgumentException.class, NumberFormatException.class})
  public ResponseEntity<Map<String, Object>> badRequest(Exception ex, HttpServletRequest req) {
    return body(HttpStatus.BAD_REQUEST, "BAD_REQUEST", "Malformed request: " + ex.getMessage(), req.getRequestURI());
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<Map<String, Object>> generic(Exception ex, HttpServletRequest req) {
    log.error("Unhandled error on {}: {}", req.getRequestURI(), ex.getMessage(), ex);
    return body(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
      "Unexpected server error. Contact support with the trace id.", req.getRequestURI());
  }
}
