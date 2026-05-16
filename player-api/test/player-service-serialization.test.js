'use strict';

const mockPlayerFind = jest.fn();
const mockPlayerFindOne = jest.fn();

jest.mock('../src/models/Player', () => ({
  find: mockPlayerFind,
  findOne: mockPlayerFindOne,
}));

jest.mock('../src/services/mlbStatsService', () => ({
  getTeamDepthChart: jest.fn(),
  upsertPlayerByMlbId: jest.fn(),
  upsertPlayersByMlbSearch: jest.fn(),
}));

jest.mock('../src/services/catalogCache', () => ({
  invalidateCatalogCache: jest.fn(),
}));

jest.mock('../src/services/valuationService', () => ({
  getValuationSnapshot: jest.fn(),
}));

const {
  getPlayerById,
  listPlayers,
  searchPlayers,
} = require('../src/services/playerService');

function makePlayer(overrides = {}) {
  return {
    _id: '64f000000000000000000001',
    name: 'Test Player',
    mlbPlayerId: 123,
    mlbTeamId: 999,
    team: 'NYY',
    mlbLeague: 'AL',
    positions: ['OF'],
    injuryStatus: 'HEALTHY',
    depthRole: 'OUTFIELDER',
    statsLastYear: { avg: 0.300, hr: 30, rbi: 90, sb: 10, w: 0, k: 0, era: 0, whip: 0 },
    stats3Year: { avg: 0.287, hr: 28, rbi: 85, sb: 9, w: 0, k: 0, era: 0, whip: 0 },
    baseValue: 100,
    isCustom: false,
    isDrafted: false,
    isMlbRelevant: true,
    isActiveRoster: true,
    rosterStatus: 'ACTIVE',
    sourceRosterScope: 'ACTIVE',
    headshotUrl: 'https://example.test/player.png',
    dataSources: ['mlbStatsApi'],
    lastSeenInSyncAt: new Date('2026-01-01T00:00:00.000Z'),
    lastSyncedAt: new Date('2026-01-01T00:00:00.000Z'),
    transactions: [{ date: '2026-01-01', type: 'Roster Sync', detail: 'Synced' }],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function makeFindChain(result) {
  return {
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean() {
      return Promise.resolve(result);
    },
  };
}

afterEach(() => {
  mockPlayerFind.mockReset();
  mockPlayerFindOne.mockReset();
});

test('listPlayers omits internal sync fields from API shape', async () => {
  mockPlayerFind.mockReturnValue(makeFindChain([makePlayer()]));

  const players = await listPlayers({});
  expect(players).toHaveLength(1);
  expect(players[0]).toMatchObject({
    name: 'Test Player',
    mlbPlayerId: 123,
    team: 'NYY',
  });
  expect(players[0].mlbTeamId).toBeUndefined();
  expect(players[0].depthRole).toBeUndefined();
  expect(players[0].rosterStatus).toBeUndefined();
  expect(players[0].sourceRosterScope).toBeUndefined();
  expect(players[0].dataSources).toBeUndefined();
  expect(players[0].lastSeenInSyncAt).toBeUndefined();
});

test('searchPlayers omits internal sync fields from API shape', async () => {
  mockPlayerFind.mockReturnValue(makeFindChain([makePlayer()]));

  const players = await searchPlayers({ escapedQuery: 'Test', includeDrafted: true });
  expect(players).toHaveLength(1);
  expect(players[0].mlbTeamId).toBeUndefined();
  expect(players[0].depthRole).toBeUndefined();
  expect(players[0].rosterStatus).toBeUndefined();
  expect(players[0].sourceRosterScope).toBeUndefined();
  expect(players[0].dataSources).toBeUndefined();
  expect(players[0].lastSeenInSyncAt).toBeUndefined();
});

test('getPlayerById omits internal sync fields from API shape', async () => {
  mockPlayerFindOne.mockReturnValue({
    lean() {
      return Promise.resolve(makePlayer());
    },
  });

  const player = await getPlayerById(123);
  expect(player.mlbTeamId).toBeUndefined();
  expect(player.depthRole).toBeUndefined();
  expect(player.rosterStatus).toBeUndefined();
  expect(player.sourceRosterScope).toBeUndefined();
  expect(player.dataSources).toBeUndefined();
  expect(player.lastSeenInSyncAt).toBeUndefined();
  expect(player.transactions).toEqual([{ date: '2026-01-01', type: 'Roster Sync', detail: 'Synced' }]);
});
