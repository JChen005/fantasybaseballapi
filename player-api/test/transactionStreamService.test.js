const {
  SSE_EVENTS,
  buildTransactionEvent,
  formatSseFrame,
  publishTransactionEvent,
  transactionEventBus,
} = require('../src/services/transactionStreamService');

describe('transaction stream service', () => {
  test('buildTransactionEvent creates the payload shape expected by the SSE stream', () => {
    const event = buildTransactionEvent({
      playerId: 592450,
      playerName: 'Aaron Judge',
      type: 'INJURY',
      detail: 'Day-to-day with soreness',
    });

    expect(event).toMatchObject({
      playerId: '592450',
      playerName: 'Aaron Judge',
      type: 'INJURY',
      detail: 'Day-to-day with soreness',
    });
    expect(event.eventId).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
  });

  test('formatSseFrame emits a valid event-stream frame', () => {
    const payload = { playerId: '592450', detail: 'Activated from IL' };

    expect(formatSseFrame(SSE_EVENTS.PLAYER_TRANSACTION_CREATED, payload)).toBe(
      `event: ${SSE_EVENTS.PLAYER_TRANSACTION_CREATED}\ndata: ${JSON.stringify(payload)}\n\n`
    );
  });

  test('publishTransactionEvent notifies subscribers on the transaction event bus', () => {
    const listener = jest.fn();
    const payload = { playerId: '677951', playerName: 'Bobby Witt Jr.' };

    transactionEventBus.once(SSE_EVENTS.PLAYER_TRANSACTION_CREATED, listener);
    publishTransactionEvent(payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);
  });
});
