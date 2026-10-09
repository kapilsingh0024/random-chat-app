const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    gender: { type: String, enum: ['male', 'female'], required: true },
    ageConfirmed: { type: Boolean, default: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    matchPreference: {
      type: String,
      enum: ['male', 'female', 'anyone'],
      default: 'anyone',
    },
    isBanned: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    lastLogin: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
