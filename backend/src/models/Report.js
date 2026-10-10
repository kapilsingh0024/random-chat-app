const mongoose = require('mongoose');

// A report stores ONLY: reporter, reported user, time, reason and (optionally, only if the
// reporter ticked the box) the last few text messages. No other chat data is ever saved.
const reportSchema = new mongoose.Schema(
  {
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, maxlength: 500 },
    messageSnippet: { type: String, default: '' }, // old reports
    messages: [{ from: String, text: String, _id: false }],
    createdAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['open', 'reviewed', 'resolved', 'dismissed'], default: 'open' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Report', reportSchema);
