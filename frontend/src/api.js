import axios from 'axios'
const API = import.meta.env.VITE_API_URL || 'http://localhost:8080'
export const api = axios.create({ baseURL: API + '/api', timeout: 15000 })
export const mlDirect = axios.create({ baseURL: import.meta.env.VITE_ML_URL || 'http://localhost:8000', timeout: 15000 })
export const fmt = (n) => Number(n ?? 0).toFixed(1)
