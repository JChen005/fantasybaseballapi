const mongoose = require("mongoose");
const { AppError } = require("../utils/appError");

function clamp(number, min, max) {
  return Math.min(Math.max(number, min), max);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLimit(rawLimit, fallback = 200) {
  const parsed = Number(rawLimit ?? fallback);
  if (!Number.isFinite(parsed)) {
    throw new AppError("limit must be a number", 400);
  }
  return clamp(Math.floor(parsed), 1, 500);
}

function parseSearchQuery(query = {}) {
  const includeDrafted =
    String(query.includeDrafted ?? "true").toLowerCase() === "true";
  const limit = parseLimit(query.limit, 200);
  const leagueType = parseLeagueType(query.leagueType);

  const raw = String(query.q ?? "").trim();
  const q = raw.length > 80 ? raw.slice(0, 80) : raw;

  return {
    includeDrafted,
    limit,
    leagueType,
    q,
    escapedQuery: q ? escapeRegex(q) : "",
  };
}

function parseLeagueType(rawLeagueType) {
  if (rawLeagueType == null || rawLeagueType === "") return null;
  const normalized = String(rawLeagueType).trim().toUpperCase();
  if (normalized === "MIXED") return null;
  if (normalized !== "AL" && normalized !== "NL") {
    throw new AppError("leagueType must be AL, NL, MIXED, or omitted", 400);
  }
  return normalized;
}

function validatePlayerId(playerId) {
  if (!mongoose.isValidObjectId(playerId)) {
    throw new AppError("Invalid player ID", 400);
  }
  return playerId;
}

module.exports = {
  parseLimit,
  parseSearchQuery,
  parseLeagueType,
  validatePlayerId,
};
