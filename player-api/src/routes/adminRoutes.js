const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');

const Player = require('../models/Player');
const { ensureSeedData } = require('../services/seedService');
const { createLicense } = require('../services/licenseService');
const { invalidateCatalogCache } = require('../services/catalogCache');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/appError');

const router = express.Router();

function buildTransactionResponse({ playerId, playerName, type, detail }) {
  return {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    playerId: String(playerId),
    playerName: String(playerName),
    type: String(type),
    detail: String(detail),
  };
}

function requireAdminSecret(req, res, next) {
  const expected = process.env.ADMIN_SECRET;
  const provided = req.headers['x-admin-secret'];

  if (!expected) {
    return next(new AppError('ADMIN_SECRET is not configured', 500));
  }

  if (!provided || typeof provided !== 'string') {
    return next(new AppError('Invalid admin secret', 401));
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return next(new AppError('Invalid admin secret', 401));
  }

  return next();
}

router.post(
  '/admin/licenses',
  requireAdminSecret,
  asyncHandler(async (req, res) => {
    const consumerName = String(req.body?.consumerName || '').trim();
    if (!consumerName) {
      throw new AppError('consumerName is required', 400);
    }

    const result = await createLicense({
      consumerName,
      metadata: {
        createdBy: 'admin-route',
      },
    });

    res.status(201).json({
      success: true,
      apiKey: result.apiKey,
      license: result.license,
    });
  })
);

router.post(
  '/admin/data-refresh',
  requireAdminSecret,
  asyncHandler(async (req, res) => {
    const result = await ensureSeedData({ force: true });
    invalidateCatalogCache();
    res.json({
      success: true,
      inserted: result.inserted,
      timestamp: new Date().toISOString(),
    });
  })
);

router.post(
  '/admin/mock-transaction',
  requireAdminSecret,
  asyncHandler(async (req, res) => {
    const requestedPlayerId = String(req.body?.playerId || '').trim();

    let player = null;
    if (requestedPlayerId) {
      if (!mongoose.isValidObjectId(requestedPlayerId)) {
        throw new AppError('Invalid player ID for mock transaction', 400);
      }
      player = await Player.findById(requestedPlayerId);
    } else {
      player = await Player.findOne().sort({ updatedAt: -1, baseValue: -1 });
    }

    if (!player) {
      throw new AppError('No player found to publish transaction', 404);
    }

    const fallbackTypes = ['INJURY_UPDATE', 'ROLE_CHANGE', 'LINEUP_MOVE', 'NEWS_ALERT'];
    const type = String(req.body?.type || fallbackTypes[Math.floor(Math.random() * fallbackTypes.length)])
      .trim()
      .toUpperCase()
      .slice(0, 40);
    const detail = String(
      req.body?.detail || 'Mock player transaction created for demo refresh testing.'
    )
      .trim()
      .slice(0, 280);

    const transactionEntry = {
      date: new Date().toISOString().slice(0, 10),
      type,
      detail,
    };

    player.transactions = Array.isArray(player.transactions)
      ? [...player.transactions, transactionEntry].slice(-30)
      : [transactionEntry];
    await player.save();
    invalidateCatalogCache(`player:${player._id}`);
    invalidateCatalogCache(`transactions:${player._id}`);
    invalidateCatalogCache('players:');
    invalidateCatalogCache('search:');
    invalidateCatalogCache('league-averages');

    const eventPayload = buildTransactionResponse({
      playerId: player._id,
      playerName: player.name,
      type,
      detail,
    });
    res.status(201).json({
      success: true,
      playerId: player._id,
      event: eventPayload,
    });
  })
);

module.exports = router;
