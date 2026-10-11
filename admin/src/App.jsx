import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const TOKEN_KEY = 'admin-token';

const fmtTime = (v) => (v ? new Date(v).toLocaleString() : '-');
const fmtDuration = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const userStatus = (u) => {
  if (u.isBanned) return { text: 'Banned', cls: 'bg-red-500/20 text-red-300' };
  if (u.suspendedUntil && new Date(u.suspendedUntil) > new Date()) return { text: `Suspended until ${new Date(u.suspendedUntil).toLocaleDateString()}`, cls: 'bg-amber-500/20 text-amber-300' };
  return { text: 'Active', cls: 'bg-emerald-500/15 text-emerald-300' };
};

export default function App() {
  const [token, setToken] = useState(localStorage.getItem(TOKEN_KEY) || '');
  const [admin, setAdmin] = useState(null);
  const [loginData, setLoginData] = useState({ email: '', password: '' });
  const [dashboard, setDashboard] = useState({ stats: {}, activeSessions: [], reports: [], recentAudit: [] });
  const [users, setUsers] = useState([]);
  const [status, setStatus] = useState('Ready');
  const [search, setSearch] = useState('');
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [modUsers, setModUsers] = useState([]);
  const [moderationMessages, setModerationMessages] = useState([]);
  const [modEnded, setModEnded] = useState(false);
  const [resetLink, setResetLink] = useState('');
  const [admins, setAdmins] = useState([]);
  const [newAdmin, setNewAdmin] = useState({ name: '', email: '', password: '' });
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState('');
  const [now, setNow] = useState(Date.now());
  const socketRef = useRef(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const roomRef = useRef(null);
  roomRef.current = selectedRoom;

  const logout = (message = 'Logged out') => {
    localStorage.removeItem(TOKEN_KEY);
    socketRef.current?.disconnect();
    socketRef.current = null;
    setAdmin(null);
    setToken('');
    setStatus(message);
  };

  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenRef.current}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { logout('Session expired. Please log in again.'); throw new Error('unauthorized'); }
    if (!response.ok) throw new Error(data.message || 'Request failed');
    return data;
  };

  const connectAdminSocket = (adminToken) => {
    socketRef.current?.disconnect();
    const socket = io(`${API_URL}/admin`, { transports: ['websocket'], auth: { token: adminToken } });
    socketRef.current = socket;
    socket.on('dashboard:update', setDashboard);
    socket.on('moderation:session', ({ roomId, messages, users: u }) => {
      setSelectedRoom(roomId);
      setModUsers(u || []);
      setModerationMessages(messages || []);
      setModEnded(!u || u.length === 0);
    });
    socket.on('moderation:message', ({ roomId, message }) => {
      if (roomRef.current === roomId) setModerationMessages((m) => [...m, message]);
    });
    socket.on('moderation:ended', ({ roomId }) => {
      if (roomRef.current === roomId) setModEnded(true);
    });
    socket.on('connect_error', () => setStatus('Live connection problem. Retrying...'));
  };

  const fetchDashboard = async () => { try { setDashboard(await call('/api/admin/dashboard')); } catch (e) { /* handled */ } };
  const fetchUsers = async () => {
    try { setUsers((await call(`/api/admin/users?search=${encodeURIComponent(search)}`)).users || []); } catch (e) { /* handled */ }
  };
  const fetchAdmins = async () => { try { setAdmins((await call('/api/admin/admins')).admins || []); } catch (e) { /* handled */ } };
  const addAdmin = async (event) => {
    event.preventDefault();
    try {
      const data = await call('/api/admin/admins', 'POST', newAdmin);
      setStatus(data.message);
      setNewAdmin({ name: '', email: '', password: '' });
      fetchAdmins(); fetchDashboard();
    } catch (e) { if (e.message !== 'unauthorized') setStatus(e.message); }
  };
  const changeOwnPassword = async (event) => {
    event.preventDefault();
    if (pw.next !== pw.confirm) { setPwMsg('The new passwords do not match.'); return; }
    try {
      const data = await call('/api/admin/change-password', 'POST', { currentPassword: pw.current, newPassword: pw.next });
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPwOpen(false); setPw({ current: '', next: '', confirm: '' }); setPwMsg('');
      setStatus('Password changed. Other devices were logged out.');
    } catch (e) { if (e.message !== 'unauthorized') setPwMsg(e.message); }
  };

  const act = async (path, confirmText, onDone) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      const data = await call(path, 'POST', path.endsWith('/suspend') ? { days: 7 } : undefined);
      setStatus(data.message || 'Done');
      if (onDone) onDone(data);
    } catch (e) { if (e.message !== 'unauthorized') setStatus(e.message); }
    fetchUsers(); fetchDashboard();
  };

  const login = async (event) => {
    event.preventDefault();
    try {
      const response = await fetch(`${API_URL}/api/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(loginData),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Login failed');
      localStorage.setItem(TOKEN_KEY, data.token);
      setLoginData({ ...loginData, password: '' });
      setToken(data.token);
    } catch (e) { setStatus(e.message); }
  };

  const moderate = (roomId) => {
    if (selectedRoom && selectedRoom !== roomId) socketRef.current?.emit('moderation:leave', { roomId: selectedRoom });
    setModerationMessages([]);
    setModEnded(false);
    socketRef.current?.emit('moderation:join', { roomId });
    setSelectedRoom(roomId);
  };

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        setAdmin((await call('/api/admin/me')).user);
        connectAdminSocket(token);
        fetchDashboard();
        fetchUsers();
        fetchAdmins();
      } catch (e) { /* logout handled in call() */ }
    })();
  }, [token]);

  useEffect(() => {
    if (!admin) return undefined;
    const t = setTimeout(fetchUsers, 300);
    return () => clearTimeout(t);
  }, [search, admin]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!admin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
        <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-8">
          <h1 className="mb-4 text-2xl font-bold text-cyan-400">Admin Login</h1>
          <form className="space-y-4" onSubmit={login}>
            <input type="email" placeholder="Admin email" value={loginData.email} onChange={(e) => setLoginData({ ...loginData, email: e.target.value })} />
            <input type="password" placeholder="Password" value={loginData.password} onChange={(e) => setLoginData({ ...loginData, password: e.target.value })} />
            <button type="submit" className="w-full bg-cyan-500 text-slate-950 hover:bg-cyan-400">Login</button>
          </form>
          <p className="mt-4 text-xs text-slate-400" role="status">{status}</p>
        </div>
      </div>
    );
  }

  const s = dashboard.stats || {};
  const cards = [['Online users', s.onlineUsers], ['Active sessions', s.activeSessions], ['Total users', s.totalUsers], ['Open reports', `${s.openReports || 0} / ${s.totalReports || 0}`]];
  const nameOf = (id) => modUsers.find((u) => u.userId === id)?.name || 'User';

  return (
    <div className="min-h-screen bg-slate-950 p-4 text-slate-100 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-900 p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm text-slate-400">{admin.email}</p>
            <h1 className="text-2xl font-bold text-cyan-400">Random Chat Control</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300" role="status">{status}</span>
            <button className="bg-slate-700 text-slate-100 hover:bg-slate-600" onClick={() => { setPwMsg(''); setPwOpen(true); }}>Change my password</button>
            <button className="bg-slate-700 text-slate-100 hover:bg-slate-600" onClick={() => logout()}>Logout</button>
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-4">
          {cards.map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
              <p className="text-sm text-slate-400">{label}</p>
              <h2 className="mt-2 text-3xl font-bold">{value || 0}</h2>
            </div>
          ))}
        </section>

        {resetLink && (
          <div className="rounded-2xl border border-cyan-700 bg-slate-900 p-4 text-sm">
            <p className="mb-2 text-slate-300">Password reset link (valid 1 hour). Send it to the user. It is shown only once.</p>
            <div className="flex gap-2">
              <input readOnly value={resetLink} onFocus={(e) => e.target.select()} />
              <button className="bg-cyan-500 text-slate-950" onClick={() => navigator.clipboard?.writeText(resetLink)}>Copy</button>
              <button className="bg-slate-700" onClick={() => setResetLink('')}>Hide</button>
            </div>
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">Users</h2>
              <input className="max-w-xs" placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="max-h-[32rem] space-y-3 overflow-y-auto">
              {users.map((u) => {
                const st = userStatus(u);
                const isAdmin = u.role === 'admin';
                return (
                  <div key={u.id} className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-950 p-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                      <p className="font-semibold">{u.name} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${st.cls}`}>{st.text}</span></p>
                      <p className="truncate text-sm text-slate-400">{u.email}</p>
                      <p className="text-xs text-slate-500">{u.gender} • {u.role} • joined {fmtTime(u.createdAt)} • last login {fmtTime(u.lastLogin)}</p>
                    </div>
                    {!isAdmin && (
                      <div className="flex flex-wrap gap-2">
                        {u.isBanned || st.text.startsWith('Suspended')
                          ? <button className="bg-emerald-500 text-slate-950 hover:bg-emerald-400" onClick={() => act(`/api/admin/users/${u.id}/unban`)}>Unban</button>
                          : <>
                              <button className="bg-amber-500 text-slate-950 hover:bg-amber-400" onClick={() => act(`/api/admin/users/${u.id}/suspend`, `Suspend ${u.email} for 7 days?`)}>Suspend 7d</button>
                              <button className="bg-purple-500 hover:bg-purple-400" onClick={() => act(`/api/admin/users/${u.id}/ban`, `Ban ${u.email}?`)}>Ban</button>
                            </>}
                        <button className="bg-slate-700 hover:bg-slate-600" onClick={() => act(`/api/admin/users/${u.id}/reset-password`, null, (d) => setResetLink(d.resetLink))}>Reset password</button>
                        <button className="bg-red-500 hover:bg-red-400" onClick={() => act(`/api/admin/users/${u.id}/delete`, `Permanently delete ${u.email}? This cannot be undone.`)}>Delete</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {users.length === 0 && <p className="text-slate-400">No users found.</p>}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h2 className="mb-4 text-xl font-semibold">Live sessions</h2>
            <div className="max-h-[32rem] space-y-3 overflow-y-auto">
              {(dashboard.activeSessions || []).map((sess) => (
                <div key={sess.roomId} className="rounded-xl border border-slate-700 bg-slate-950 p-3">
                  <p className="font-medium">{sess.users?.map((u) => u.name).join(' with ')}</p>
                  <p className="text-sm text-slate-400">Mode: {sess.mode} • {fmtDuration(now - sess.startedAt)}</p>
                  <div className="mt-2 flex gap-2">
                    <button className="bg-cyan-500 text-slate-950 hover:bg-cyan-400" onClick={() => moderate(sess.roomId)}>Moderate</button>
                    <button className="bg-rose-600 hover:bg-rose-500" onClick={() => act(`/api/admin/sessions/${sess.roomId}/end`, 'End this session now?')}>End session</button>
                  </div>
                </div>
              ))}
              {(dashboard.activeSessions || []).length === 0 && <p className="text-slate-400">No live sessions.</p>}
            </div>
          </section>
        </div>

        <section className="grid gap-6 xl:grid-cols-2">
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h2 className="mb-4 text-xl font-semibold">Reports</h2>
            <div className="max-h-[30rem] space-y-3 overflow-y-auto">
              {(dashboard.reports || []).map((r) => (
                <div key={r._id} className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm">
                  <p className="font-medium">{r.reportedUserId?.name || 'Deleted user'} <span className="text-slate-400">reported by {r.reporterId?.name || 'Deleted user'}</span></p>
                  <p className="text-slate-300">Reason: {r.reason}</p>
                  <p className="text-xs text-slate-500">{fmtTime(r.createdAt)} • {r.status}</p>
                  {(r.messages?.length > 0 || r.messageSnippet) && (
                    <div className="mt-2 rounded-lg bg-slate-900 p-2 text-xs text-slate-300">
                      {r.messages?.map((m, i) => <p key={i}><b>{m.from}:</b> {m.text}</p>)}
                      {r.messageSnippet && <p>{r.messageSnippet}</p>}
                    </div>
                  )}
                  {r.status === 'open' && (
                    <div className="mt-2 flex gap-2">
                      <button className="bg-emerald-500 text-slate-950 hover:bg-emerald-400" onClick={() => act(`/api/admin/reports/${r._id}/resolve`)}>Resolve</button>
                      <button className="bg-slate-700 hover:bg-slate-600" onClick={() => act(`/api/admin/reports/${r._id}/dismiss`)}>Dismiss</button>
                    </div>
                  )}
                </div>
              ))}
              {(dashboard.reports || []).length === 0 && <p className="text-slate-400">No reports.</p>}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h2 className="mb-4 text-xl font-semibold">Moderation view</h2>
            {selectedRoom ? (
              <>
                <p className="mb-1 text-sm text-slate-400">{modUsers.map((u) => u.name).join(' with ') || 'Session'}</p>
                {modEnded && <p className="mb-2 text-sm text-amber-300">This session has ended and its chat is gone.</p>}
                <div className="mb-3 h-72 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-3">
                  {moderationMessages.length === 0
                    ? <p className="text-slate-400">No messages yet.</p>
                    : moderationMessages.map((m, i) => (
                      <div key={`${m.timestamp}-${i}`} className="mb-2 rounded-lg bg-slate-800 px-3 py-2 text-sm">
                        <span className="font-semibold text-cyan-400">{nameOf(m.from)}:</span> {m.text}
                      </div>
                    ))}
                </div>
                {!modEnded && <button className="bg-rose-600 hover:bg-rose-500" onClick={() => act(`/api/admin/sessions/${selectedRoom}/end`, 'End this session now?')}>End this session</button>}
              </>
            ) : <p className="text-slate-400">Open a live session with "Moderate". Every time you do, it is written to the audit log.</p>}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
          <h2 className="mb-4 text-xl font-semibold">Admins</h2>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-2">
              {admins.map((a) => (
                <div key={a._id} className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm">
                  <p className="font-medium">{a.name} <span className="text-slate-400">{a.email}</span></p>
                  <p className="text-xs text-slate-500">created {fmtTime(a.createdAt)} • last login {fmtTime(a.lastLogin)}</p>
                </div>
              ))}
            </div>
            <form onSubmit={addAdmin} className="space-y-3">
              <p className="text-sm text-slate-300">Add a new admin</p>
              <input placeholder="Name" maxLength={40} value={newAdmin.name} onChange={(e) => setNewAdmin({ ...newAdmin, name: e.target.value })} />
              <input type="email" required placeholder="Email" value={newAdmin.email} onChange={(e) => setNewAdmin({ ...newAdmin, email: e.target.value })} />
              <input type="password" required minLength={10} autoComplete="new-password" placeholder="Password (10+ characters)" value={newAdmin.password} onChange={(e) => setNewAdmin({ ...newAdmin, password: e.target.value })} />
              <button type="submit" className="bg-cyan-500 text-slate-950 hover:bg-cyan-400">Create admin</button>
            </form>
          </div>
        </section>

        {pwOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <form onSubmit={changeOwnPassword} className="w-full max-w-sm space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-5">
              <h3 className="text-lg font-semibold">Change my password</h3>
              <input type="password" required placeholder="Current password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
              <input type="password" required minLength={10} placeholder="New password (10+ characters)" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
              <input type="password" required minLength={10} placeholder="Repeat new password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
              {pwMsg && <p className="text-sm text-rose-300" role="alert">{pwMsg}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" className="bg-slate-700 hover:bg-slate-600" onClick={() => setPwOpen(false)}>Cancel</button>
                <button type="submit" className="bg-cyan-500 text-slate-950 hover:bg-cyan-400">Save</button>
              </div>
            </form>
          </div>
        )}

        <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
          <h2 className="mb-4 text-xl font-semibold">Audit log</h2>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {(dashboard.recentAudit || []).map((log) => (
              <div key={log._id} className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-300">
                <span className="text-xs text-slate-500">{fmtTime(log.createdAt)}</span>{' '}
                <span className="text-slate-400">{log.adminEmail}</span>{' '}
                <span className="font-medium text-cyan-400">{log.action}</span>
                {log.details ? ` - ${log.details}` : ''}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
