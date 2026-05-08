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


describe('request validators: additional valuation edge cases', () => {
  const baseRequest = {
    league: {
      budget: 260,
      teamCount: 10,
      leagueType: 'NL',
      rosterSlots: { C: 1, OF: 3, P: 5 },
    },
    filters: {},
    draftState: { filledSlots: {}, excludedPlayers: [] },
  };

  test('parseIncludeInactive accepts only literal true', () => {
    const { parseIncludeInactive } = require('../src/validators/requestValidators');

    expect(parseIncludeInactive('true')).toBe(true);
    expect(parseIncludeInactive('TRUE')).toBe(true);
    expect(parseIncludeInactive('false')).toBe(false);
    expect(parseIncludeInactive('1')).toBe(false);
  });

  test('parseValuationRequest rejects missing league objects and invalid budgets/team counts', () => {
    expect(() => parseValuationRequest({})).toThrow('league is required');
    expect(() => parseValuationRequest({ ...baseRequest, league: { ...baseRequest.league, budget: 0 } })).toThrow(
      'league.budget must be a positive number'
    );
    expect(() => parseValuationRequest({ ...baseRequest, league: { ...baseRequest.league, teamCount: 1.5 } })).toThrow(
      'league.teamCount must be a positive integer'
    );
  });

  test('parseValuationRequest rejects empty roster configuration and bad dollarable pool shares', () => {
    expect(() => parseValuationRequest({ ...baseRequest, league: { ...baseRequest.league, rosterSlots: { C: 0 } } })).toThrow(
      'league.rosterSlots must include at least one slot'
    );
    expect(() =>
      parseValuationRequest({ ...baseRequest, league: { ...baseRequest.league, dollarablePoolShare: 1.5 } })
    ).toThrow('league.dollarablePoolShare must be a number between 0 and 1');
  });

  test('parseValuationRequest rejects overlong search strings and invalid player references', () => {
    expect(() =>
      parseValuationRequest({ ...baseRequest, filters: { search: 'x'.repeat(121) } })
    ).toThrow('filters.search must be at most 120 characters');

    expect(() =>
      parseValuationRequest({
        ...baseRequest,
        draftState: { excludedPlayers: [{ playerId: 'not-valid', status: 'DRAFTED', cost: 1 }] },
      })
    ).toThrow('Invalid draftState.excludedPlayers[0].playerId');
  });

  test('validatePlayerReference supports both ObjectIds and MLB ids', () => {
    const { validatePlayerReference } = require('../src/validators/requestValidators');

    expect(validatePlayerReference('507f1f77bcf86cd799439011')).toBe('507f1f77bcf86cd799439011');
    expect(validatePlayerReference('592450')).toBe(592450);
    expect(() => validatePlayerReference('0')).toThrow('Invalid playerId');
  });
});


describe('request validators: expanded scalar and valuation cases', () => {
  const baseRequest = {
    league: { budget: 260, teamCount: 12, leagueType: 'AL', rosterSlots: { C: 1, OF: 3, P: 5 } },
    filters: {},
    draftState: { filledSlots: {}, excludedPlayers: [] },
  };

  test('parseLimit floors decimals and clamps negative values to the minimum', () => {
    expect(parseLimit('10.9')).toBe(10);
    expect(parseLimit('-99')).toBe(1);
  });

  test('parseSearchQuery uses API defaults for empty searches', () => {
    expect(parseSearchQuery({})).toEqual({ includeDrafted: true, includeInactive: false, limit: 200, leagueType: null, q: '', escapedQuery: '' });
  });

  test('parseSeason rejects decimal and too-far-future years', () => {
    expect(() => parseSeason('2025.5')).toThrow('season must be a valid year');
    expect(() => parseSeason('3001')).toThrow('season must be a valid year');
  });

  test('validate ids reject blanks, decimals, and non-positive team ids', () => {
    expect(() => validatePlayerId('')).toThrow('Invalid player ID');
    expect(() => validatePlayerId('1.5')).toThrow('Invalid player ID');
    expect(() => validateTeamId('0')).toThrow('Invalid team ID');
    expect(() => validateTeamId('1.5')).toThrow('Invalid team ID');
  });

  test('parseValuationRequest rejects malformed roster slots and filled slots', () => {
    expect(() => parseValuationRequest({ ...baseRequest, league: { ...baseRequest.league, rosterSlots: [] } })).toThrow('league.rosterSlots is required');
    expect(() => parseValuationRequest({ ...baseRequest, league: { ...baseRequest.league, rosterSlots: { C: -1 } } })).toThrow('league.rosterSlots.C must be a non-negative integer');
    expect(() => parseValuationRequest({ ...baseRequest, draftState: { filledSlots: [] } })).toThrow('draftState.filledSlots must be an object');
    expect(() => parseValuationRequest({ ...baseRequest, draftState: { filledSlots: { OF: 1.5 } } })).toThrow('draftState.filledSlots.OF must be a non-negative integer');
  });

  test('parseValuationRequest accepts a custom dollarable pool share in range', () => {
    expect(parseValuationRequest({ ...baseRequest, league: { ...baseRequest.league, dollarablePoolShare: '0.45' } }).league.dollarablePoolShare).toBe(0.45);
  });

  test('parseValuationRequest treats non-object filters as empty filters', () => {
    expect(parseValuationRequest({ ...baseRequest, filters: [] }).filters).toMatchObject({ limit: 200, includeInactive: false, search: '', escapedSearch: '' });
  });

  test('parseValuationRequest rejects non-object excluded player rows', () => {
    expect(() => parseValuationRequest({ ...baseRequest, draftState: { excludedPlayers: [null] } })).toThrow('draftState.excludedPlayers[0] must be an object');
  });
});
