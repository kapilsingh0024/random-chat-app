const express = require('express');
const http = require('http');
const dns = require('dns');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
require('dotenv').config();

dns.setServers(['1.1.1.1', '1.0.0.1']);

const User = require('./src/models/User');
const Report = require('./src/models/Report');
const AuditLog = require('./src/models/AuditLog');
const { authMiddleware, adminAuthMiddleware } = require('./src/middleware/auth');

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174').split(',').map((origin) => origin.trim());

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed by CORS'));
      }
    },
    credentials: true,
  },
});

const adminIo = io.of('/admin');
const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait before trying again.' },
});

const state = {
  waitingUsers: [],
  activeSessions: new Map(),
  socketUserMap: new Map(),
  userSocketMap: new Map(),
};

function createToken(user) {
  return jwt.sign(
    {
      id: user._id.toString(),
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

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

function createMatchRequest(user, socketId, mode = 'text') {
  return {
    userId: user._id.toString(),
    name: user.name,
    gender: user.gender,
    preference: user.matchPreference || 'anyone',
    mode,
    socketId,
    createdAt: Date.now(),
  };
}

function removeWaitingUser(userId) {
  state.waitingUsers = state.waitingUsers.filter((entry) => entry.userId !== userId);
}

function getOtherUser(session, currentUserId) {
  return session.users.find((entry) => entry.userId !== currentUserId) || null;
}

function canMatch(a, b) {
  const matchesPreference = (source, target) => {
    if (source.preference === 'male') return target.gender === 'male';
    if (source.preference === 'female') return target.gender === 'female';
    return true;
  };

  return matchesPreference(a, b) && matchesPreference(b, a);
}

function findMatch(request) {
  for (let index = 0; index < state.waitingUsers.length; index += 1) {
    const candidate = state.waitingUsers[index];
    if (candidate.userId === request.userId) continue;
    if (canMatch(request, candidate)) return candidate;
  }
  return null;
}

async function broadcastAdminStats() {
  const totalUsers = await User.countDocuments({ isDeleted: false });
  const totalReports = await Report.countDocuments({});
  const activeSessions = Array.from(state.activeSessions.values()).map((session) => ({
    roomId: session.roomId,
    mode: session.mode,
    startedAt: session.startedAt,
    duration: Date.now() - session.startedAt,
    users: session.users.map((user) => ({ userId: user.userId, name: user.name })),
  }));

  const payload = {
    stats: {
      onlineUsers: state.userSocketMap.size,
      activeSessions: state.activeSessions.size,
      totalUsers,
      totalReports,
    },
    activeSessions,
    reports: await Report.find().sort({ createdAt: -1 }).limit(20).lean(),
    recentAudit: await AuditLog.find().sort({ createdAt: -1 }).limit(10).lean(),
  };

  adminIo.emit('dashboard:update', payload);
  return payload;
}

async function endSession(roomId, endedByUserId, reason = 'ended') {
  const session = state.activeSessions.get(roomId);
  if (!session) return;

  const otherUser = getOtherUser(session, endedByUserId);

  if (otherUser) {
    const targetSocket = io.sockets.sockets.get(otherUser.socketId);
    if (targetSocket) {
      targetSocket.emit('session:ended', {
        roomId,
        reason,
        endedByUserId,
      });
    }
  }

  const endingSocket = io.sockets.sockets.get(state.userSocketMap.get(endedByUserId));
  if (endingSocket) {
    endingSocket.emit('session:ended', {
      roomId,
      reason,
      endedByUserId,
    });
  }

  state.activeSessions.delete(roomId);
  await broadcastAdminStats();
}

async function addAuditLog(adminId, adminEmail, action, details = '') {
  await AuditLog.create({
    adminId,
    adminEmail,
    action,
    details,
  });
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed by CORS'));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

async function ensureAdminUser() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@randomchat.local';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  const existingAdmin = await User.findOne({ email: adminEmail });
  if (existingAdmin) return existingAdmin;

  const admin = await User.create({
    name: 'System Admin',
    email: adminEmail,
    passwordHash: await bcrypt.hash(adminPassword, 10),
    gender: 'female',
    ageConfirmed: true,
    role: 'admin',
    matchPreference: 'anyone',
  });

  return admin;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/auth/signup', authRateLimiter, async (req, res) => {
  try {
    const { name, email, password, gender, ageConfirmed, matchPreference } = req.body;

    if (!name || !email || !password || !gender || !ageConfirmed) {
      return res.status(400).json({ message: 'Name, email, password, gender and age confirmation are required.' });
    }

    const normalizedGender = gender.toLowerCase();
    if (!['male', 'female'].includes(normalizedGender)) {
      return res.status(400).json({ message: 'Gender must be male or female.' });
    }

    const emailExists = await User.findOne({ email: email.toLowerCase() });
    if (emailExists) {
      return res.status(409).json({ message: 'User already exists with this email.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const createdUser = await User.create({
      name,
      email: email.toLowerCase(),
      passwordHash,
      gender: normalizedGender,
      ageConfirmed: true,
      matchPreference: matchPreference || 'anyone',
      role: 'user',
    });

    const token = createToken(createdUser);
    res.status(201).json({
      user: sanitizeUser(createdUser),
      token,
    });
  } catch (error) {
    console.error('Signup error', error);
    res.status(500).json({ message: 'Failed to create user account.' });
  }
});

app.post('/api/auth/login', authRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || user.isDeleted || user.isBanned) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = createToken(user);
    res.json({
      user: sanitizeUser(user),
      token,
    });
  } catch (error) {
    console.error('Login error', error);
    res.status(500).json({ message: 'Failed to log in.' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user: sanitizeUser(user) });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load profile.' });
  }
});

app.post('/api/reports', authMiddleware, async (req, res) => {
  try {
    const { reportedUserId, reason, messageSnippet } = req.body;

    if (!reportedUserId || !reason) {
      return res.status(400).json({ message: 'Reported user and reason are required.' });
    }

    const report = await Report.create({
      reporterId: req.user.id,
      reportedUserId,
      reason,
      messageSnippet: messageSnippet || '',
    });

    adminIo.emit('report:new', {
      report,
      reporterId: req.user.id,
      reportedUserId,
    });

    await broadcastAdminStats();

    res.status(201).json({ message: 'Report submitted successfully.', report });
  } catch (error) {
    console.error('Report error', error);
    res.status(500).json({ message: 'Failed to save report.' });
  }
});

app.post('/api/admin/login', authRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase(), role: 'admin' });
    if (!user) {
      return res.status(401).json({ message: 'Invalid admin credentials.' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid admin credentials.' });
    }

    const token = createToken(user);
    res.json({
      user: sanitizeUser(user),
      token,
    });
  } catch (error) {
    console.error('Admin login error', error);
    res.status(500).json({ message: 'Unable to log in as admin.' });
  }
});

app.get('/api/admin/dashboard', adminAuthMiddleware, async (req, res) => {
  try {
    const payload = await broadcastAdminStats();
    res.json(payload);
  } catch (error) {
    console.error('Dashboard error', error);
    res.status(500).json({ message: 'Unable to load admin dashboard.' });
  }
});

app.get('/api/admin/sessions', adminAuthMiddleware, async (req, res) => {
  try {
    const sessions = Array.from(state.activeSessions.values()).map((session) => ({
      roomId: session.roomId,
      mode: session.mode,
      startedAt: session.startedAt,
      users: session.users,
    }));
    res.json({ sessions });
  } catch (error) {
    console.error('Sessions list error', error);
    res.status(500).json({ message: 'Unable to load sessions.' });
  }
});

app.post('/api/admin/sessions/:roomId/end', adminAuthMiddleware, async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) {
      return res.status(400).json({ message: 'Session roomId is required.' });
    }

    await endSession(roomId, 'admin', 'admin-ended');
    await addAuditLog(req.admin.id, req.admin.email, 'end_session', `Admin ended room ${roomId}.`);
    res.json({ message: 'Session ended successfully.' });
  } catch (error) {
    console.error('End session error', error);
    res.status(500).json({ message: 'Unable to end session.' });
  }
});

app.get('/api/admin/users', adminAuthMiddleware, async (req, res) => {
  try {
    const { search = '' } = req.query;
    const filter = {
      isDeleted: false,
      ...(search
        ? {
            $or: [
              { name: { $regex: search, $options: 'i' } },
              { email: { $regex: search, $options: 'i' } },
            ],
          }
        : {}),
    };

    const users = await User.find(filter).select('-passwordHash').sort({ createdAt: -1 }).lean();
    res.json({ users: users.map((user) => sanitizeUser(user)) });
  } catch (error) {
    console.error('Users list error', error);
    res.status(500).json({ message: 'Unable to load users.' });
  }
});

app.post('/api/admin/users/:id/ban', adminAuthMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    user.isBanned = true;
    await user.save();
    await addAuditLog(req.admin.id, req.admin.email, 'ban_user', `User ${user.email} was banned.`);
    await broadcastAdminStats();
    res.json({ message: 'User banned successfully.' });
  } catch (error) {
    console.error('Ban user error', error);
    res.status(500).json({ message: 'Unable to ban user.' });
  }
});

app.post('/api/admin/users/:id/delete', adminAuthMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    user.isDeleted = true;
    await user.save();
    await addAuditLog(req.admin.id, req.admin.email, 'delete_user', `User ${user.email} was deleted.`);
    await broadcastAdminStats();
    res.json({ message: 'User deleted successfully.' });
  } catch (error) {
    console.error('Delete user error', error);
    res.status(500).json({ message: 'Unable to delete user.' });
  }
});

app.post('/api/admin/users/:id/reset-password', adminAuthMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const temporaryPassword = `Temp${Math.random().toString(36).slice(2, 8)}`;
    user.passwordHash = await bcrypt.hash(temporaryPassword, 10);
    await user.save();
    await addAuditLog(req.admin.id, req.admin.email, 'reset_password', `Password reset for ${user.email}.`);

    res.json({
      message: 'Temporary password generated.',
      temporaryPassword,
    });
  } catch (error) {
    console.error('Reset password error', error);
    res.status(500).json({ message: 'Unable to reset password.' });
  }
});

app.get('/api/admin/reports', adminAuthMiddleware, async (req, res) => {
  try {
    const reports = await Report.find().sort({ createdAt: -1 }).lean();
    res.json({ reports });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load reports.' });
  }
});

app.post('/api/admin/reports/:id/resolve', adminAuthMiddleware, async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ message: 'Report not found.' });

    report.status = 'resolved';
    await report.save();
    await addAuditLog(req.admin.id, req.admin.email, 'resolve_report', `Report ${report._id} was marked resolved.`);
    await broadcastAdminStats();
    res.json({ message: 'Report marked as resolved.' });
  } catch (error) {
    console.error('Resolve report error', error);
    res.status(500).json({ message: 'Unable to resolve report.' });
  }
});

app.use((error, req, res, next) => {
  console.error('Unhandled app error', error);
  res.status(500).json({ message: 'Server error.' });
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    if (!token) return next(new Error('Authentication token missing.'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-passwordHash');

    if (!user || user.isDeleted || user.isBanned) {
      return next(new Error('User account is not active.'));
    }

    socket.userId = user._id.toString();
    socket.user = user;
    next();
  } catch (error) {
    next(new Error('Invalid socket token.'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  state.socketUserMap.set(socket.id, userId);
  state.userSocketMap.set(userId, socket.id);

  socket.emit('connected', {
    userId,
    status: 'connected',
  });

  socket.on('match:request', async ({ preference, mode = 'text' } = {}) => {
    try {
      const user = await User.findById(userId);
      if (!user || user.isDeleted || user.isBanned) {
        return socket.emit('match:error', { message: 'User is not allowed to match.' });
      }

      const request = createMatchRequest(user, socket.id, mode);
      request.preference = preference || user.matchPreference || 'anyone';

      const existingIndex = state.waitingUsers.findIndex((entry) => entry.userId === userId);
      if (existingIndex >= 0) state.waitingUsers.splice(existingIndex, 1);

      state.waitingUsers.push(request);

      const match = findMatch(request);
      if (!match) {
        socket.emit('match:waiting', { message: 'Looking for a match...' });
        return;
      }

      removeWaitingUser(userId);
      removeWaitingUser(match.userId);

      const roomId = `room_${Date.now()}_${userId}_${match.userId}`;
      const currentUserEntry = { userId, name: user.name, socketId: socket.id };
      const matchUserEntry = { userId: match.userId, name: match.name, socketId: match.socketId };

      const session = {
        roomId,
        mode,
        startedAt: Date.now(),
        users: [currentUserEntry, matchUserEntry],
        messages: [],
      };

      state.activeSessions.set(roomId, session);

      socket.join(roomId);
      const peerSocket = io.sockets.sockets.get(match.socketId);
      if (peerSocket) peerSocket.join(roomId);

      io.to(roomId).emit('match:matched', {
        roomId,
        mode,
        peer: {
          userId: userId === match.userId ? match.userId : userId,
          name: userId === match.userId ? match.name : user.name,
        },
      });

      await broadcastAdminStats();
    } catch (error) {
      console.error('Match request error', error);
      socket.emit('match:error', { message: 'Unable to find a match right now.' });
    }
  });

  socket.on('chat:message', ({ roomId, text } = {}) => {
    if (!roomId || !text) return;
    const session = state.activeSessions.get(roomId);
    if (!session) return;

    const message = {
      from: userId,
      text: String(text).slice(0, 500),
      timestamp: Date.now(),
    };

    session.messages.push(message);
    if (session.messages.length > 50) session.messages.shift();

    io.to(roomId).emit('chat:message', message);
  });

  socket.on('webrtc:offer', ({ roomId, offer }) => {
    const session = state.activeSessions.get(roomId);
    if (!session) return;
    const peer = getOtherUser(session, userId);
    if (!peer) return;
    io.to(peer.socketId).emit('webrtc:offer', { offer, from: userId, roomId });
  });

  socket.on('webrtc:answer', ({ roomId, answer }) => {
    const session = state.activeSessions.get(roomId);
    if (!session) return;
    const peer = getOtherUser(session, userId);
    if (!peer) return;
    io.to(peer.socketId).emit('webrtc:answer', { answer, from: userId, roomId });
  });

  socket.on('webrtc:ice-candidate', ({ roomId, candidate }) => {
    const session = state.activeSessions.get(roomId);
    if (!session) return;
    const peer = getOtherUser(session, userId);
    if (!peer) return;
    io.to(peer.socketId).emit('webrtc:ice-candidate', { candidate, from: userId, roomId });
  });

  socket.on('session:next', async ({ roomId } = {}) => {
    if (!roomId) return;
    await endSession(roomId, userId, 'next');
    socket.emit('match:waiting', { message: 'Finding another person...' });
  });

  socket.on('session:end', async ({ roomId } = {}) => {
    if (!roomId) return;
    await endSession(roomId, userId, 'ended');
  });

  socket.on('disconnect', async () => {
    state.socketUserMap.delete(socket.id);
    state.userSocketMap.delete(userId);
    removeWaitingUser(userId);

    for (const [roomId, session] of state.activeSessions.entries()) {
      if (session.users.some((entry) => entry.userId === userId)) {
        await endSession(roomId, userId, 'disconnect');
      }
    }
  });
});

adminIo.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    if (!token) return next(new Error('Admin token missing.'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await User.findById(decoded.id);

    if (!admin || admin.role !== 'admin' || admin.isDeleted || admin.isBanned) {
      return next(new Error('Admin access denied.'));
    }

    socket.adminId = admin._id.toString();
    socket.adminEmail = admin.email;
    next();
  } catch (error) {
    next(new Error('Invalid admin token.'));
  }
});

adminIo.on('connection', async (socket) => {
  const dashboard = await broadcastAdminStats();
  socket.emit('dashboard:update', dashboard);

  socket.on('moderation:join', ({ roomId }) => {
    if (!roomId) return;
    const session = state.activeSessions.get(roomId);
    if (!session) {
      return socket.emit('moderation:session', { roomId, messages: [], users: [] });
    }
    socket.join(roomId);
    socket.emit('moderation:session', {
      roomId,
      messages: session.messages,
      users: session.users,
    });
  });

  socket.on('sessions:request', async () => {
    await broadcastAdminStats();
  });
});

const PORT = Number(process.env.PORT) || 5000;

mongoose
  .connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/randomchat')
  .then(async () => {
    console.log('MongoDB connected');
    await ensureAdminUser();
    server.listen(PORT, () => {
      console.log(`Backend listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('MongoDB connection failed:', error);
    process.exit(1);
  });
