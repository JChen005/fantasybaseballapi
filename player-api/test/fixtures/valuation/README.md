# Valuation Fixture Notes

This fixture package stores explicit Team A request payloads in the same shape the **webapp backend** sends to `POST /v1/valuations/players`.

Those request fixtures follow the current backend semantics:

- the selected valuation team is treated as `draftState.userTeamKey`
- all excluded players across the league are sent
- only the selected team's excluded players use `countsAgainstBudget: true`
- every other team's excluded players remain excluded, but do **not** consume the selected team's budget
- `filledSlots` reflects only the selected team's roster state

## Files

- `pre-draft-league.json`
  - Reference keeper snapshot inferred from the spreadsheet screenshot.
  - Includes team budgets, keeper costs/contracts, minors lists, inferred full names, and stable `playerId` values.
- `draft-picks.json`
  - Reference draft pick stream captured from the Draft worksheet.
  - Trimmed to payload-relevant fields:
    - `pickNumber`
    - `round`
    - `teamKey`
    - `playerId`
    - `playerName`
    - `cost`
    - `status`
    - `positions`
- `team-a/*.request.json`
  - Checked-in request fixtures that match what the webapp backend would send to the player API for Team A.
- `../../valuation-fixtures.test.js`
  - Validates that the checked-in Team A payloads exist, stay parseable, and still match the expected backend semantics.

## Important normalization choices

- Spreadsheet `U` is normalized to `UTIL`.
- Spreadsheet `CI` and `MI` are preserved in the reference fixture, but the request payloads do **not** model them directly because the current valuation code only reasons about:
  - `C`
  - `1B`
  - `2B`
  - `3B`
  - `SS`
  - `OF`
  - `P`
  - `UTIL`
- Only rows with a visible keeper contract/cost are treated as excluded pre-draft keepers.
- Minors are included as excluded pre-draft reserve players with:
  - `status: 'RESERVE'`
  - `cost: 0`
  - `countsAgainstBudget: false`

## Unresolved players

Some inferred names do not resolve against the **current active catalog**. Those keepers/minors still remain in the fixture, but they now get a stable synthetic `playerId` so the reference data stays payload-shaped.

Resolved players keep their real MLB-derived ids. Unresolved players use fixture-scoped synthetic numeric ids.

That keeps the reference data honest without carrying null ids that would be invalid in a real payload.

## Stage checkpoints

The spreadsheet instructions call for valuations at:

1. before the draft
2. after 10 picks
3. after 50 picks
4. after 100 picks
5. after 130 picks

The checked-in request fixtures cover:

- `team-a/before-draft.request.json`
- `team-a/after-10.request.json`
- `team-a/after-50.request.json`
- `team-a/after-100.request.json`
- `team-a/after-130.request.json`
