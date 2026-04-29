const {
  parseLeagueType,
  parseLimit,
  parseSearchQuery,
  parseSeason,
  parseValuationRequest,
  validatePlayerId,
  validateTeamId,
} = require('../src/validators/requestValidators');

describe('request validators: shared scalar parsing', () => {
  test('parseLimit clamps values to the supported API range', () => {
    expect(parseLimit(undefined, 200)).toBe(200);
    expect(parseLimit(0)).toBe(1);
    expect(parseLimit(999)).toBe(500);
  });

  test('parseLimit rejects non-numeric values', () => {
    expect(() => parseLimit('many')).toThrow('limit must be a number');
  });

  test.each([
    ['MIXED', null],
    ['mixed', null],
    ['AL', 'AL'],
    ['nl', 'NL'],
    ['', null],
    [undefined, null],
  ])('parseLeagueType(%p) -> %p', (input, expected) => {
    expect(parseLeagueType(input)).toBe(expected);
  });

  test('parseLeagueType rejects unsupported league types', () => {
    expect(() => parseLeagueType('KBO')).toThrow('leagueType must be AL, NL, MIXED, or omitted');
  });

  test('parseSeason accepts empty values and rejects impossible years', () => {
    expect(parseSeason('', 2026)).toBe(2026);
    expect(parseSeason('2025')).toBe(2025);
    expect(() => parseSeason('1899')).toThrow('season must be a valid year');
  });

  test('player and team ids normalize strings to numbers when possible', () => {
    expect(validatePlayerId('12345')).toBe(12345);
    expect(validateTeamId('147')).toBe(147);
    expect(() => validatePlayerId('not-an-id')).toThrow('Invalid player ID');
    expect(() => validateTeamId('-1')).toThrow('Invalid team ID');
  });
});

describe('request validators: search requests', () => {
  test('parseSearchQuery normalizes booleans, limits, and escaped search text', () => {
    const result = parseSearchQuery({
      q: 'Judge (OF).*',
      includeDrafted: 'false',
      includeInactive: 'true',
      limit: '25',
      leagueType: 'al',
    });

    expect(result).toEqual({
      includeDrafted: false,
      includeInactive: true,
      limit: 25,
      leagueType: 'AL',
      q: 'Judge (OF).*',
      escapedQuery: 'Judge \\(OF\\)\\.\\*',
    });
  });

  test('parseSearchQuery truncates very long search text', () => {
    const result = parseSearchQuery({ q: 'x'.repeat(100) });

    expect(result.q).toHaveLength(80);
    expect(result.escapedQuery).toHaveLength(80);
  });
});

describe('request validators: valuation requests', () => {
  const validRequest = {
    league: {
      budget: '260',
      teamCount: '12',
      leagueType: 'mixed',
      rosterSlots: { C: 1, OF: 5, P: 9, BN: 4 },
    },
    filters: {
      limit: 999,
      includeInactive: 'true',
      search: 'Witt Jr.',
    },
    draftState: {
      filledSlots: { OF: '2', P: 3 },
      excludedPlayers: [
        { playerId: '677951', status: 'keeper', cost: '42', countsAgainstBudget: true },
        { playerId: '592450', status: 'drafted', cost: 38, countsAgainstBudget: false },
      ],
    },
  };

  test('parseValuationRequest normalizes league, filters, filled slots, and excluded players', () => {
    expect(parseValuationRequest(validRequest)).toEqual({
      league: {
        budget: 260,
        teamCount: 12,
        leagueType: null,
        rosterSlots: { C: 1, OF: 5, P: 9, BN: 4 },
        dollarablePoolShare: 0.3,
      },
      filters: {
        limit: 500,
        includeInactive: true,
        search: 'Witt Jr.',
        escapedSearch: 'Witt Jr\\.',
      },
      draftState: {
        filledSlots: { OF: 2, P: 3 },
        excludedPlayers: [
          { playerId: 677951, status: 'KEEPER', cost: 42, countsAgainstBudget: true },
          { playerId: 592450, status: 'DRAFTED', cost: 38, countsAgainstBudget: false },
        ],
      },
    });
  });

  test('parseValuationRequest rejects invalid filled-slot keys and overfilled slots', () => {
    expect(() =>
      parseValuationRequest({
        ...validRequest,
        draftState: { filledSlots: { SS: 1 }, excludedPlayers: [] },
      })
    ).toThrow('draftState.filledSlots.SS is not a valid roster slot');

    expect(() =>
      parseValuationRequest({
        ...validRequest,
        draftState: { filledSlots: { C: 2 }, excludedPlayers: [] },
      })
    ).toThrow('draftState.filledSlots.C cannot exceed league.rosterSlots.C');
  });

  test('parseValuationRequest rejects invalid excluded-player rows', () => {
    expect(() =>
      parseValuationRequest({
        ...validRequest,
        draftState: { excludedPlayers: [{ playerId: '123', status: 'WAIVED', cost: 1 }] },
      })
    ).toThrow('draftState.excludedPlayers[0].status is invalid');

    expect(() =>
      parseValuationRequest({
        ...validRequest,
        draftState: { excludedPlayers: [{ playerId: '123', status: 'DRAFTED', cost: -1 }] },
      })
    ).toThrow('draftState.excludedPlayers[0].cost must be a non-negative number');
  });
});
