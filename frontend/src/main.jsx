import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import AppShell from './layout/AppShell'
import DashboardPage from './pages/DashboardPage'
import ComparePage from './pages/ComparePage'
import SitePlanPage from './pages/SitePlanPage'
import ReportPage from './pages/ReportPage'
import PublicReport from './pages/PublicReport'
import { ErrorBoundary } from './components/ui'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <ErrorBoundary>
      <Routes>
      <Route path="/r/:token" element={<PublicReport />} />
      <Route path="/*" element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="siteplan" element={<SitePlanPage />} />
        <Route path="report" element={<ReportPage />} />
      </Route>
      </Routes>
    </ErrorBoundary>
  </BrowserRouter>
)
