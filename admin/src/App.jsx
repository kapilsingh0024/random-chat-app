import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('admin-token') || '');
  const [admin, setAdmin] = useState(null);
  const [loginData, setLoginData] = useState({ email: 'admin@randomchat.local', password: 'admin123' });
  const [dashboard, setDashboard] = useState({ stats: {}, activeSessions: [], reports: [], recentAudit: [] });
  const [users, setUsers] = useState([]);
  const [status, setStatus] = useState('Ready');
  const [search, setSearch] = useState('');
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [moderationMessages, setModerationMessages] = useState([]);

  const socketRef = useRef(null);

  const connectAdminSocket = (adminToken) => {
    if (socketRef.current) socketRef.current.disconnect();
    const socket = io(`${API_URL}/admin`, {
      transports: ['websocket'],
      auth: { token: adminToken },
    });

    socketRef.current = socket;
    socket.on('dashboard:update', (payload) => setDashboard(payload));
    socket.on('moderation:session', ({ roomId, messages, users }) => {
      setSelectedRoom(roomId);
      setModerationMessages(messages || []);
    });
    socket.on('connect_error', () => setStatus('Admin socket connection failed.'));
  };

  const fetchDashboard = async (authToken = token) => {
    const response = await fetch(`${API_URL}/api/admin/dashboard`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await response.json();
    if (response.ok) setDashboard(data);
  };

  const fetchUsers = async (authToken = token) => {
    const response = await fetch(`${API_URL}/api/admin/users?search=${encodeURIComponent(search)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await response.json();
    if (response.ok) setUsers(data.users || []);
  };

  const login = async (event) => {
    event.preventDefault();

    const response = await fetch(`${API_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginData),
    });

    const data = await response.json();
    if (!response.ok) {
      setStatus(data.message || 'Login failed');
      return;
    }

    localStorage.setItem('admin-token', data.token);
    setToken(data.token);
    setAdmin(data.user);
    connectAdminSocket(data.token);
    setStatus('Admin connected');
    fetchDashboard(data.token);
    fetchUsers(data.token);
  };

  const actionUser = async (userId, action) => {
    const response = await fetch(`${API_URL}/api/admin/users/${userId}/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    setStatus(data.message || action);
    fetchUsers();
  };

  const resetPassword = async (userId) => {
    const response = await fetch(`${API_URL}/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    setStatus(data.message || 'Password reset');
    if (data.temporaryPassword) alert(`Temporary password: ${data.temporaryPassword}`);
  };

  const endSession = async (roomId) => {
    const response = await fetch(`${API_URL}/api/admin/sessions/${roomId}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    setStatus(data.message || 'Session ended');
    fetchDashboard();
  };

  const resolveReport = async (reportId) => {
    const response = await fetch(`${API_URL}/api/admin/reports/${reportId}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    setStatus(data.message || 'Report resolved');
    fetchDashboard();
  };

  const modJoinRoom = (roomId) => {
    socketRef.current.emit('moderation:join', { roomId });
    setSelectedRoom(roomId);
  };

  useEffect(() => {
    if (!token) return;
    connectAdminSocket(token);
    fetchDashboard(token);
    fetchUsers(token);
  }, [token]);

  useEffect(() => {
    if (token) fetchUsers();
  }, [search]);

  if (!admin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
        <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-8">
          <h1 className="mb-4 text-2xl font-bold text-cyan-400">Admin Login</h1>
          <form className="space-y-4" onSubmit={login}>
            <input
              type="email"
              placeholder="Admin email"
              value={loginData.email}
              onChange={(event) => setLoginData({ ...loginData, email: event.target.value })}
            />
            <input
              type="password"
              placeholder="Password"
              value={loginData.password}
              onChange={(event) => setLoginData({ ...loginData, password: event.target.value })}
            />
            <button type="submit" className="w-full bg-cyan-500 text-slate-950 hover:bg-cyan-400">Login</button>
          </form>
          <p className="mt-4 text-xs text-slate-400">{status}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-900 p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm text-slate-400">Admin</p>
            <h1 className="text-2xl font-bold text-cyan-400">Random Chat Control</h1>
          </div>
          <button
            className="bg-slate-700 text-slate-100 hover:bg-slate-600"
            onClick={() => {
              localStorage.removeItem('admin-token');
              setAdmin(null);
              setToken('');
            }}
          >
            Logout
          </button>
        </header>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5"><p className="text-sm text-slate-400">Online users</p><h2 className="mt-2 text-3xl font-bold">{dashboard.stats.onlineUsers || 0}</h2></div>
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5"><p className="text-sm text-slate-400">Active sessions</p><h2 className="mt-2 text-3xl font-bold">{dashboard.stats.activeSessions || 0}</h2></div>
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5"><p className="text-sm text-slate-400">Total users</p><h2 className="mt-2 text-3xl font-bold">{dashboard.stats.totalUsers || 0}</h2></div>
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5"><p className="text-sm text-slate-400">Reports</p><h2 className="mt-2 text-3xl font-bold">{dashboard.stats.totalReports || 0}</h2></div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Users</h2>
              <input
                className="max-w-xs"
                placeholder="Search users"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="space-y-3">
              {users.map((user) => (
                <div key={user.id} className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-950 p-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-semibold">{user.name}</p>
                    <p className="text-sm text-slate-400">{user.email}</p>
                    <p className="text-xs text-slate-500">Gender: {user.gender} • Role: {user.role}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="bg-purple-500 hover:bg-purple-400" onClick={() => actionUser(user.id, 'ban')}>Ban</button>
                    <button className="bg-red-500 hover:bg-red-400" onClick={() => actionUser(user.id, 'delete')}>Delete</button>
                    <button className="bg-slate-700 hover:bg-slate-600" onClick={() => resetPassword(user.id)}>Reset password</button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h2 className="mb-4 text-xl font-semibold">Live sessions</h2>
            <div className="space-y-3">
              {(dashboard.activeSessions || []).map((session) => (
                <div key={session.roomId} className="rounded-xl border border-slate-700 bg-slate-950 p-3">
                  <p className="font-medium">{session.users?.map((u) => u.name).join(' vs ') || session.roomId}</p>
                  <p className="text-sm text-slate-400">Mode: {session.mode}</p>
                  <div className="mt-2 flex gap-2">
                    <button className="bg-cyan-500 text-slate-950 hover:bg-cyan-400" onClick={() => modJoinRoom(session.roomId)}>Moderate</button>
                    <button className="bg-rose-600 hover:bg-rose-500" onClick={() => endSession(session.roomId)}>End session</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h2 className="mb-4 text-xl font-semibold">Reports</h2>
            <div className="space-y-3">
              {(dashboard.reports || []).map((report) => (
                <div key={report._id} className="rounded-xl border border-slate-700 bg-slate-950 p-3">
                  <p className="font-medium">Reported user: {report.reportedUserId}</p>
                  <p className="text-sm text-slate-400">Reason: {report.reason}</p>
                  <p className="text-xs text-slate-500">Status: {report.status}</p>
                  <button className="mt-2 bg-emerald-500 text-slate-950 hover:bg-emerald-400" onClick={() => resolveReport(report._id)}>Resolve</button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h2 className="mb-4 text-xl font-semibold">Moderation view</h2>
            {selectedRoom ? (
              <>
                <p className="mb-3 text-sm text-slate-400">Room: {selectedRoom}</p>
                <div className="mb-4 h-60 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-3">
                  {moderationMessages.length === 0 ? <p className="text-slate-400">No messages yet.</p> : moderationMessages.map((message, index) => (
                    <div key={`${message.timestamp || index}`} className="mb-2 rounded-lg bg-slate-800 px-3 py-2 text-sm">
                      {message.text}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-slate-400">Open a live session to begin moderation.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
          <h2 className="mb-4 text-xl font-semibold">Audit log</h2>
          <div className="space-y-2">
            {(dashboard.recentAudit || []).map((log) => (
              <div key={log._id} className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-300">
                <span className="font-medium text-cyan-400">{log.action}</span> — {log.details}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
