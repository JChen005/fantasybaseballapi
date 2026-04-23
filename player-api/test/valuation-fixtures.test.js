'use strict';

const fs = require('fs');
const path = require('path');

const mockPlayerFind = jest.fn();

jest.mock('../src/models/Player', () => ({
  find: mockPlayerFind,
}));

const { parseValuationRequest } = require('../src/validators/requestValidators');
const { getValuationSnapshot } = require('../src/services/playerService');

const fixtureDir = path.join(__dirname, 'fixtures/valuation/team-a');
const preDraftFixture = require('./fixtures/valuation/pre-draft-league.json');
const draftPicks = require('./fixtures/valuation/draft-picks.json');

const stageIds = ['before-draft', 'after-10', 'after-50', 'after-100', 'after-130'];
const expectedFixtureFiles = stageIds.map((stageId) => `${stageId}.request.json`).sort();
const trackedPlayers = [
  { id: 592450, name: 'Aaron Judge', baseValue: 120, positions: ['OF', 'UTIL'] },
  { id: 677951, name: 'Bobby Witt Jr.', baseValue: 105, positions: ['SS', 'UTIL'] },
];

function readRequestFixture(stageId) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, `${stageId}.request.json`), 'utf8'));
}

function getExcludedPlayerIds(query) {
  const excludedIds = new Set();
  const stack = [query];

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;

    if (Array.isArray(node.mlbPlayerId?.$nin)) {
      for (const id of node.mlbPlayerId.$nin) excludedIds.add(id);
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return excludedIds;
}

function makeMockCatalog() {
  const stars = trackedPlayers.map((player, index) => ({
    _id: `64f00000000000000000000${index + 1}`,
    mlbPlayerId: player.id,
    name: player.name,
    canonicalName: player.name,
    baseValue: player.baseValue,
    positions: player.positions,
    eligibility: player.positions,
    mlbLeague: 'MIXED',
    isDrafted: false,
    isMlbRelevant: true,
  }));

  const filler = Array.from({ length: 240 }, (_, index) => ({
    _id: `64f0000000000000000${String(index + 1 + stars.length).padStart(5, '0')}`,
    mlbPlayerId: 910000 + index,
    name: `Fixture Player ${String(index + 1).padStart(3, '0')}`,
    canonicalName: `Fixture Player ${String(index + 1).padStart(3, '0')}`,
    baseValue: Math.max(1, 110 - index * 0.35),
    positions: index % 4 === 0 ? ['P'] : ['OF', 'UTIL'],
    eligibility: index % 4 === 0 ? ['P'] : ['OF', 'UTIL'],
    mlbLeague: 'MIXED',
    isDrafted: false,
    isMlbRelevant: true,
  }));

  return [...stars, ...filler];
}

function mockCatalog(catalog) {
  mockPlayerFind.mockImplementation((query = {}) => {
    let selectingPoolFields = false;

    const chain = {
      sort() {
        return chain;
      },
      limit() {
        return chain;
      },
      select() {
        selectingPoolFields = true;
        return chain;
      },
      lean() {
        const excludedIds = getExcludedPlayerIds(query);
        const players = catalog
          .filter((player) => !excludedIds.has(player.mlbPlayerId))
          .sort((left, right) => right.baseValue - left.baseValue || left.name.localeCompare(right.name));

        if (!selectingPoolFields) {
          return Promise.resolve(players);
        }

        return Promise.resolve(players.map((player) => ({
          _id: player._id,
          name: player.name,
          baseValue: player.baseValue,
          positions: player.positions,
          eligibility: player.eligibility,
        })));
      },
    };

    return chain;
  });
}

afterEach(() => {
  mockPlayerFind.mockReset();
});

test('Team A stage fixture files exist', () => {
  expect(fs.readdirSync(fixtureDir).sort()).toEqual(expectedFixtureFiles);
});

test('reference fixture data uses real payload-style player ids', () => {
  const preDraftPlayers = preDraftFixture.teams.flatMap((team) => [
    ...(team.keepers || []),
    ...(team.minors || []),
  ]);

  expect(preDraftPlayers.length).toBeGreaterThan(0);
  expect(preDraftPlayers.every((player) => Number.isInteger(player.playerId))).toBe(true);
  expect(draftPicks.every((pick) => Number.isInteger(pick.playerId))).toBe(true);
});

test('draft pick reference rows only keep fields the payload actually cares about', () => {
  expect(draftPicks[0]).toEqual(
    expect.objectContaining({
      pickNumber: expect.any(Number),
      round: expect.any(Number),
      teamKey: expect.any(String),
      playerId: expect.any(Number),
      playerName: expect.any(String),
      cost: expect.any(Number),
      status: 'DRAFTED',
      positions: expect.any(Array),
    })
  );

  expect(draftPicks[0].broughtUpBy).toBeUndefined();
  expect(draftPicks[0].wonBy).toBeUndefined();
  expect(draftPicks[0].salary).toBeUndefined();
  expect(draftPicks[0].mlbPlayerId).toBeUndefined();
});

test('before-draft fixture is a valid Team A valuation request', () => {
  const request = readRequestFixture('before-draft');
  const parsed = parseValuationRequest(request);

  expect(parsed.league.budget).toBe(260);
  expect(parsed.league.teamCount).toBe(9);
  expect(request.league.leagueType).toBe('MIXED');
  expect(request.draftState.userTeamKey).toBe('team-a');
  expect(parsed.draftState.filledSlots).toEqual({
    C: 1,
    '2B': 1,
    OF: 1,
    P: 4,
  });
  expect(request.draftState.excludedPlayers.some((player) => player.countsAgainstBudget && player.teamKey === 'team-a')).toBe(true);
  expect(request.draftState.excludedPlayers.some((player) => !player.countsAgainstBudget && player.teamKey !== 'team-a')).toBe(true);
});

test('every stage fixture still parses as a valid valuation request', () => {
  for (const stageId of stageIds) {
    const request = readRequestFixture(stageId);
    const parsed = parseValuationRequest(request);

    expect(request.draftState.userTeamKey).toBe('team-a');
    expect(parsed.filters.limit).toBe(500);
    expect(parsed.filters.includeInactive).toBe(false);
    expect(parsed.draftState.excludedPlayers.length).toBeGreaterThan(0);
  }
});

test('only Team A exclusions count against Team A budget', () => {
  const request = readRequestFixture('after-50');
  const budgetPlayers = request.draftState.excludedPlayers.filter((player) => player.countsAgainstBudget);

  expect(budgetPlayers.length).toBeGreaterThan(0);
  expect(budgetPlayers.every((player) => player.teamKey === 'team-a')).toBe(true);
});

test('later stage fixtures show more roster progress for Team A', () => {
  const beforeDraft = readRequestFixture('before-draft');
  const afterTen = readRequestFixture('after-10');
  const afterFifty = readRequestFixture('after-50');

  const beforeCount = Object.values(beforeDraft.draftState.filledSlots).reduce((sum, count) => sum + count, 0);
  const afterFiftyCount = Object.values(afterFifty.draftState.filledSlots).reduce((sum, count) => sum + count, 0);

  expect(afterTen.draftState.filledSlots.P).toBeGreaterThanOrEqual(beforeDraft.draftState.filledSlots.P);
  expect(afterFiftyCount).toBeGreaterThan(beforeCount);
});

test('tracked available players change value as the draft state changes', async () => {
  mockCatalog(makeMockCatalog());

  const snapshots = await Promise.all(
    stageIds.map((stageId) => getValuationSnapshot(parseValuationRequest(readRequestFixture(stageId))))
  );

  const rows = snapshots.flatMap((snapshot, index) =>
    trackedPlayers.map((trackedPlayer) => {
      const player = snapshot.players.find((candidate) => candidate.mlbPlayerId === trackedPlayer.id);

      return {
        stage: stageIds[index],
        playerName: player.name,
        adjustedValue: player.adjustedValue,
        marketValue: player.marketValue,
        eligibleSlots: player.eligibleSlots.join(', '),
        fillsNeed: player.fillsNeed,
        maxBid: player.maxBid,
        remainingRosterSpots: snapshot.valuation.remainingRosterSpots,
        remainingBudget: snapshot.valuation.remainingBudget,
        budgetAdjustmentFactor: snapshot.valuation.budgetAdjustmentFactor,
      };
    })
  );

  if (process.env.VALUATION_TEST_VERBOSE === '1') {
    console.table(rows);
  }

  for (const trackedPlayer of trackedPlayers) {
    const playerRows = rows.filter((row) => row.playerName === trackedPlayer.name);

    expect(playerRows[0].adjustedValue).toBeGreaterThan(0);
    expect(new Set(playerRows.map((row) => row.adjustedValue)).size).toBeGreaterThan(1);

    for (let index = 1; index < playerRows.length; index += 1) {
      expect(playerRows[index].remainingRosterSpots).toBeLessThanOrEqual(playerRows[index - 1].remainingRosterSpots);
    }
  }
});
