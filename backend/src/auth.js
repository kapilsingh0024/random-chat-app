const jwt = require('jsonwebtoken');
const User = require('../models/User');

// User and admin tokens are signed with DIFFERENT secrets.
// ADMIN_JWT_SECRET is optional: if it is not set, a secret is derived from JWT_SECRET,
// so the existing Render blueprint keeps working without any new env var.
const userSecret = () => process.env.JWT_SECRET;
const adminSecret = () => process.env.ADMIN_JWT_SECRET || `${process.env.JWT_SECRET}:admin-panel`;

const createToken = (user) =>
  jwt.sign({ id: user._id.toString(), role: 'user' }, userSecret(), { expiresIn: '7d' });

const createAdminToken = (user) =>
  jwt.sign({ id: user._id.toString(), role: 'admin' }, adminSecret(), { expiresIn: '8h' });

// Returns a message if the account may not be used, otherwise null.
function accountProblem(user) {
  if (!user || user.isDeleted) return 'Account is unavailable.';
  if (user.isBanned) return 'This account is banned.';
  if (user.suspendedUntil && user.suspendedUntil > new Date()) return 'This account is suspended.';
  return null;
}

async function loadUserFromToken(token) {
  const decoded = jwt.verify(token, userSecret());
  if (decoded.role !== 'user') throw new Error('Wrong token type');
  const user = await User.findById(decoded.id);
  const problem = accountProblem(user);
  if (problem) throw new Error(problem);
  return user;
}

async function loadAdminFromToken(token) {
  const decoded = jwt.verify(token, adminSecret());
  if (decoded.role !== 'admin') throw new Error('Wrong token type');
  const user = await User.findById(decoded.id);
  if (accountProblem(user) || user.role !== 'admin') throw new Error('Admin access denied');
  return user;
}

const bearer = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
};

async function authMiddleware(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ message: 'Authentication required.' });
    const user = await loadUserFromToken(token);
    req.user = { id: user._id.toString(), email: user.email, role: user.role, name: user.name, gender: user.gender };
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

async function adminAuthMiddleware(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ message: 'Admin authentication required.' });
    const user = await loadAdminFromToken(token);
    req.admin = { id: user._id.toString(), email: user.email, role: user.role, name: user.name };
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid admin token.' });
  }
}

module.exports = {
  authMiddleware,
  adminAuthMiddleware,
  createToken,
  createAdminToken,
  accountProblem,
  loadUserFromToken,
  loadAdminFromToken,
};
