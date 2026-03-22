import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import DemoPage from './pages/Demo/DemoPage'
import AdminDashboard from './pages/Admin/Dashboard'
import RecordModePage from './pages/Admin/RecordMode'
import OverlayPage from './pages/OverlayPage'
import GhostCursorPage from './pages/GhostCursorPage'
import StartPage from './pages/StartPage'
import LoginPage, { isAuthed } from './pages/LoginPage'

function RequireAuth({ children }: { children: React.ReactNode }) {
  return isAuthed() ? <>{children}</> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"             element={<Navigate to="/admin" replace />} />
        <Route path="/login"        element={<LoginPage />} />
        <Route path="/admin"        element={<RequireAuth><AdminDashboard /></RequireAuth>} />
        <Route path="/admin/record" element={<RequireAuth><RecordModePage /></RequireAuth>} />
        <Route path="/start"        element={<StartPage />} />
        <Route path="/demo"         element={<DemoPage />} />
        <Route path="/overlay"      element={<OverlayPage />} />
        <Route path="/ghost-cursor" element={<GhostCursorPage />} />
      </Routes>
    </BrowserRouter>
  )
}
