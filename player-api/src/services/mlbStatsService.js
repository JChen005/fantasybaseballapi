const {
  buildHeadshotUrl,
  fetch40ManRosterForTeam,
  fetchActiveRosterForTeam,
  fetchDepthChartForTeam,
  fetchMlbTeams,
  fetchPeopleDetails,
  fetchPeopleStats,
  normalizeTeamCode,
  normalizeWhitespace,
  searchPeopleByName,
  toLeague,
} = require('./mlbStatsClient');
const Player = require('../models/Player');
const {
  buildDepthIndex,
  buildDepthRoleFromEntry,
  buildEligibility,
  isStarterPremiumSlot,
  normalizeDepthChart,
} = require('./depthChartService');

function toNumber(value, digits = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return digits == null ? numeric : Number(numeric.toFixed(digits));
}

function buildTransaction(player, season) {
  return [{
    date: `${season}-01-01`,
    type: 'Roster Sync',
    detail: `${player.name} synced from MLB Stats API active roster, 40-man roster, and depth chart data.`,
  }];
}

function normalizeRosterStatus(value, isActiveRoster) {
  const normalized = normalizeWhitespace(value).toUpperCase();

  if (isActiveRoster) return 'ACTIVE';
  if (!normalized) return 'UNKNOWN';
  if (normalized.includes('INJURED') || normalized.includes('IL')) return 'IL';
  if (normalized.includes('REHAB')) return 'REHAB';
  if (normalized.includes('OPTION')) return 'OPTIONED';
  if (normalized.includes('MINOR')) return 'MINORS';
  return normalized.replace(/\s+/g, '_');
}

function getStatSplits(person, { group, type }) {
  const groups = Array.isArray(person?.stats) ? person.stats : [];
  const statGroup = groups.find(
    (entry) =>
      normalizeWhitespace(entry?.group?.displayName).toLowerCase() === group &&
      normalizeWhitespace(entry?.type?.displayName).toLowerCase() === type
  );
  return Array.isArray(statGroup?.splits)
    ? statGroup.splits.filter((split) => split?.gameType === 'R')
    : [];
}

function parseInningsPitchedToOuts(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return 0;

  const [whole = '0', partial = '0'] = normalized.split('.');
  const outsFromWhole = Number(whole) * 3;
  const outsFromPartial = Number(partial);
  if (!Number.isFinite(outsFromWhole) || !Number.isFinite(outsFromPartial)) return 0;
  return outsFromWhole + outsFromPartial;
}

function emptySeasonAggregate() {
  return {
    hr: 0,
    rbi: 0,
    sb: 0,
    w: 0,
    k: 0,
    battingHits: 0,
    battingAtBats: 0,
    pitchingEarnedRuns: 0,
    pitchingOuts: 0,
    pitchingWhipBaserunners: 0,
  };
}

function mapHittingSplit(split) {
  const stat = split?.stat || {};
  return {
    hr: toNumber(stat.homeRuns),
    rbi: toNumber(stat.rbi),
    sb: toNumber(stat.stolenBases),
    w: 0,
    k: toNumber(stat.strikeOuts),
    battingHits: toNumber(stat.hits),
    battingAtBats: toNumber(stat.atBats),
    pitchingEarnedRuns: 0,
    pitchingOuts: 0,
    pitchingWhipBaserunners: 0,
  };
}

function mapPitchingSplit(split) {
  const stat = split?.stat || {};
  return {
    hr: 0,
    rbi: 0,
    sb: 0,
    w: toNumber(stat.wins),
    k: toNumber(stat.strikeOuts),
    battingHits: 0,
    battingAtBats: 0,
    pitchingEarnedRuns: toNumber(stat.earnedRuns),
    pitchingOuts: parseInningsPitchedToOuts(stat.inningsPitched),
    pitchingWhipBaserunners: toNumber(stat.baseOnBalls) + toNumber(stat.hits),
  };
}

function mergeSeasonAggregates(...aggregates) {
  return aggregates.reduce(
    (accumulator, aggregate) => ({
      hr: accumulator.hr + toNumber(aggregate?.hr),
      rbi: accumulator.rbi + toNumber(aggregate?.rbi),
      sb: accumulator.sb + toNumber(aggregate?.sb),
      w: accumulator.w + toNumber(aggregate?.w),
      k: accumulator.k + toNumber(aggregate?.k),
      battingHits: accumulator.battingHits + toNumber(aggregate?.battingHits),
      battingAtBats: accumulator.battingAtBats + toNumber(aggregate?.battingAtBats),
      pitchingEarnedRuns: accumulator.pitchingEarnedRuns + toNumber(aggregate?.pitchingEarnedRuns),
      pitchingOuts: accumulator.pitchingOuts + toNumber(aggregate?.pitchingOuts),
      pitchingWhipBaserunners: accumulator.pitchingWhipBaserunners + toNumber(aggregate?.pitchingWhipBaserunners),
    }),
    emptySeasonAggregate()
  );
}

function getSeasonSplit(splits, season) {
  const normalizedSeason = String(season);
  return splits.find((split) => String(split?.season || '') === normalizedSeason) || null;
}

function getCompletedSeasonSplits(splits, currentSeason) {
  return splits
    .filter((split) => {
      const season = Number(split?.season);
      return Number.isInteger(season) && season < currentSeason;
    })
    .sort((left, right) => Number(right?.season || 0) - Number(left?.season || 0));
}

function aggregateToDisplayStats(aggregate, seasonsCount = 1) {
  const divisor = Math.max(1, seasonsCount);
  const avg = aggregate.battingAtBats > 0 ? aggregate.battingHits / aggregate.battingAtBats : 0;
  const era = aggregate.pitchingOuts > 0 ? (aggregate.pitchingEarnedRuns * 27) / aggregate.pitchingOuts : 0;
  const whip = aggregate.pitchingOuts > 0 ? (aggregate.pitchingWhipBaserunners * 3) / aggregate.pitchingOuts : 0;

  return {
    hr: Number((aggregate.hr / divisor).toFixed(2)),
    rbi: Number((aggregate.rbi / divisor).toFixed(2)),
    sb: Number((aggregate.sb / divisor).toFixed(2)),
    avg: Number(avg.toFixed(3)),
    w: Number((aggregate.w / divisor).toFixed(2)),
    k: Number((aggregate.k / divisor).toFixed(2)),
    era: Number(era.toFixed(2)),
    whip: Number(whip.toFixed(2)),
  };
}

function hasAnyStats(aggregate) {
  return Object.values(aggregate).some((value) => value > 0);
}

function buildSeasonAggregate(hittingSplit, pitchingSplit) {
  return mergeSeasonAggregates(mapHittingSplit(hittingSplit), mapPitchingSplit(pitchingSplit));
}

function buildAverageAggregate(hittingSplits, pitchingSplits, maxSeasons) {
  const seasons = Array.from({ length: Math.max(hittingSplits.length, pitchingSplits.length, 0) })
    .slice(0, maxSeasons)
    .map((_, index) => buildSeasonAggregate(hittingSplits[index], pitchingSplits[index]))
    .filter(hasAnyStats);

  return {
    aggregate: seasons.reduce((accumulator, seasonAggregate) => mergeSeasonAggregates(accumulator, seasonAggregate), emptySeasonAggregate()),
    seasonsCount: seasons.length,
  };
}

function buildPlayerStats(person, season) {
  const hittingSeasonSplits = getStatSplits(person, { group: 'hitting', type: 'season' });
  const pitchingSeasonSplits = getStatSplits(person, { group: 'pitching', type: 'season' });
  const hittingYearByYear = getStatSplits(person, { group: 'hitting', type: 'yearbyyear' });
  const pitchingYearByYear = getStatSplits(person, { group: 'pitching', type: 'yearbyyear' });

  const currentAggregate = buildSeasonAggregate(
    getSeasonSplit(hittingSeasonSplits, season),
    getSeasonSplit(pitchingSeasonSplits, season)
  );
  const completedHitting = getCompletedSeasonSplits(hittingYearByYear, season);
  const completedPitching = getCompletedSeasonSplits(pitchingYearByYear, season);
  const lastYearAggregate = buildSeasonAggregate(completedHitting[0], completedPitching[0]);
  const threeYearAggregate = buildAverageAggregate(completedHitting, completedPitching, 3);

  const statsLastYear = hasAnyStats(lastYearAggregate)
    ? aggregateToDisplayStats(lastYearAggregate)
    : aggregateToDisplayStats(currentAggregate);
  const stats3Year = threeYearAggregate.seasonsCount > 0
    ? aggregateToDisplayStats(threeYearAggregate.aggregate, threeYearAggregate.seasonsCount)
    : statsLastYear;

  return {
    statsLastYear,
    stats3Year,
  };
}

function getDepthContextMultiplier({ depthRank, primarySlot, positions = [] } = {}) {
  const normalizedPositions = positions.map((position) => String(position).toUpperCase());

  let multiplier = 1;
  if (depthRank === 1 && isStarterPremiumSlot(primarySlot)) multiplier *= 1.75;
  else if (depthRank === 2) multiplier *= 1.25;
  else if (depthRank === 3) multiplier *= 0.75;
  else if (Number.isInteger(depthRank) && depthRank >= 4) multiplier *= 0.45;
  if (normalizedPositions.includes('TWOWAYPLAYER')) multiplier *= 1.35;

  return multiplier;
}

function computeBaseValue(stats, { depthRank, primarySlot, positions = [] } = {}) {
  const hitterValue =
    stats.hr * 8 +
    stats.rbi * 1.8 +
    stats.sb * 4 +
    stats.avg * 420;
  const pitcherValue =
    stats.w * 14 +
    stats.k * 3.1 -
    stats.era * 24 -
    stats.whip * 36;
  const weightedRawValue = Math.max(1, hitterValue + pitcherValue) * getDepthContextMultiplier({ depthRank, primarySlot, positions });
  const scaledBaseValue = Math.pow(weightedRawValue / 3, 1.7);

  return Number(Math.max(1, scaledBaseValue).toFixed(2));
}

async function fetchTeamRosterSnapshot({ teamId, teamCode, season }) {
  let activeRoster = [];
  let fortyManRoster = [];
  let depthEntries = [];

  try {
    activeRoster = await fetchActiveRosterForTeam({ teamId, season });
  } catch (error) {
    console.warn(`Failed to fetch active roster for team ${teamId}: ${error.message}`);
  }

  try {
    fortyManRoster = await fetch40ManRosterForTeam({ teamId, season });
  } catch (error) {
    console.warn(`Failed to fetch 40-man roster for team ${teamId}: ${error.message}`);
  }

  try {
    depthEntries = await fetchDepthChartForTeam({ teamId });
  } catch (error) {
    console.warn(`Failed to fetch depth chart for team ${teamId}: ${error.message}`);
  }

  return {
    activeRoster,
    activeRosterIds: new Set(activeRoster.map((entry) => entry?.person?.id).filter(Boolean)),
    fortyManRoster,
    fortyManRosterIds: new Set(fortyManRoster.map((entry) => entry?.person?.id).filter(Boolean)),
    depthEntries,
    depthIndex: buildDepthIndex(depthEntries),
    teamCode,
    teamId,
  };
}

async function fetchMlbRosterPlayers({ season }) {
  const teams = await fetchMlbTeams({ season });
  const rosterEntries = [];

  for (const team of teams) {
    const teamId = team.id;
    const teamCode = normalizeTeamCode(team.abbreviation || team.teamCode || team.fileCode);
    if (!teamId || !teamCode) continue;

    const snapshot = await fetchTeamRosterSnapshot({ teamId, teamCode, season });
    const rosterEntriesByPlayerId = new Map();

    for (const entry of snapshot.fortyManRoster) {
      if (!entry?.person?.id) continue;
      rosterEntriesByPlayerId.set(entry.person.id, {
        entry,
        sourceRosterScope: 'FORTY_MAN',
      });
    }

    for (const entry of snapshot.activeRoster) {
      if (!entry?.person?.id) continue;
      rosterEntriesByPlayerId.set(entry.person.id, {
        entry,
        sourceRosterScope: 'ACTIVE',
      });
    }

    for (const { entry, sourceRosterScope } of rosterEntriesByPlayerId.values()) {
      rosterEntries.push({
        entry,
        teamId,
        teamCode,
        depthInfo: snapshot.depthIndex.get(entry.person.id) || null,
        isActiveRoster: snapshot.activeRosterIds.has(entry.person.id),
        sourceRosterScope,
      });
    }
  }

  const peopleById = await fetchPeopleStats(rosterEntries.map(({ entry }) => entry.person.id));

  return rosterEntries.map(({ entry, teamId, teamCode, depthInfo, isActiveRoster, sourceRosterScope }) =>
    buildPlayerDocumentFromPerson({
      person: peopleById.get(entry.person.id) || entry.person,
      teamCode,
      teamId,
      depthInfo,
      rosterEntry: entry,
      season,
      isActiveRoster,
      sourceRosterScope,
      dataSources: ['mlbStatsApi', 'mlbDepthChart'],
    })
  );
}

function buildPlayerDocumentFromPerson({
  person,
  teamCode,
  teamId,
  depthInfo,
  rosterEntry,
  season,
  isActiveRoster,
  sourceRosterScope,
  dataSources,
}) {
  const positionInputs = [
    person?.primaryPosition?.abbreviation,
    person?.primaryPosition?.code,
    person?.primaryPosition?.name,
    person?.primaryPosition?.type,
    rosterEntry?.position?.abbreviation,
    rosterEntry?.position?.code,
    rosterEntry?.position?.name,
    rosterEntry?.position?.type,
    ...(depthInfo?.positions || []),
  ];
  const positions = buildEligibility(positionInputs);
  const playerStats = buildPlayerStats(person, season);
  const injuryStatus = normalizeWhitespace(depthInfo?.status || rosterEntry?.status?.description || 'HEALTHY') || 'HEALTHY';
  const rosterStatus = normalizeRosterStatus(rosterEntry?.status?.description || depthInfo?.status, isActiveRoster);
  const playerName = normalizeWhitespace(person.fullName);

  return {
    name: playerName,
    canonicalName: playerName,
    mlbPlayerId: person.id,
    mlbTeamId: teamId,
    team: teamCode,
    mlbLeague: toLeague(teamCode),
    positions,
    eligibility: positions,
    injuryStatus,
    depthRole: depthInfo?.depthRole || buildDepthRoleFromEntry(rosterEntry || { position: person.primaryPosition || {} }),
    ...playerStats,
    baseValue: computeBaseValue(playerStats.statsLastYear, {
      depthRank: Number.isInteger(depthInfo?.depthRank) ? depthInfo.depthRank : null,
      primarySlot: depthInfo?.primarySlot || null,
      positions,
    }),
    isCustom: false,
    isDrafted: false,
    isMlbRelevant: true,
    rosterStatus,
    sourceRosterScope,
    headshotUrl: buildHeadshotUrl(person.id),
    dataSources,
    isActiveRoster,
    lastSeenInSyncAt: new Date(),
    lastSyncedAt: new Date(),
  };
}

function buildTeamLookup(teams) {
  return new Map(
    teams
      .filter((team) => team?.id)
      .map((team) => [team.id, { teamId: team.id, teamCode: normalizeTeamCode(team.abbreviation || team.teamCode || team.fileCode) }])
  );
}

function findMlbTeamInfoForPerson(person, teamById) {
  return teamById.get(person?.currentTeam?.id) || teamById.get(person?.currentTeam?.parentOrgId) || null;
}

async function buildSearchPlayerDocument({ person, teamInfo, snapshotsByTeamId, season }) {
  if (!snapshotsByTeamId.has(teamInfo.teamId)) {
    snapshotsByTeamId.set(
      teamInfo.teamId,
      await fetchTeamRosterSnapshot({ teamId: teamInfo.teamId, teamCode: teamInfo.teamCode, season })
    );
  }

  const snapshot = snapshotsByTeamId.get(teamInfo.teamId);
  const activeEntry = snapshot.activeRoster.find((entry) => entry?.person?.id === person.id) || null;
  const fortyManEntry = snapshot.fortyManRoster.find((entry) => entry?.person?.id === person.id) || null;
  const rosterEntry = activeEntry || fortyManEntry || null;
  const isActiveRoster = snapshot.activeRosterIds.has(person.id);
  const sourceRosterScope = isActiveRoster
    ? 'ACTIVE'
    : snapshot.fortyManRosterIds.has(person.id)
      ? 'FORTY_MAN'
      : 'SEARCH';

  return buildPlayerDocumentFromPerson({
    person,
    teamCode: teamInfo.teamCode,
    teamId: teamInfo.teamId,
    depthInfo: snapshot.depthIndex.get(person.id) || null,
    rosterEntry,
    season,
    isActiveRoster,
    sourceRosterScope,
    dataSources: ['mlbStatsApi', 'mlbDepthChart', 'mlbSearch'],
  });
}

async function upsertPlayersByMlbSearch({ query, season = new Date().getFullYear() } = {}) {
  const searchResults = await searchPeopleByName(query);
  const peopleIds = searchResults.map((person) => person?.id).filter(Boolean);
  if (!peopleIds.length) {
    return [];
  }

  const teams = await fetchMlbTeams({ season });
  const teamById = buildTeamLookup(teams);
  const peopleById = await fetchPeopleDetails(peopleIds);
  const snapshotsByTeamId = new Map();
  const upsertedPlayers = [];

  for (const personId of peopleIds) {
    const person = peopleById.get(personId);
    const teamInfo = findMlbTeamInfoForPerson(person, teamById);
    if (!person || !teamInfo?.teamCode) {
      continue;
    }

    const player = await buildSearchPlayerDocument({
      person,
      teamInfo,
      snapshotsByTeamId,
      season,
    });

    await Player.updateOne(
      { mlbPlayerId: player.mlbPlayerId },
      { $set: player },
      { upsert: true }
    );
    upsertedPlayers.push(player);
  }

  return upsertedPlayers;
}

async function upsertPlayerByMlbId(mlbPlayerId, { season = new Date().getFullYear() } = {}) {
  const peopleById = await fetchPeopleDetails([mlbPlayerId]);
  const person = peopleById.get(mlbPlayerId);
  if (!person?.currentTeam?.id) {
    return null;
  }

  const teams = await fetchMlbTeams({ season });
  const teamById = buildTeamLookup(teams);
  const teamInfo = findMlbTeamInfoForPerson(person, teamById);
  if (!teamInfo?.teamCode) {
    return null;
  }

  const player = await buildSearchPlayerDocument({
    person,
    teamInfo,
    snapshotsByTeamId: new Map(),
    season,
  });

  await Player.updateOne(
    { mlbPlayerId: player.mlbPlayerId },
    { $set: player },
    { upsert: true }
  );

  return player;
}

function dedupePlayers(players, season) {
  const seen = new Set();
  const uniquePlayers = [];

  for (const player of players) {
    const key = String(player.mlbPlayerId || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniquePlayers.push({
      ...player,
      transactions: buildTransaction(player, season),
    });
  }

  return uniquePlayers.sort(
    (a, b) => b.baseValue - a.baseValue || a.canonicalName.localeCompare(b.canonicalName) || a.name.localeCompare(b.name)
  );
}

async function loadMlbSeedPlayers({ season = new Date().getFullYear() } = {}) {
  const players = await fetchMlbRosterPlayers({ season });
  const dedupedPlayers = dedupePlayers(players, season);
  if (dedupedPlayers.length === 0) {
    throw new Error('No seed players were produced from MLB Stats API roster and depth chart data.');
  }

  return {
    players: dedupedPlayers,
    season,
    rosterPlayerCount: dedupedPlayers.length,
  };
}

async function getTeamDepthChart({ teamId, season = new Date().getFullYear() } = {}) {
  const teams = await fetchMlbTeams({ season });
  const team = teams.find((candidate) => candidate.id === teamId);
  if (!team) {
    throw new Error(`MLB team not found for teamId=${teamId}`);
  }

  const teamCode = normalizeTeamCode(team.abbreviation || team.teamCode || team.fileCode);
  const snapshot = await fetchTeamRosterSnapshot({ teamId, teamCode, season });

  return {
    team: {
      id: teamId,
      code: teamCode,
      name: normalizeWhitespace(team.name || team.teamName || ''),
      league: toLeague(teamCode),
    },
    season,
    slots: normalizeDepthChart(snapshot.depthEntries, snapshot.activeRosterIds),
  };
}

module.exports = {
  buildHeadshotUrl,
  getTeamDepthChart,
  loadMlbSeedPlayers,
  upsertPlayerByMlbId,
  upsertPlayersByMlbSearch,
};
