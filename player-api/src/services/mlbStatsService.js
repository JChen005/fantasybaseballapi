const {
  buildHeadshotUrl,
  fetchActiveRosterForTeam,
  fetchDepthChartForTeam,
  fetchMlbTeams,
  fetchPeopleStats,
  normalizeTeamCode,
  normalizeWhitespace,
  toLeague,
} = require('./mlbStatsClient');
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

function emptyStats() {
  return { hr: 0, rbi: 0, sb: 0, avg: 0, w: 0, k: 0, era: 0, whip: 0 };
}

function buildTransaction(player, season) {
  return [{
    date: `${season}-01-01`,
    type: 'Roster Sync',
    detail: `${player.name} synced from MLB Stats API active roster and depth chart data.`,
  }];
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
    stats.w * 7 +
    stats.k * 1.6 -
    stats.era * 30 -
    stats.whip * 45;
  const weightedRawValue = Math.max(1, hitterValue + pitcherValue) * getDepthContextMultiplier({ depthRank, primarySlot, positions });
  const scaledBaseValue = Math.pow(weightedRawValue / 3, 1.7);

  return Number(Math.max(1, scaledBaseValue).toFixed(2));
}

async function fetchTeamRosterSnapshot({ teamId, teamCode, season }) {
  let activeRoster = [];
  let depthEntries = [];

  try {
    activeRoster = await fetchActiveRosterForTeam({ teamId, season });
  } catch (error) {
    console.warn(`Failed to fetch active roster for team ${teamId}: ${error.message}`);
  }

  try {
    depthEntries = await fetchDepthChartForTeam({ teamId });
  } catch (error) {
    console.warn(`Failed to fetch depth chart for team ${teamId}: ${error.message}`);
  }

  return {
    activeRoster,
    activeRosterIds: new Set(activeRoster.map((entry) => entry?.person?.id).filter(Boolean)),
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
    for (const entry of snapshot.activeRoster) {
      if (!entry?.person?.id) continue;
      rosterEntries.push({
        entry,
        teamId,
        teamCode,
        depthInfo: snapshot.depthIndex.get(entry.person.id) || null,
      });
    }
  }

  const peopleById = await fetchPeopleStats(rosterEntries.map(({ entry }) => entry.person.id));

  return rosterEntries.map(({ entry, teamId, teamCode, depthInfo }) => {
    const positionInputs = [
      entry.position?.abbreviation,
      entry.position?.code,
      entry.position?.name,
      entry.position?.type,
      ...(depthInfo?.positions || []),
    ];
    const positions = buildEligibility(positionInputs);
    const person = peopleById.get(entry.person.id);
    const playerStats = buildPlayerStats(person, season);

    return {
      name: normalizeWhitespace(entry.person.fullName),
      canonicalName: normalizeWhitespace(entry.person.fullName),
      mlbPlayerId: entry.person.id,
      mlbTeamId: teamId,
      team: teamCode,
      mlbLeague: toLeague(teamCode),
      positions,
      eligibility: positions,
      injuryStatus: normalizeWhitespace(depthInfo?.status || entry.status?.description || 'HEALTHY') || 'HEALTHY',
      depthRole: depthInfo?.depthRole || buildDepthRoleFromEntry(entry),
      ...playerStats,
      baseValue: computeBaseValue(playerStats.statsLastYear, {
        depthRank: Number.isInteger(depthInfo?.depthRank) ? depthInfo.depthRank : null,
        primarySlot: depthInfo?.primarySlot || null,
        positions,
      }),
      isCustom: false,
      isDrafted: false,
      headshotUrl: buildHeadshotUrl(entry.person.id),
      dataSources: ['mlbStatsApi', 'mlbDepthChart'],
      isActiveRoster: true,
      lastSeenInSyncAt: new Date(),
      lastSyncedAt: new Date(),
    };
  });
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
};
