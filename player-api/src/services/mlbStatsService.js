const MLB_STATS_API_BASE = 'https://statsapi.mlb.com/api/v1';
const MLB_HEADSHOT_BASE = 'https://img.mlbstatic.com/mlb-photos/image/upload/w_213,q_100/v1/people';
const MLB_SPORT_ID = 1;
const PEOPLE_BATCH_SIZE = 25;
const STATS_HYDRATE = 'stats(group=[hitting,pitching],type=[season,yearByYear])';

const AL_TEAMS = new Set([
  'BAL',
  'BOS',
  'NYY',
  'TB',
  'TOR',
  'CHW',
  'CLE',
  'DET',
  'KC',
  'MIN',
  'HOU',
  'LAA',
  'ATH',
  'OAK',
  'SEA',
  'TEX',
]);

const POSITION_MAP = {
  C: 'C',
  '1B': '1B',
  '2B': '2B',
  '3B': '3B',
  SS: 'SS',
  LF: 'OF',
  CF: 'OF',
  RF: 'OF',
  OF: 'OF',
  DH: 'UTIL',
  UT: 'UTIL',
  UTIL: 'UTIL',
  TWP: 'P',
  SP: 'P',
  RP: 'P',
  P: 'P',
};

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTeamCode(value) {
  return normalizeWhitespace(value).toUpperCase();
}

function buildHeadshotUrl(playerId) {
  return `${MLB_HEADSHOT_BASE}/${playerId}/headshot/67/current`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`MLB API request failed (${response.status}): ${url}`);
  }
  return response.json();
}

async function fetchMlbTeams({ season }) {
  const url = `${MLB_STATS_API_BASE}/teams?sportId=${MLB_SPORT_ID}&season=${season}`;
  const payload = await fetchJson(url);
  return Array.isArray(payload.teams) ? payload.teams : [];
}

async function fetchActiveRosterForTeam({ teamId, season }) {
  const url = `${MLB_STATS_API_BASE}/teams/${teamId}/roster?rosterType=active&season=${season}`;
  const payload = await fetchJson(url);
  return Array.isArray(payload.roster) ? payload.roster : [];
}

function normalizePosition(value) {
  const token = normalizeWhitespace(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) return '';
  return POSITION_MAP[token] || token;
}

function toLeague(teamCode) {
  return AL_TEAMS.has(teamCode) ? 'AL' : 'NL';
}

function toNumber(value, digits = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return digits == null ? numeric : Number(numeric.toFixed(digits));
}

function emptyStats() {
  return {
    hr: 0,
    rbi: 0,
    sb: 0,
    avg: 0,
    w: 0,
    k: 0,
    era: 0,
    whip: 0,
  };
}

function buildEligibility(position, positionName) {
  const values = [normalizePosition(position), normalizePosition(positionName)].filter(Boolean);
  const eligibility = Array.from(new Set(values));
  return eligibility.length > 0 ? eligibility : ['UTIL'];
}

function buildDepthRole(positionType) {
  const normalized = normalizeWhitespace(positionType).toLowerCase();
  if (normalized.includes('pitcher')) return 'PITCHER';
  if (normalized.includes('outfield')) return 'OUTFIELDER';
  if (normalized.includes('infield')) return 'INFIELDER';
  return 'STARTER';
}

function buildTransaction(player, season) {
  return [
    {
      date: `${season}-01-01`,
      type: 'Roster Sync',
      detail: `${player.name} synced from MLB Stats API active rosters.`,
    },
  ];
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function statsHydrateParam() {
  return encodeURIComponent(STATS_HYDRATE);
}

async function fetchPeopleStats(personIds) {
  const ids = personIds.filter(Boolean);
  if (ids.length === 0) return new Map();

  const batches = chunk(ids, PEOPLE_BATCH_SIZE);
  const people = [];

  for (const batch of batches) {
    const url = `${MLB_STATS_API_BASE}/people?personIds=${batch.join(',')}&hydrate=${statsHydrateParam()}`;
    const payload = await fetchJson(url);
    if (Array.isArray(payload.people)) {
      people.push(...payload.people);
    }
  }

  return new Map(people.map((person) => [person.id, person]));
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

function mapHittingSplit(split) {
  const stat = split?.stat || {};
  return {
    hr: toNumber(stat.homeRuns),
    rbi: toNumber(stat.rbi),
    sb: toNumber(stat.stolenBases),
    avg: toNumber(stat.avg, 3),
    w: 0,
    k: toNumber(stat.strikeOuts),
    era: 0,
    whip: 0,
  };
}

function mapPitchingSplit(split) {
  const stat = split?.stat || {};
  return {
    hr: 0,
    rbi: 0,
    sb: 0,
    avg: 0,
    w: toNumber(stat.wins),
    k: toNumber(stat.strikeOuts),
    era: toNumber(stat.era, 2),
    whip: toNumber(stat.whip, 2),
  };
}

function mergeStatBlocks(...blocks) {
  return blocks.reduce(
    (accumulator, block) => ({
      hr: accumulator.hr + toNumber(block?.hr),
      rbi: accumulator.rbi + toNumber(block?.rbi),
      sb: accumulator.sb + toNumber(block?.sb),
      avg: Math.max(accumulator.avg, toNumber(block?.avg, 3)),
      w: accumulator.w + toNumber(block?.w),
      k: accumulator.k + toNumber(block?.k),
      era: accumulator.era > 0 ? Math.min(accumulator.era, toNumber(block?.era, 2) || accumulator.era) : toNumber(block?.era, 2),
      whip: accumulator.whip > 0 ? Math.min(accumulator.whip, toNumber(block?.whip, 2) || accumulator.whip) : toNumber(block?.whip, 2),
    }),
    emptyStats()
  );
}

function averageStatBlocks(blocks) {
  if (blocks.length === 0) return emptyStats();

  const total = blocks.reduce(
    (accumulator, block) => ({
      hr: accumulator.hr + block.hr,
      rbi: accumulator.rbi + block.rbi,
      sb: accumulator.sb + block.sb,
      avg: accumulator.avg + block.avg,
      w: accumulator.w + block.w,
      k: accumulator.k + block.k,
      era: accumulator.era + block.era,
      whip: accumulator.whip + block.whip,
    }),
    emptyStats()
  );

  return {
    hr: Number((total.hr / blocks.length).toFixed(2)),
    rbi: Number((total.rbi / blocks.length).toFixed(2)),
    sb: Number((total.sb / blocks.length).toFixed(2)),
    avg: Number((total.avg / blocks.length).toFixed(3)),
    w: Number((total.w / blocks.length).toFixed(2)),
    k: Number((total.k / blocks.length).toFixed(2)),
    era: Number((total.era / blocks.length).toFixed(2)),
    whip: Number((total.whip / blocks.length).toFixed(2)),
  };
}

function sortSplitsBySeasonDesc(splits) {
  return [...splits].sort((left, right) => Number(right.season) - Number(left.season));
}

function getSeasonSplit(splits, season) {
  return splits.find((split) => Number(split?.season) === Number(season)) || null;
}

function getCompletedSeasonSplits(splits, currentSeason) {
  return sortSplitsBySeasonDesc(splits).filter((split) => Number(split?.season) < Number(currentSeason));
}

function buildPlayerStats(person, season) {
  const hittingSeasonSplits = getStatSplits(person, { group: 'hitting', type: 'season' });
  const pitchingSeasonSplits = getStatSplits(person, { group: 'pitching', type: 'season' });
  const hittingYearByYear = getStatSplits(person, { group: 'hitting', type: 'yearbyyear' });
  const pitchingYearByYear = getStatSplits(person, { group: 'pitching', type: 'yearbyyear' });

  const currentHitting = getSeasonSplit(hittingSeasonSplits, season);
  const currentPitching = getSeasonSplit(pitchingSeasonSplits, season);

  const completedHitting = getCompletedSeasonSplits(hittingYearByYear, season);
  const completedPitching = getCompletedSeasonSplits(pitchingYearByYear, season);

  const lastYear = mergeStatBlocks(
    mapHittingSplit(completedHitting[0]),
    mapPitchingSplit(completedPitching[0])
  );

  const threeYear = averageStatBlocks(
    Array.from({ length: Math.max(completedHitting.length, completedPitching.length, 0) })
      .slice(0, 3)
      .map((_, index) =>
        mergeStatBlocks(
          mapHittingSplit(completedHitting[index]),
          mapPitchingSplit(completedPitching[index])
        )
      )
      .filter((block) => Object.values(block).some((value) => value > 0))
  );

  const projection = mergeStatBlocks(
    mapHittingSplit(currentHitting),
    mapPitchingSplit(currentPitching)
  );

  return {
    statsLastYear: Object.values(lastYear).some((value) => value > 0) ? lastYear : projection,
    stats3Year: Object.values(threeYear).some((value) => value > 0) ? threeYear : lastYear,
  };
}

function computeBaseValue(stats) {
  const hitterValue = stats.hr * 4 + stats.rbi + stats.sb * 2 + stats.avg * 100;
  const pitcherValue = stats.w * 6 + stats.k * 0.5 - stats.era * 2 - stats.whip * 3;
  return Number(Math.max(1, hitterValue + pitcherValue).toFixed(2));
}

async function fetchMlbRosterPlayers({ season }) {
  const teams = await fetchMlbTeams({ season });
  const rosterEntries = [];

  for (const team of teams) {
    const teamId = team.id;
    const teamCode = normalizeTeamCode(team.abbreviation || team.teamCode || team.fileCode);
    if (!teamId || !teamCode) continue;

    let roster = [];
    try {
      roster = await fetchActiveRosterForTeam({ teamId, season });
    } catch (error) {
      console.warn(`Failed to fetch roster for team ${teamId}: ${error.message}`);
      continue;
    }

    for (const entry of roster) {
      if (!entry?.person?.id) continue;
      rosterEntries.push({
        entry,
        teamId,
        teamCode,
      });
    }
  }

  const peopleById = await fetchPeopleStats(rosterEntries.map(({ entry }) => entry.person.id));

  return rosterEntries.map(({ entry, teamId, teamCode }) => {
    const positions = buildEligibility(entry.position?.abbreviation || entry.position?.code, entry.position?.name || entry.position?.type);
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
      injuryStatus: 'HEALTHY',
      depthRole: buildDepthRole(entry.position?.type),
      ...playerStats,
      baseValue: computeBaseValue(playerStats.statsLastYear),
      isCustom: false,
      isDrafted: false,
      headshotUrl: buildHeadshotUrl(entry.person.id),
      dataSources: ['mlbStatsApi'],
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
    const key = String(player.mlbPlayerId || "");
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
    throw new Error('No seed players were produced from MLB Stats API active rosters.');
  }

  return {
    players: dedupedPlayers,
    season,
    rosterPlayerCount: dedupedPlayers.length,
  };
}

module.exports = {
  loadMlbSeedPlayers,
  buildHeadshotUrl,
};
