/* Resilient API layer: retry safe GETs; never auto-retry POST/PUT (non-idempotent). */
import { api, mlDirect } from '../api'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function withRetry(fn, retries = 2, delayMs = 600) {
  let last
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      // Only retry network-level failures and 502/503/504 on idempotent reads.
      // Never retry 4xx (validation) and never retry mutating calls via this helper.
      const status = e?.response?.status
      const retryable = !e?.response || e.code === 'ECONNABORTED' || status === 502 || status === 503 || status === 504
      if (i === retries || !retryable) break
      await sleep(delayMs * (i + 1))
    }
  }
  throw last
}

export const apiGet = (url, cfg) => withRetry(() => api.get(url, cfg))
// POST/PUT/PATCH/DELETE are non-idempotent: single attempt, surface server message.
export const apiPost = (url, body, cfg) => api.post(url, body, cfg)
export const apiPut = (url, body, cfg) => api.put(url, body, cfg)
export const apiPatch = (url, body, cfg) => api.patch(url, body, cfg)
export const apiDelete = (url, cfg) => api.delete(url, cfg)

export function serverMessage(e, fallback) {
  return e?.response?.data?.message
    || e?.response?.data?.error
    || (e?.response ? `Request failed (${e.response.status})` : null)
    || (e?.code === 'ECONNABORTED' ? 'Request timed out — is the service running?'
    : e?.message?.includes('Network Error') ? 'Cannot reach the API — is the backend running?'
    : null)
    || fallback
}

export async function checkHealth() {
  const out = { ml: 'down', backend: 'down' }
  try {
    const r = await mlDirect.get('/health', { timeout: 6000 })
    if (r.status === 200) out.ml = r.data?.model_loaded === false ? 'degraded' : 'up'
  } catch { /* down */ }
  try {
    const r = await api.get('/projects', { timeout: 6000 })
    if (r.status === 200) out.backend = 'up'
  } catch { /* down */ }
  return out
}
