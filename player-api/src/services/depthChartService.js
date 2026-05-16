const {
  buildHeadshotUrl,
  normalizePosition,
  normalizeWhitespace,
} = require('./mlbStatsClient');

function dedupeStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildPositions(values) {
  const positions = dedupeStrings(values.map(normalizePosition));
  return positions.length > 0 ? positions : ['UTIL'];
}

function isStarterPremiumSlot(slot) {
  const normalizedSlot = normalizeWhitespace(slot).toUpperCase();
  return new Set(['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH', 'SP']).has(normalizedSlot);
}

function buildDepthIndex(depthEntries) {
  const byPlayerId = new Map();
  const bySlot = new Map();

  for (const entry of depthEntries) {
    const playerId = entry?.person?.id;
    if (!playerId) continue;

    const slot = normalizeWhitespace(entry?.position?.abbreviation || entry?.position?.name || '');
    if (!slot) continue;

    const slotEntries = bySlot.get(slot) || [];
    slotEntries.push(entry);
    bySlot.set(slot, slotEntries);

    const aggregate = byPlayerId.get(playerId) || {
      playerId,
      positions: [],
      entries: [],
    };
    aggregate.positions.push(slot);
    aggregate.entries.push(entry);
    byPlayerId.set(playerId, aggregate);
  }

  for (const [slot, entries] of bySlot.entries()) {
    entries.forEach((entry, index) => {
      const aggregate = byPlayerId.get(entry.person.id);

      aggregate.depthRank = Math.min(aggregate.depthRank ?? Number.MAX_SAFE_INTEGER, index + 1);
      if (!aggregate.primarySlot || index === 0) {
        aggregate.primarySlot = slot;
      }
      aggregate.status = normalizeWhitespace(entry?.status?.description || aggregate.status || '');
      aggregate.positions = dedupeStrings(aggregate.positions);
    });
  }

  return byPlayerId;
}

function normalizeDepthChart(depthEntries, activeRosterIds) {
  const slots = new Map();

  for (const entry of depthEntries) {
    const playerId = entry?.person?.id;
    if (!playerId) continue;

    const slotKey = normalizeWhitespace(entry?.position?.abbreviation || entry?.position?.name || '');
    if (!slotKey) continue;

    const normalizedSlot = normalizePosition(slotKey) || slotKey;
    const slot = slots.get(slotKey) || {
      slot: slotKey,
      normalizedSlot,
      label: normalizeWhitespace(entry?.position?.name || slotKey),
      players: [],
    };

    slot.players.push({
      mlbPlayerId: playerId,
      name: normalizeWhitespace(entry?.person?.fullName),
      status: normalizeWhitespace(entry?.status?.description || ''),
      isActiveRoster: activeRosterIds.has(playerId),
      depthRank: slot.players.length + 1,
      teamPosition: normalizeWhitespace(entry?.position?.abbreviation || ''),
      headshotUrl: buildHeadshotUrl(playerId),
    });

    slots.set(slotKey, slot);
  }

  return Array.from(slots.values());
}

module.exports = {
  buildDepthIndex,
  buildPositions,
  isStarterPremiumSlot,
  normalizeDepthChart,
};
