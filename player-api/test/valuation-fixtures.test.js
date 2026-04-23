'use strict';

const fs = require('fs');
const path = require('path');

const mockPlayerFind = jest.fn();

jest.mock('../src/models/Player', () => ({
  find: mockPlayerFind,
}));

const { parseValuationRequest } = require('../src/validators/requestValidators');
const { getValuationSnapshot } = require('../src/services/playerService');
const stageFixtureDir = path.join(__dirname, 'fixtures/valuation/team-a');
const preDraftFixture = require('./fixtures/valuation/pre-draft-league.json');
const draftPicks = require('./fixtures/valuation/draft-picks.json');
const expectedStageFiles = [
  'after-10.request.json',
  'after-100.request.json',
  'after-130.request.json',
  'after-50.request.json',
  'before-draft.request.json',
];
const valuationStageIds = ['before-draft', 'after-10', 'after-50', 'after-100', 'after-130'];
const valuationTargetPlayers = [
  {
    id: 592450,
    name: 'Aaron Judge',
    baseValue: 120,
    positions: ['OF', 'UTIL'],
  },
  {
    id: 677951,
    name: 'Bobby Witt Jr.',
    baseValue: 105,
    positions: ['SS', 'UTIL'],
  },
];

function readStageFixture(stageId) {
  return JSON.parse(fs.readFileSync(path.join(stageFixtureDir, `${stageId}.request.json`), 'utf8'));
}

function readAllStageFixtures() {
  return fs
    .readdirSync(stageFixtureDir)
    .filter((filename) => filename.endsWith('.request.json'))
    .sort()
    .map((filename) => ({
      filename,
      request: JSON.parse(fs.readFileSync(path.join(stageFixtureDir, filename), 'utf8')),
    }));
}

function collectExcludedPlayerIds(query) {
  const excludedIds = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    const excludedValues = node.mlbPlayerId?.$nin;
    if (Array.isArray(excludedValues)) {
      for (const id of excludedValues) excludedIds.add(id);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }

  visit(query);
  return excludedIds;
}

function mockPlayerFindWithCatalog(catalog) {
  mockPlayerFind.mockImplementation((query = {}) => {
    let isPoolQuery = false;
    const chain = {
      sort() {
        return chain;
      },
      limit() {
        return chain;
      },
      select() {
        isPoolQuery = true;
        return chain;
      },
      lean() {
        const excludedIds = collectExcludedPlayerIds(query);
        const players = catalog
          .filter((player) => !excludedIds.has(player.mlbPlayerId))
          .sort((left, right) => right.baseValue - left.baseValue || left.name.localeCompare(right.name));

        if (!isPoolQuery) return Promise.resolve(players);

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

function buildValuationCatalog() {
  const targetPlayers = valuationTargetPlayers.map((player, index) => ({
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
  const supportingPlayers = Array.from({ length: 240 }, (_, index) => ({
    _id: `64f0000000000000000${String(index + 1 + targetPlayers.length).padStart(5, '0')}`,
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

  return [...targetPlayers, ...supportingPlayers];
}

afterEach(() => {
  mockPlayerFind.mockReset();
});

test('checked-in Team A stage payload fixtures exist for every required checkpoint', () => {
  expect(fs.existsSync(stageFixtureDir)).toBe(true);
  expect(fs.readdirSync(stageFixtureDir).sort()).toEqual(expectedStageFiles);
});

test('reference fixtures use payload-style player ids without nulls', () => {
  const allKeeperAndMinorEntries = preDraftFixture.teams.flatMap((team) => [
    ...(team.keepers || []),
    ...(team.minors || []),
  ]);

  expect(allKeeperAndMinorEntries.length).toBeGreaterThan(0);
  expect(allKeeperAndMinorEntries.every((entry) => Number.isInteger(entry.playerId))).toBe(true);
  expect(draftPicks.every((pick) => Number.isInteger(pick.playerId))).toBe(true);
});

test('draft pick reference data is trimmed to payload-relevant fields', () => {
  const samplePick = draftPicks[0];

  expect(samplePick).toEqual(
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
  expect(samplePick.broughtUpBy).toBeUndefined();
  expect(samplePick.wonBy).toBeUndefined();
  expect(samplePick.salary).toBeUndefined();
  expect(samplePick.mlbPlayerId).toBeUndefined();
});

test('before-draft Team A request fixture is a valid player-api valuation payload', () => {
  const request = readStageFixture('before-draft');
  const parsed = parseValuationRequest(request);

  expect(parsed.league.budget).toBe(260);
  expect(parsed.league.teamCount).toBe(9);
  expect(parsed.draftState.excludedPlayers.length).toBeGreaterThan(0);
  expect(request.league.leagueType).toBe('MIXED');
  expect(request.draftState.userTeamKey).toBe('team-a');
  expect(parsed.draftState.filledSlots).toEqual({
    C: 1,
    '2B': 1,
    OF: 1,
    P: 4,
  });
  expect(
    request.draftState.excludedPlayers.some((entry) => entry.countsAgainstBudget && entry.teamKey === 'team-a')
  ).toBe(true);
  expect(
    request.draftState.excludedPlayers.some((entry) => !entry.countsAgainstBudget && entry.teamKey !== 'team-a')
  ).toBe(true);
});

test('team-a stage valuation request fixtures remain valid at every required checkpoint', () => {
  for (const { request } of readAllStageFixtures()) {
    const parsed = parseValuationRequest(request);

    expect(request.draftState.userTeamKey).toBe('team-a');
    expect(parsed.filters.limit).toBe(500);
    expect(parsed.filters.includeInactive).toBe(false);
    expect(parsed.draftState.excludedPlayers.length).toBeGreaterThan(0);
  }
});

test('team-a fixture matches webapp semantics: only team a exclusions count against budget', () => {
  const request = readStageFixture('after-50');
  const teamABudgetEntries = request.draftState.excludedPlayers.filter((entry) => entry.countsAgainstBudget);
  const nonTeamABudgetEntries = request.draftState.excludedPlayers.filter(
    (entry) => entry.teamKey !== 'team-a' && entry.countsAgainstBudget
  );

  expect(teamABudgetEntries.length).toBeGreaterThan(0);
  expect(nonTeamABudgetEntries.length).toBe(0);
  expect(teamABudgetEntries.every((entry) => entry.teamKey === 'team-a')).toBe(true);
});

test('later stage fixtures increase Team A filled slots as draft picks accumulate', () => {
  const beforeDraft = readStageFixture('before-draft');
  const afterTen = readStageFixture('after-10');
  const afterFifty = readStageFixture('after-50');

  expect(afterTen.draftState.filledSlots.P).toBeGreaterThanOrEqual(beforeDraft.draftState.filledSlots.P);
  expect(Object.values(afterFifty.draftState.filledSlots).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(
    Object.values(beforeDraft.draftState.filledSlots).reduce((sum, count) => sum + count, 0)
  );
});

test('same available player receives different valuations as the draft stage changes', async () => {
  mockPlayerFindWithCatalog(buildValuationCatalog());

  const snapshots = await Promise.all(
    valuationStageIds.map((stageId) => getValuationSnapshot(parseValuationRequest(readStageFixture(stageId))))
  );
  const values = snapshots.flatMap((snapshot, index) =>
    valuationTargetPlayers.map((targetPlayer) => {
      const player = snapshot.players.find((candidate) => candidate.mlbPlayerId === targetPlayer.id);
      return {
        stage: valuationStageIds[index],
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
    console.table(values);
  }

  for (const targetPlayer of valuationTargetPlayers) {
    const playerValues = values.filter((value) => value.playerName === targetPlayer.name);
    expect(playerValues[0].adjustedValue).toBeGreaterThan(0);
    expect(new Set(playerValues.map((value) => value.adjustedValue)).size).toBeGreaterThan(1);
    for (let index = 1; index < playerValues.length; index += 1) {
      expect(playerValues[index].remainingRosterSpots).toBeLessThanOrEqual(playerValues[index - 1].remainingRosterSpots);
    }
  }
});
