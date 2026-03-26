const MLB_STATS_API_BASE = 'https://statsapi.mlb.com/api/v1';
const MLB_HEADSHOT_BASE = 'https://img.mlbstatic.com/mlb-photos/image/upload/w_213,q_100/v1/people';
const MLB_SPORT_ID = 1;

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[.'-]/g, '')
    .replace(/\s+/g, ' ');
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

function toTeamAliases(team) {
  const aliases = new Set();
  const addAlias = (value) => {
    const normalized = normalizeTeamCode(value);
    if (normalized) aliases.add(normalized);
  };

  addAlias(team.abbreviation);
  addAlias(team.teamCode);
  addAlias(team.fileCode);
  addAlias(team.clubName);
  addAlias(team.teamName);
  addAlias(team.name);
  return aliases;
}

function addCandidate(index, key, candidate) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, []);
  }
  index.get(key).push(candidate);
}

function makePlayerIndex(players) {
  const byNameAndTeam = new Map();
  const byName = new Map();

  for (const player of players) {
    const normalizedName = normalizeName(player.fullName);
    if (!normalizedName) continue;
    addCandidate(byName, normalizedName, player);

    for (const alias of player.teamAliases) {
      addCandidate(byNameAndTeam, `${normalizedName}::${alias}`, player);
    }
  }

  return { byNameAndTeam, byName };
}

function chooseUnique(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return null;
}

function matchCsvPlayer(csvPlayer, index) {
  const normalizedName = normalizeName(csvPlayer.canonicalName || csvPlayer.name);
  const normalizedTeam = normalizeTeamCode(csvPlayer.team);
  if (!normalizedName) return null;

  const teamScoped = chooseUnique(index.byNameAndTeam.get(`${normalizedName}::${normalizedTeam}`));
  if (teamScoped) return teamScoped;

  return chooseUnique(index.byName.get(normalizedName));
}

async function fetchMlbRosterPlayers({ season }) {
  const teams = await fetchMlbTeams({ season });
  const allPlayers = [];

  for (const team of teams) {
    const teamAliases = toTeamAliases(team);
    const teamId = team.id;
    if (!teamId) continue;

    let roster = [];
    try {
      roster = await fetchActiveRosterForTeam({ teamId, season });
    } catch (error) {
      console.warn(`Failed to fetch roster for team ${teamId}: ${error.message}`);
      continue;
    }

    for (const entry of roster) {
      if (!entry || !entry.person || !entry.person.id) continue;

      allPlayers.push({
        playerId: entry.person.id,
        fullName: entry.person.fullName || '',
        teamId,
        teamAliases,
      });
    }
  }

  return allPlayers;
}

async function enrichPlayersWithMlbData(players, { season = new Date().getFullYear() } = {}) {
  const rosterPlayers = await fetchMlbRosterPlayers({ season });
  const index = makePlayerIndex(rosterPlayers);

  let matchedCount = 0;
  const enrichedPlayers = players.map((player) => {
    const match = matchCsvPlayer(player, index);
    if (!match) {
      return {
        ...player,
        dataSources: ['csv'],
      };
    }

    matchedCount += 1;
    return {
      ...player,
      mlbPlayerId: match.playerId,
      mlbTeamId: match.teamId,
      headshotUrl: buildHeadshotUrl(match.playerId),
      dataSources: ['csv', 'mlbStatsApi'],
      lastSyncedAt: new Date(),
    };
  });

  return {
    players: enrichedPlayers,
    season,
    rosterPlayerCount: rosterPlayers.length,
    matchedCount,
  };
}

module.exports = {
  enrichPlayersWithMlbData,
  buildHeadshotUrl,
};
