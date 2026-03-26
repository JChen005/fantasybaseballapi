const mongoose = require('mongoose');

const statSchema = new mongoose.Schema(
  {
    hr: { type: Number, default: 0 },
    rbi: { type: Number, default: 0 },
    sb: { type: Number, default: 0 },
    avg: { type: Number, default: 0 },
    w: { type: Number, default: 0 },
    k: { type: Number, default: 0 },
    era: { type: Number, default: 0 },
    whip: { type: Number, default: 0 },
  },
  { _id: false }
);

const transactionSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    type: { type: String, required: true },
    detail: { type: String, required: true },
  },
  { _id: false }
);

const playerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, index: true },
    canonicalName: { type: String, required: true, index: true },
    sourcePlayerKey: { type: String, required: true },
    mlbPlayerId: { type: Number, index: true },
    mlbTeamId: { type: Number, index: true },
    team: { type: String, required: true, index: true },
    mlbLeague: {
      type: String,
      enum: ['AL', 'NL'],
      required: true,
      index: true,
    },
    positions: { type: [String], required: true },
    eligibility: { type: [String], default: [] },
    injuryStatus: { type: String, default: 'HEALTHY' },
    depthRole: { type: String, default: 'STARTER' },
    statsLastYear: { type: statSchema, required: true },
    stats3Year: { type: statSchema, required: true },
    statsProjection: { type: statSchema, required: true },
    baseValue: { type: Number, required: true },
    isCustom: { type: Boolean, default: false },
    isDrafted: { type: Boolean, default: false },
    headshotUrl: { type: String, default: '' },
    dataSources: { type: [String], default: ['csv'] },
    lastSyncedAt: { type: Date },
    transactions: { type: [transactionSchema], default: [] },
  },
  {
    timestamps: true,
  }
);

playerSchema.index(
  { sourcePlayerKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourcePlayerKey: { $type: 'string' },
    },
  }
);

module.exports = mongoose.model('Player', playerSchema);
