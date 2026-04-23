const MLB_STATS_API_BASE = 'https://statsapi.mlb.com/api/v1';
const MLB_HEADSHOT_BASE = 'https://img.mlbstatic.com/mlb-photos/image/upload/w_213,q_100/v1/people';
const MLB_SPORT_ID = 1;
const PEOPLE_BATCH_SIZE = 25;
const STATS_HYDRATE = 'stats(group=[hitting,pitching],type=[season,yearByYear])';
const PEOPLE_DETAILS_HYDRATE = `currentTeam,${STATS_HYDRATE}`;

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
  CP: 'P',
  P: 'P',
};

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTeamCode(value) {
  return normalizeWhitespace(value).toUpperCase();
}

function normalizePosition(value) {
  const token = normalizeWhitespace(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) return '';
  return POSITION_MAP[token] || token;
}

function toLeague(teamCode) {
  return AL_TEAMS.has(teamCode) ? 'AL' : 'NL';
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

async function fetch40ManRosterForTeam({ teamId, season }) {
  const url = `${MLB_STATS_API_BASE}/teams/${teamId}/roster?rosterType=40Man&season=${season}`;
  const payload = await fetchJson(url);
  return Array.isArray(payload.roster) ? payload.roster : [];
}

async function fetchDepthChartForTeam({ teamId }) {
  const url = `${MLB_STATS_API_BASE}/teams/${teamId}/roster/depthChart`;
  const payload = await fetchJson(url);
  return Array.isArray(payload.roster) ? payload.roster : [];
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

function peopleDetailsHydrateParam() {
  return encodeURIComponent(PEOPLE_DETAILS_HYDRATE);
}

async function fetchPeopleStats(personIds) {
  const ids = personIds.filter(Boolean);
  if (ids.length === 0) return new Map();

  const people = [];
  for (const batch of chunk(ids, PEOPLE_BATCH_SIZE)) {
    const url = `${MLB_STATS_API_BASE}/people?personIds=${batch.join(',')}&hydrate=${statsHydrateParam()}`;
    const payload = await fetchJson(url);
    if (Array.isArray(payload.people)) {
      people.push(...payload.people);
    }
  }

  return new Map(people.map((person) => [person.id, person]));
}

async function fetchPeopleDetails(personIds) {
  const ids = personIds.filter(Boolean);
  if (ids.length === 0) return new Map();

  const people = [];
  for (const batch of chunk(ids, PEOPLE_BATCH_SIZE)) {
    const url = `${MLB_STATS_API_BASE}/people?personIds=${batch.join(',')}&hydrate=${peopleDetailsHydrateParam()}`;
    const payload = await fetchJson(url);
    if (Array.isArray(payload.people)) {
      people.push(...payload.people);
    }
  }

  return new Map(people.map((person) => [person.id, person]));
}

async function searchPeopleByName(query) {
  const normalizedQuery = normalizeWhitespace(query);
  if (!normalizedQuery) return [];

  const url = `${MLB_STATS_API_BASE}/people/search?names=${encodeURIComponent(normalizedQuery)}`;
  const payload = await fetchJson(url);
  return Array.isArray(payload.people) ? payload.people : [];
}

module.exports = {
  buildHeadshotUrl,
  fetch40ManRosterForTeam,
  fetchActiveRosterForTeam,
  fetchDepthChartForTeam,
  fetchMlbTeams,
  fetchPeopleDetails,
  searchPeopleByName,
  fetchPeopleStats,
  normalizePosition,
  normalizeTeamCode,
  normalizeWhitespace,
  toLeague,
};
