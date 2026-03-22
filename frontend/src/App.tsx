import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import DemoPage from './pages/Demo/DemoPage'
import AdminDashboard from './pages/Admin/Dashboard'
import RecordModePage from './pages/Admin/RecordMode'
import OverlayPage from './pages/OverlayPage'
import GhostCursorPage from './pages/GhostCursorPage'
import StartPage from './pages/StartPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"             element={<Navigate to="/admin" replace />} />
        <Route path="/admin"        element={<AdminDashboard />} />
        <Route path="/admin/record" element={<RecordModePage />} />
        <Route path="/start"        element={<StartPage />} />
        <Route path="/demo"         element={<DemoPage />} />
        <Route path="/overlay"      element={<OverlayPage />} />
        <Route path="/ghost-cursor" element={<GhostCursorPage />} />
      </Routes>
    </BrowserRouter>
  )
}
