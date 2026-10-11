require('dotenv').config();
const express = require('express');
const http = require('http');
const dns = require('dns');
const crypto = require('crypto');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

try { dns.setServers(['1.1.1.1', '1.0.0.1']); } catch (e) { /* keep default DNS */ }

const User = require('./src/models/User');
const Report = require('./src/models/Report');
const AuditLog = require('./src/models/AuditLog');
const {
  authMiddleware,
  adminAuthMiddleware,
  createToken,
  createAdminToken,
  accountProblem,
  loadUserFromToken,
  loadAdminFromToken,
} = require('./src/middleware/auth');

const isProd = process.env.NODE_ENV === 'production';
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Refusing to start.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174')
  .split(',').map((o) => o.trim()).filter(Boolean);
const corsOrigin = (origin, callback) =>
  (!origin || allowedOrigins.includes(origin)) ? callback(null, true) : callback(new Error('Origin not allowed by CORS'));

const io = new Server(server, { cors: { origin: corsOrigin, credentials: true }, maxHttpBufferSize: 1e5 });
const adminIo = io.of('/admin');

// ---------- small helpers ----------
const MODES = ['text', 'audio', 'video', 'audio-video'];
const PREFS = ['male', 'female', 'anyone'];
const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };
const safe = (fn) => async (...args) => { try { await fn(...args); } catch (e) { console.error('Handler error', e); } };

function sanitizeUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    gender: user.gender,
    role: user.role,
    matchPreference: user.matchPreference || 'anyone',
    ageConfirmed: user.ageConfirmed,
    createdAt: user.createdAt,
  };
}

function adminViewOfUser(user) {
  return {
    ...sanitizeUser(user),
    isBanned: !!user.isBanned,
    suspendedUntil: user.suspendedUntil || null,
    lastLogin: user.lastLogin || null,
  };
}

async function addAuditLog(adminId, adminEmail, action, details = '') {
  try {
    await AuditLog.create({ adminId, adminEmail, action, details: String(details).slice(0, 500) });
  } catch (e) { console.error('Audit log failed', e); }
}

// ---------- in-memory live state (NOTHING here is ever written to the database) ----------
const state = {
  waitingUsers: [],
  activeSessions: new Map(), // roomId -> { roomId, mode, startedAt, users:[{userId,name,socketId}], messages:[] }
  userSocketMap: new Map(),  // userId -> socket.id
  userRoomMap: new Map(),    // userId -> roomId
};

function allow(socket, key, max, windowMs) {
  const now = Date.now();
  socket.data.rate = socket.data.rate || {};
  const hits = (socket.data.rate[key] = socket.data.rate[key] || []);
  while (hits.length && now - hits[0] > windowMs) hits.shift();
  if (hits.length >= max) return false;
  hits.push(now);
  return true;
}

const removeWaitingUser = (userId) => {
  state.waitingUsers = state.waitingUsers.filter((e) => e.userId !== userId);
};

function sessionFor(socket, roomId) {
  if (typeof roomId !== 'string') return null;
  const session = state.activeSessions.get(roomId);
  if (!session) return null;
  const member = session.users.find((u) => u.userId === socket.userId && u.socketId === socket.id);
  return member ? session : null;
}
const peerOf = (session, userId) => session.users.find((u) => u.userId !== userId);

function canMatch(a, b) {
  if (a.mode !== b.mode) return false;
  if (a.blocked.has(b.userId) || b.blocked.has(a.userId)) return false;
  const wants = (source, target) => source.preference === 'anyone' || source.preference === target.gender;
  return wants(a, b) && wants(b, a);
}

function findMatch(request) {
  for (let i = 0; i < state.waitingUsers.length; i += 1) {
    const candidate = state.waitingUsers[i];
    if (!io.sockets.sockets.get(candidate.socketId)) { // stale entry
      state.waitingUsers.splice(i, 1);
      i -= 1;
      continue;
    }
    if (candidate.userId !== request.userId && canMatch(request, candidate)) return candidate;
  }
  return null;
}

// ---------- admin dashboard (debounced so it never hammers the DB) ----------
async function buildDashboard() {
  const [totalUsers, totalReports, openReports, reports, recentAudit] = await Promise.all([
    User.countDocuments({ isDeleted: false, role: 'user' }),
    Report.countDocuments({}),
    Report.countDocuments({ status: 'open' }),
    Report.find().sort({ createdAt: -1 }).limit(20).populate('reporterId reportedUserId', 'name email').lean(),
    AuditLog.find().sort({ createdAt: -1 }).limit(30).lean(),
  ]);
  const activeSessions = Array.from(state.activeSessions.values()).map((s) => ({
    roomId: s.roomId,
    mode: s.mode,
    startedAt: s.startedAt,
    duration: Date.now() - s.startedAt,
    users: s.users.map((u) => ({ userId: u.userId, name: u.name })),
  }));
  return {
    stats: {
      onlineUsers: state.userSocketMap.size,
      activeSessions: state.activeSessions.size,
      waitingUsers: state.waitingUsers.length,
      totalUsers,
      totalReports,
      openReports,
    },
    activeSessions,
    reports,
    recentAudit,
  };
}

let broadcastTimer = null;
function scheduleBroadcast() {
  if (broadcastTimer || adminIo.sockets.size === 0) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    try { adminIo.emit('dashboard:update', await buildDashboard()); } catch (e) { console.error(e); }
  }, 1000);
}

// ---------- sessions ----------
// Ending a session wipes its messages from memory and tells BOTH people.
function endSession(roomId, reason = 'ended', endedByUserId = null) {
  const session = state.activeSessions.get(roomId);
  if (!session) return false;
  state.activeSessions.delete(roomId);
  session.messages.length = 0;
  for (const u of session.users) {
    if (state.userRoomMap.get(u.userId) === roomId) state.userRoomMap.delete(u.userId);
    const s = io.sockets.sockets.get(u.socketId);
    if (s) {
      s.leave(roomId);
      s.emit('session:ended', { roomId, reason, endedByUserId });
    }
  }
  adminIo.to(`mod:${roomId}`).emit('moderation:ended', { roomId });
  scheduleBroadcast();
  return true;
}

function kickUser(userId, reason) {
  const socketId = state.userSocketMap.get(userId);
  const s = socketId && io.sockets.sockets.get(socketId);
  if (s) { s.emit('auth:kicked', { reason }); s.disconnect(true); }
}

async function startMatching(socket, preference, mode) {
  const userId = socket.userId;
  const current = state.userRoomMap.get(userId);
  if (current) endSession(current, 'next', userId);
  removeWaitingUser(userId);

  const user = await User.findById(userId);
  const problem = accountProblem(user);
  if (problem) { socket.emit('match:error', { message: problem }); return; }
  if (!socket.connected || state.userRoomMap.has(userId)) return;
  removeWaitingUser(userId);

  const request = {
    userId,
    name: user.name,
    gender: user.gender,
    preference,
    mode,
    socketId: socket.id,
    blocked: new Set((user.blockedUsers || []).map(String)),
    createdAt: Date.now(),
  };

  const match = findMatch(request);
  if (!match) {
    state.waitingUsers.push(request);
    socket.emit('match:waiting', { message: 'Looking for a match...' });
    scheduleBroadcast();
    return;
  }

  removeWaitingUser(match.userId);
  const peerSocket = io.sockets.sockets.get(match.socketId);
  const roomId = crypto.randomUUID();
  const session = {
    roomId,
    mode,
    startedAt: Date.now(),
    users: [
      { userId, name: user.name, socketId: socket.id },
      { userId: match.userId, name: match.name, socketId: match.socketId },
    ],
    messages: [],
  };
  state.activeSessions.set(roomId, session);
  state.userRoomMap.set(userId, roomId);
  state.userRoomMap.set(match.userId, roomId);
  socket.join(roomId);
  peerSocket.join(roomId);

  socket.emit('match:matched', { roomId, mode, isOfferer: true, peer: { userId: match.userId, name: match.name } });
  peerSocket.emit('match:matched', { roomId, mode, isOfferer: false, peer: { userId, name: user.name } });
  scheduleBroadcast();
}

// ---------- Express ----------
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct rate limiting
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '20kb' }));

const limiterOpts = { standardHeaders: true, legacyHeaders: false };
const authRateLimiter = rateLimit({ ...limiterOpts, windowMs: 60 * 1000, max: 10, message: { message: 'Too many attempts. Please wait before trying again.' } });
const adminLoginLimiter = rateLimit({ ...limiterOpts, windowMs: 15 * 60 * 1000, max: 8, message: { message: 'Too many admin login attempts. Try again later.' } });
const apiLimiter = rateLimit({ ...limiterOpts, windowMs: 60 * 1000, max: 240, message: { message: 'Too many requests.' } });
const reportLimiter = rateLimit({
  ...limiterOpts,
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user.id,
  message: { message: 'Report limit reached. Try again later.' },
});
const passwordLimiter = rateLimit({
  ...limiterOpts,
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyGenerator: (req) => (req.user || req.admin).id,
  message: { message: 'Too many password attempts. Try again later.' },
});
app.use('/api', apiLimiter);

async function ensureAdminUser() {
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@randomchat.local').toLowerCase();
  const existing = await User.findOne({ email: adminEmail });
  if (existing) return existing;

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || (isProd && adminPassword === 'admin123')) {
    console.warn('No safe ADMIN_PASSWORD set - admin account NOT created.');
    return null;
  }
  return User.create({
    name: 'System Admin',
    email: adminEmail,
    passwordHash: await bcrypt.hash(adminPassword, 12),
    gender: 'female',
    ageConfirmed: true,
    role: 'admin',
    matchPreference: 'anyone',
  });
}

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ----- user auth -----
app.post('/api/auth/signup', authRateLimiter, async (req, res) => {
  try {
    const name = str(req.body.name, 40);
    const email = str(req.body.email, 120).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const gender = str(req.body.gender, 10).toLowerCase();
    const matchPreference = PREFS.includes(req.body.matchPreference) ? req.body.matchPreference : 'anyone';

    if (!name) return res.status(400).json({ message: 'Name is required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email.' });
    if (password.length < 8 || password.length > 100) return res.status(400).json({ message: 'Password must be 8-100 characters.' });
    if (!['male', 'female'].includes(gender)) return res.status(400).json({ message: 'Gender must be male or female.' });
    if (req.body.ageConfirmed !== true) return res.status(400).json({ message: 'You must confirm that you are 18 or older.' });

    if (await User.exists({ email })) return res.status(409).json({ message: 'User already exists with this email.' });

    const createdUser = await User.create({
      name, email, gender, matchPreference,
      passwordHash: await bcrypt.hash(password, 12),
      ageConfirmed: true,
      role: 'user',
    });
    res.status(201).json({ user: sanitizeUser(createdUser), token: createToken(createdUser) });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ message: 'User already exists with this email.' });
    console.error('Signup error', error);
    res.status(500).json({ message: 'Failed to create user account.' });
  }
});

app.post('/api/auth/login', authRateLimiter, async (req, res) => {
  try {
    const email = str(req.body.email, 120).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });

    const user = await User.findOne({ email, role: 'user' });
    if (!user || user.isDeleted || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }
    const problem = accountProblem(user);
    if (problem) return res.status(403).json({ message: problem });

    user.lastLogin = new Date();
    await user.save();
    res.json({ user: sanitizeUser(user), token: createToken(user) });
  } catch (error) {
    console.error('Login error', error);
    res.status(500).json({ message: 'Failed to log in.' });
  }
});

// Admin gives the user a one-hour link; the user chooses a new password with it.
app.post('/api/auth/reset', authRateLimiter, async (req, res) => {
  try {
    const token = str(req.body.token, 200);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (password.length < 8 || password.length > 100) return res.status(400).json({ message: 'Password must be 8-100 characters.' });
    const user = token && await User.findOne({ resetTokenHash: sha(token), resetExpires: { $gt: new Date() } });
    if (!user) return res.status(400).json({ message: 'Reset link is invalid or expired.' });
    user.passwordHash = await bcrypt.hash(password, 12);
    user.passwordChangedAt = new Date();
    user.resetTokenHash = null;
    user.resetExpires = null;
    await user.save();
    res.json({ message: 'Password updated. You can log in now.' });
  } catch (error) {
    console.error('Reset error', error);
    res.status(500).json({ message: 'Unable to reset password.' });
  }
});

// Shared by users and admins. Returns an error message, or null when the password was changed.
async function changePassword(user, body) {
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  const min = user.role === 'admin' ? 10 : 8;
  if (next.length < min || next.length > 100) return `New password must be ${min}-100 characters.`;
  if (!(await bcrypt.compare(current, user.passwordHash))) return 'Current password is wrong.';
  if (current === next) return 'New password must be different from the current one.';
  user.passwordHash = await bcrypt.hash(next, 12);
  user.passwordChangedAt = new Date(); // logs out every other device
  user.resetTokenHash = null;
  user.resetExpires = null;
  await user.save();
  return null;
}

app.post('/api/auth/change-password', authMiddleware, passwordLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const error = user && await changePassword(user, req.body);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    if (error) return res.status(400).json({ message: error });
    res.json({ message: 'Password changed.', token: createToken(user) });
  } catch (e) {
    console.error('Change password error', e);
    res.status(500).json({ message: 'Unable to change password.' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ user: sanitizeUser(user) });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load profile.' });
  }
});

// Optional: time-limited TURN credentials (coturn "use-auth-secret").
// Set TURN_URLS + TURN_SECRET on the backend to use it; otherwise the client falls back to VITE_TURN_*.
app.get('/api/ice', authMiddleware, (req, res) => {
  const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const iceServers = [];
  const stun = list(process.env.STUN_URLS);
  if (stun.length) iceServers.push({ urls: stun });
  const turn = list(process.env.TURN_URLS);
  if (turn.length && process.env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + 3600}:${req.user.id}`;
    const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: turn, username, credential });
  }
  res.json({ iceServers });
});

// ----- reports: reporter id, reported id, time, reason (+ messages ONLY if the reporter agreed) -----
app.post('/api/reports', authMiddleware, reportLimiter, async (req, res) => {
  try {
    const { reportedUserId, messages } = req.body;
    const reason = str(req.body.reason, 500);
    if (!isId(reportedUserId) || reportedUserId === req.user.id) return res.status(400).json({ message: 'Invalid user.' });
    if (reason.length < 3) return res.status(400).json({ message: 'Please tell us what happened.' });

    // You can only report the person you are chatting with right now.
    const roomId = state.userRoomMap.get(req.user.id);
    const session = roomId && state.activeSessions.get(roomId);
    if (!session || !session.users.some((u) => u.userId === reportedUserId)) {
      return res.status(403).json({ message: 'You can only report the person you are chatting with.' });
    }

    const attached = Array.isArray(messages)
      ? messages.slice(-10).map((m) => ({ from: m && m.from === req.user.id ? 'reporter' : 'reported', text: str(m && m.text, 500) })).filter((m) => m.text)
      : [];

    await Report.create({ reporterId: req.user.id, reportedUserId, reason, messages: attached });
    adminIo.emit('report:new', { reportedUserId });
    scheduleBroadcast();
    res.status(201).json({ message: 'Report submitted. Thank you.' });
  } catch (error) {
    console.error('Report error', error);
    res.status(500).json({ message: 'Failed to save report.' });
  }
});

// ----- admin API -----
app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
  try {
    const email = str(req.body.email, 120).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = email && password && await User.findOne({ email, role: 'admin' });
    if (!user || accountProblem(user) || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: 'Invalid admin credentials.' });
    }
    user.lastLogin = new Date();
    await user.save();
    await addAuditLog(user._id, user.email, 'admin_login');
    res.json({ user: sanitizeUser(user), token: createAdminToken(user) });
  } catch (error) {
    console.error('Admin login error', error);
    res.status(500).json({ message: 'Unable to log in as admin.' });
  }
});

app.use('/api/admin', adminAuthMiddleware);

const lastView = new Map(); // throttle noisy "view" audit entries to once per 5 minutes
function auditView(admin, action, details = '') {
  const key = `${admin.id}:${action}`;
  if (Date.now() - (lastView.get(key) || 0) < 5 * 60 * 1000) return;
  lastView.set(key, Date.now());
  addAuditLog(admin.id, admin.email, action, details);
}
const audit = (req, action, details) => addAuditLog(req.admin.id, req.admin.email, action, details);
const wrap = (message, fn) => async (req, res) => {
  try { await fn(req, res); } catch (error) { console.error(message, error); res.status(500).json({ message }); }
};

// Loads a normal (non-admin) user from :id, or answers with an error.
async function targetUser(req, res) {
  if (!isId(req.params.id)) { res.status(400).json({ message: 'Invalid user id.' }); return null; }
  const user = await User.findById(req.params.id);
  if (!user) { res.status(404).json({ message: 'User not found.' }); return null; }
  if (user.role === 'admin') { res.status(403).json({ message: 'Admin accounts cannot be changed from the panel.' }); return null; }
  return user;
}

app.get('/api/admin/me', (req, res) => res.json({ user: req.admin }));

app.post('/api/admin/change-password', passwordLimiter, wrap('Unable to change password.', async (req, res) => {
  const user = await User.findById(req.admin.id);
  const error = await changePassword(user, req.body);
  if (error) return res.status(400).json({ message: error });
  await audit(req, 'change_own_password');
  res.json({ message: 'Password changed.', token: createAdminToken(user) });
}));

app.get('/api/admin/admins', wrap('Unable to load admins.', async (req, res) => {
  auditView(req.admin, 'view_admins');
  const admins = await User.find({ role: 'admin', isDeleted: false }).select('name email createdAt lastLogin').sort({ createdAt: 1 }).lean();
  res.json({ admins });
}));

app.post('/api/admin/admins', wrap('Unable to create admin.', async (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  const name = str(req.body.name, 40) || 'Admin';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email.' });
  if (password.length < 10 || password.length > 100) return res.status(400).json({ message: 'Admin password must be 10-100 characters.' });
  if (await User.exists({ email })) return res.status(409).json({ message: 'An account with this email already exists.' });
  await User.create({
    name, email, gender: 'female', ageConfirmed: true, role: 'admin', matchPreference: 'anyone',
    passwordHash: await bcrypt.hash(password, 12),
  });
  await audit(req, 'create_admin', `New admin created: ${email}`);
  res.status(201).json({ message: `Admin ${email} created. Share the password with them safely.` });
}));

app.get('/api/admin/dashboard', wrap('Unable to load admin dashboard.', async (req, res) => {
  auditView(req.admin, 'view_dashboard');
  res.json(await buildDashboard());
}));

app.get('/api/admin/sessions', wrap('Unable to load sessions.', async (req, res) => {
  auditView(req.admin, 'view_sessions');
  res.json({
    sessions: Array.from(state.activeSessions.values()).map((s) => ({
      roomId: s.roomId, mode: s.mode, startedAt: s.startedAt,
      users: s.users.map((u) => ({ userId: u.userId, name: u.name })),
    })),
  });
}));

app.post('/api/admin/sessions/:roomId/end', wrap('Unable to end session.', async (req, res) => {
  const session = state.activeSessions.get(req.params.roomId);
  if (!session) return res.status(404).json({ message: 'Session not found (already ended).' });
  const names = session.users.map((u) => u.name).join(' & ');
  endSession(req.params.roomId, 'admin-ended');
  await audit(req, 'end_session', `Ended session of ${names} (${req.params.roomId}).`);
  res.json({ message: 'Session ended successfully.' });
}));

app.get('/api/admin/users', wrap('Unable to load users.', async (req, res) => {
  const search = str(req.query.search, 60);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filter = { isDeleted: false };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }
  auditView(req.admin, 'view_users', search ? `search: ${search}` : '');
  const [users, total] = await Promise.all([
    User.find(filter).select('-passwordHash -resetTokenHash').sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean(),
    User.countDocuments(filter),
  ]);
  res.json({ users: users.map(adminViewOfUser), total, page });
}));

app.post('/api/admin/users/:id/ban', wrap('Unable to ban user.', async (req, res) => {
  const user = await targetUser(req, res); if (!user) return;
  user.isBanned = true;
  await user.save();
  kickUser(user._id.toString(), 'banned');
  await audit(req, 'ban_user', `User ${user.email} was banned.`);
  scheduleBroadcast();
  res.json({ message: 'User banned successfully.' });
}));

app.post('/api/admin/users/:id/unban', wrap('Unable to unban user.', async (req, res) => {
  const user = await targetUser(req, res); if (!user) return;
  user.isBanned = false;
  user.suspendedUntil = null;
  await user.save();
  await audit(req, 'unban_user', `User ${user.email} was unbanned.`);
  res.json({ message: 'User can log in again.' });
}));

app.post('/api/admin/users/:id/suspend', wrap('Unable to suspend user.', async (req, res) => {
  const user = await targetUser(req, res); if (!user) return;
  const days = Math.min(365, Math.max(1, parseInt(req.body.days, 10) || 7));
  user.suspendedUntil = new Date(Date.now() + days * 86400000);
  await user.save();
  kickUser(user._id.toString(), 'suspended');
  await audit(req, 'suspend_user', `User ${user.email} suspended for ${days} day(s).`);
  scheduleBroadcast();
  res.json({ message: `User suspended for ${days} day(s).` });
}));

app.post('/api/admin/users/:id/delete', wrap('Unable to delete user.', async (req, res) => {
  const user = await targetUser(req, res); if (!user) return;
  kickUser(user._id.toString(), 'deleted');
  await User.deleteOne({ _id: user._id }); // real delete, the email can be used again
  await audit(req, 'delete_user', `User ${user.email} was deleted.`);
  scheduleBroadcast();
  res.json({ message: 'User deleted successfully.' });
}));

app.post('/api/admin/users/:id/reset-password', wrap('Unable to reset password.', async (req, res) => {
  const user = await targetUser(req, res); if (!user) return;
  const token = crypto.randomBytes(32).toString('hex');
  user.resetTokenHash = sha(token);
  user.resetExpires = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();
  const base = (process.env.CLIENT_URL || allowedOrigins[0] || '').replace(/\/$/, '');
  await audit(req, 'reset_password', `Reset link created for ${user.email}.`);
  res.json({ message: 'Reset link created (valid for 1 hour). Send it to the user.', resetLink: `${base}/?reset=${token}` });
}));

app.get('/api/admin/reports', wrap('Unable to load reports.', async (req, res) => {
  auditView(req.admin, 'view_reports');
  const reports = await Report.find().sort({ createdAt: -1 }).limit(200).populate('reporterId reportedUserId', 'name email').lean();
  res.json({ reports });
}));

for (const [action, status] of [['resolve', 'resolved'], ['dismiss', 'dismissed']]) {
  app.post(`/api/admin/reports/:id/${action}`, wrap('Unable to update report.', async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid report id.' });
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ message: 'Report not found.' });
    report.status = status;
    await report.save();
    await audit(req, `${action}_report`, `Report ${report._id} marked ${status}.`);
    scheduleBroadcast();
    res.json({ message: `Report marked as ${status}.` });
  }));
}

app.get('/api/admin/audit', wrap('Unable to load audit log.', async (req, res) => {
  res.json({ logs: await AuditLog.find().sort({ createdAt: -1 }).limit(200).lean() });
}));

app.use((error, req, res, next) => {
  console.error('Unhandled app error', error);
  res.status(500).json({ message: 'Server error.' });
});

// ---------- user sockets ----------
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    if (!token) return next(new Error('Authentication token missing.'));
    const user = await loadUserFromToken(token);
    socket.userId = user._id.toString();
    next();
  } catch (error) {
    next(new Error('Invalid or inactive account.'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId;

  // one live connection per account
  const oldSocketId = state.userSocketMap.get(userId);
  if (oldSocketId && oldSocketId !== socket.id) {
    const old = io.sockets.sockets.get(oldSocketId);
    if (old) { old.emit('auth:kicked', { reason: 'Signed in from another tab or device.' }); old.disconnect(true); }
  }
  state.userSocketMap.set(userId, socket.id);
  socket.emit('connected', { userId, status: 'connected' });
  scheduleBroadcast();

  socket.on('match:request', safe(async ({ preference, mode } = {}) => {
    if (!PREFS.includes(preference) || !MODES.includes(mode)) {
      return socket.emit('match:error', { message: 'Invalid match options.' });
    }
    if (!allow(socket, 'match', 20, 60 * 1000)) {
      return socket.emit('match:error', { message: 'Too many requests. Slow down a little.' });
    }
    socket.data.lastMatch = { preference, mode };
    await startMatching(socket, preference, mode);
  }));

  socket.on('match:cancel', safe(() => {
    state.waitingUsers = state.waitingUsers.filter((e) => e.socketId !== socket.id);
    scheduleBroadcast();
  }));

  socket.on('chat:message', safe(({ roomId, text } = {}) => {
    const session = sessionFor(socket, roomId);
    const clean = str(text, 500);
    if (!session || !clean || !allow(socket, 'msg', 10, 5000)) return;
    const message = { from: userId, text: clean, timestamp: Date.now() };
    session.messages.push(message);
    if (session.messages.length > 50) session.messages.shift();
    io.to(roomId).emit('chat:message', message);
    adminIo.to(`mod:${roomId}`).emit('moderation:message', { roomId, message });
  }));

  // WebRTC signalling - only between the two members of the same session
  const relay = (event, build) => socket.on(event, safe((data = {}) => {
    const session = sessionFor(socket, data.roomId);
    if (!session || JSON.stringify(data).length > 20000) return;
    const peer = peerOf(session, userId);
    if (peer) io.to(peer.socketId).emit(event, { ...build(data), from: userId, roomId: data.roomId });
  }));
  relay('webrtc:offer', (d) => ({ offer: d.offer, mode: d.mode }));
  relay('webrtc:answer', (d) => ({ answer: d.answer }));
  relay('webrtc:ice-candidate', (d) => ({ candidate: d.candidate }));

  socket.on('session:next', safe(async ({ roomId } = {}) => {
    if (!sessionFor(socket, roomId)) {
      // not in a session (e.g. partner already left): just search again
      const last = socket.data.lastMatch;
      if (last && allow(socket, 'match', 20, 60 * 1000)) await startMatching(socket, last.preference, last.mode);
      return;
    }
    endSession(roomId, 'next', userId);
    const last = socket.data.lastMatch;
    if (last && allow(socket, 'match', 20, 60 * 1000)) await startMatching(socket, last.preference, last.mode);
  }));

  socket.on('session:end', safe(({ roomId } = {}) => {
    if (sessionFor(socket, roomId)) endSession(roomId, 'ended', userId);
  }));

  // Block = remembered for this account, so you are never matched again
  socket.on('user:block', safe(async ({ roomId } = {}, ack) => {
    const session = sessionFor(socket, roomId);
    if (!session) return reply(ack, { ok: false });
    const peer = peerOf(session, userId);
    await User.updateOne({ _id: userId }, { $addToSet: { blockedUsers: peer.userId } });
    endSession(roomId, 'blocked', userId);
    reply(ack, { ok: true });
  }));

  socket.on('disconnect', () => {
    if (state.userSocketMap.get(userId) === socket.id) state.userSocketMap.delete(userId);
    state.waitingUsers = state.waitingUsers.filter((e) => e.socketId !== socket.id);
    const roomId = state.userRoomMap.get(userId);
    const session = roomId && state.activeSessions.get(roomId);
    if (session && session.users.some((u) => u.userId === userId && u.socketId === socket.id)) {
      endSession(roomId, 'disconnect', userId);
    }
    scheduleBroadcast();
  });
});

// ---------- admin sockets ----------
adminIo.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    if (!token) return next(new Error('Admin token missing.'));
    const admin = await loadAdminFromToken(token);
    socket.adminId = admin._id.toString();
    socket.adminEmail = admin.email;
    next();
  } catch (error) {
    next(new Error('Admin access denied.'));
  }
});

adminIo.on('connection', safe(async (socket) => {
  socket.emit('dashboard:update', await buildDashboard());

  // Opening a live chat is always written to the audit log.
  socket.on('moderation:join', safe(async ({ roomId } = {}) => {
    const session = typeof roomId === 'string' && state.activeSessions.get(roomId);
    if (!session) return socket.emit('moderation:session', { roomId, messages: [], users: [] });
    await addAuditLog(socket.adminId, socket.adminEmail, 'moderate_session',
      `Opened live chat of ${session.users.map((u) => u.name).join(' & ')} (${roomId}).`);
    socket.join(`mod:${roomId}`);
    socket.emit('moderation:session', {
      roomId,
      messages: session.messages,
      users: session.users.map((u) => ({ userId: u.userId, name: u.name })),
    });
  }));
  socket.on('moderation:leave', ({ roomId } = {}) => { if (typeof roomId === 'string') socket.leave(`mod:${roomId}`); });
  socket.on('sessions:request', () => scheduleBroadcast());
}));

process.on('unhandledRejection', (e) => console.error('Unhandled rejection', e));

const PORT = Number(process.env.PORT) || 5000;
mongoose
  .connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/randomchat')
  .then(async () => {
    console.log('MongoDB connected');
    await ensureAdminUser();
    server.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
  })
  .catch((error) => {
    console.error('MongoDB connection failed:', error);
    process.exit(1);
  });
