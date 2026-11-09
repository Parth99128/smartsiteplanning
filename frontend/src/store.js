import { create } from 'zustand'
import { apiGet, apiPost, apiPut, apiDelete, checkHealth, serverMessage } from './lib/api'
import { fetchRealGrid } from './lib/terrain'
import { basementVerdict } from './lib/basement'

const PREFS_KEY = 'floodshield-prefs-v1'
const DEFAULT_SIM = { footprint_sqm: 800, plinth_m: 0.3, permeable_sqm: 300, storage_m3: 20, rain_garden: true, recharge: false, land_use_change_pct: 50, basement_levels: 0, basement_pump_lps: 0, basement_ramp_m: 0.45, basement_apron_sqm: 300, basement_standby: false }

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw)
    return {
      ...(typeof p.activeId === 'number' ? { activeId: p.activeId } : {}),
      ...(typeof p.climate === 'number' ? { climate: p.climate } : {}),
      ...(typeof p.dusk === 'boolean' ? { dusk: p.dusk } : {}),
      ...(p.simInputs ? { simInputs: { ...DEFAULT_SIM, ...p.simInputs } } : {}),
      ...(p.scenario ? { scenario: { surgeM: 0, blockedPct: 0, ...p.scenario } } : {}),
    }
  } catch { return {} }
}

function savePrefs(s) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      activeId: s.activeId, climate: s.climate, dusk: s.dusk,
      simInputs: s.simInputs, scenario: s.scenario,
    }))
  } catch { /* private mode */ }
}

export const useStore = create((set, get) => ({
  projects: [],
  activeId: null,
  analysis: null,
  simulation: null,
  mode: 'current',
  climate: 0,
  dusk: false,
  loading: false,
  toast: '',
  err: '',
  simInputs: { ...DEFAULT_SIM },
  scenario: { surgeM: 0, blockedPct: 0 },
  health: { ml: 'unknown', backend: 'unknown' },
  healthFails: 0,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  history: [],
  ...loadPrefs(),

  set: (p) => { set(p); savePrefs(get()) },

  notify: (toast, kind = 'info') => set({ toast: typeof toast === 'string' ? { msg: toast, kind } : toast }),
  dismissToast: () => set({ toast: '' }),
  clearError: () => set({ err: '' }),

  pushHistory: (entry) => set((s) => ({
    history: [{ ts: Date.now(), ...entry }, ...s.history].slice(0, 12),
  })),

  selectProject: (id) => {
    set({ activeId: Number(id), analysis: null, simulation: null, err: '' })
    savePrefs(get())
  },

  loadProjects: async () => {
    try {
      const r = await apiGet('/projects')
      const list = Array.isArray(r.data) ? r.data : []
      const { activeId } = get()
      const stillValid = list.some((p) => p.id === activeId)
      const nextActive = list.length ? (stillValid ? activeId : list[0].id) : null
      set({ projects: list, activeId: nextActive, err: '' })
      savePrefs({ ...get(), activeId: nextActive })
      return list
    } catch (e) {
      set({ err: 'Backend unavailable — check that the API is running and reachable.' })
      throw e
    }
  },

  createProject: async (payload) => {
    set({ loading: true, err: '' })
    try {
      const r = await apiPost('/projects', payload)
      const created = r.data
      if (created?.id == null) throw new Error('Server returned no project id')
      const list = [...get().projects, created]
      set({ projects: list, activeId: created.id, analysis: null, simulation: null })
      savePrefs(get())
      return created
    } catch (e) {
      const msg = serverMessage(e, 'Project creation failed — check the values and that the API is running.')
      set({ err: msg, toast: { msg, kind: 'error' } })
      throw e
    } finally {
      set({ loading: false })
    }
  },

  estimateSite: async (lat, lng, footprint_sqm) => {
    const r = await apiPost('/sites/estimate', { lat, lng, footprint_sqm })
    return r.data
  },

  // Municipal drain context (pilot cities). Null = geo-estimate only; never throws.
  siteContext: null,
  siteContextKey: '',
  loadSiteContext: async (lat, lng) => {
    const key = `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`
    if (get().siteContextKey === key && get().siteContext) return get().siteContext
    try {
      const r = await apiPost('/sites/context', { lat: Number(lat), lng: Number(lng), radius_m: 500 })
      set({ siteContext: r.data, siteContextKey: key })
      return r.data
    } catch {
      return null
    }
  },

  createAndAnalyze: async (payload) => {
    const created = await get().createProject(payload)
    // Prefer measured terrain for the first analysis; fall back silently.
    let body = null
    try {
      const t = await fetchRealGrid(payload.lat, payload.lng)
      body = { elevation_grid: t.grid, cell_m: t.cellM }
    } catch { /* synthetic path on the backend */ }
    try {
      await get().analyze(body)
    } catch {
      // project exists even if analysis (ML) is down — surface analysis error but keep project
    }
    return created
  },

  updateSite: async (id, lat, lng) => {
    const r = await apiPut(`/projects/${id}/site`, { lat, lng })
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...r.data } : p)),
    }))
    return r.data
  },

  refreshHealth: async () => {
    const h = await checkHealth()
    const down = h.backend === 'down'
    set((s) => ({
      health: h,
      healthFails: down ? s.healthFails + 1 : 0,
      // keep last known projects on transient blips; banner logic uses healthFails
    }))
    return h
  },

  analyze: async (body) => {
    const { activeId } = get()
    if (activeId == null) {
      const msg = 'No project selected — create a project first.'
      set({ err: msg, toast: { msg, kind: 'warn' } })
      throw new Error(msg)
    }
    set({ loading: true, err: '' })
    try {
      const r = await apiPost(`/projects/${activeId}/analyze`, body || {})
      set({ analysis: r.data, simulation: null })
      const risk = r.data?.risk?.risk_score
      get().pushHistory({ type: 'analyze', projectId: activeId, risk })
      return r.data
    } catch (e) {
      const status = e?.response?.status
      const msg = status === 503 || status === 502
        ? 'Risk engine unavailable — the model service is down or untrained.'
        : status === 404
          ? 'Project not found — it may have been deleted.'
          : 'Analysis failed — check the API and model service.';
      set({ err: msg, toast: { msg, kind: 'error' } })
      throw e
    } finally {
      set({ loading: false })
    }
  },

  simulate: async (patch = {}) => {
    const { activeId, simInputs, climate } = get()
    if (activeId == null) throw new Error('No project selected')
    const next = { ...simInputs, ...patch }
    const bv = basementVerdict({
      levels: next.basement_levels, pumpLps: next.basement_pump_lps,
      rampCrestM: next.basement_ramp_m, apronSqm: next.basement_apron_sqm,
      designRainMmHr: 100, standby: next.basement_standby,
    })
    next._basementVerdict = bv.levels ? bv.verdict : null
    next._basementInflowLps = bv.levels ? bv.inflowLps : null
    set({ simInputs: next, loading: true, err: '' })
    savePrefs(get())
    try {
      const body = { ...next, climate_uplift_pct: climate }
      const r = await apiPost(`/projects/${activeId}/simulate`, body)
      set({ simulation: r.data })
      get().pushHistory({
        type: 'simulate', projectId: activeId,
        risk: r.data?.risk_score, res: r.data?.resilience_score, badge: r.data?.badge,
      })
      return r.data
    } catch (e) {
      const msg = 'Simulation failed — check the API and model service.'
      set({ err: msg, toast: { msg, kind: 'error' } })
      throw e
    } finally {
      set({ loading: false })
    }
  },

  compare: async (ids) => {
    if (!ids?.length || ids.length < 2) throw new Error('Pick at least 2 projects')
    set({ loading: true, err: '' })
    try {
      const r = await apiGet('/compare', { params: { ids: ids.join(',') } })
      return r.data
    } catch (e) {
      set({ err: 'Comparison failed — check the API service.' })
      throw e
    } finally {
      set({ loading: false })
    }
  },

  makeReport: async () => {
    const { activeId } = get()
    if (activeId == null) throw new Error('No project selected')
    const r = await apiPost(`/projects/${activeId}/report`, {})
    return r.data
  },

  applyAll: async (dryRun = true) => {
    const { activeId } = get()
    if (activeId == null) throw new Error('No project selected')
    set({ loading: true, err: '' })
    try {
      const r = await apiPost(`/projects/${activeId}/recommendations/apply`, { dry_run: dryRun })
      if (!dryRun) {
        set({ simulation: r.data.after })
        get().pushHistory({
          type: 'simulate', projectId: activeId,
          risk: r.data.after?.risk_score, res: r.data.after?.resilience_score, badge: r.data.after?.badge,
        })
      }
      return r.data
    } catch (e) {
      const msg = serverMessage(e, 'Apply-all failed — check the API and model service.')
      set({ err: msg, toast: { msg, kind: 'error' } })
      throw e
    } finally {
      set({ loading: false })
    }
  },

  // ---- site zones ----
  loadZones: async () => {
    const { activeId } = get()
    if (activeId == null) return []
    const r = await apiGet(`/projects/${activeId}/zones`)
    return r.data
  },
  addZone: async (payload) => {
    const { activeId } = get()
    const r = await apiPost(`/projects/${activeId}/zones`, payload)
    return r.data
  },
  deleteZone: async (zoneId) => {
    const { activeId } = get()
    await apiDelete(`/projects/${activeId}/zones/${zoneId}`)
  },
  loadConflicts: async () => {
    const { activeId } = get()
    const r = await apiGet(`/projects/${activeId}/zone-conflicts`)
    return r.data
  },

  // ---- site assets (recharge pits, sumps, pumps) ----
  loadAssets: async () => {
    const { activeId } = get()
    if (activeId == null) return []
    const r = await apiGet(`/projects/${activeId}/assets`)
    return r.data
  },
  addAsset: async (payload) => {
    const { activeId } = get()
    const r = await apiPost(`/projects/${activeId}/assets`, payload)
    return r.data
  },
  deleteAsset: async (assetId) => {
    const { activeId } = get()
    await apiDelete(`/projects/${activeId}/assets/${assetId}`)
  },

  // ---- site plans ----
  loadPlans: async () => {
    const { activeId } = get()
    if (activeId == null) return []
    const r = await apiGet(`/projects/${activeId}/site-plans`)
    return r.data
  },
  uploadPlan: async (file, bounds) => {
    const { activeId } = get()
    const fd = new FormData()
    fd.append('image', file)
    fd.append('sw_lat', bounds.swLat)
    fd.append('sw_lng', bounds.swLng)
    fd.append('ne_lat', bounds.neLat)
    fd.append('ne_lng', bounds.neLng)
    const r = await apiPost(`/projects/${activeId}/site-plans`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return r.data
  },
  deletePlan: async (planId) => {
    const { activeId } = get()
    await apiDelete(`/projects/${activeId}/site-plans/${planId}`)
  },
}))
