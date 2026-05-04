const {
  getThrottleOptions,
  requestThrottle,
  resetThrottleBuckets,
} = require('../src/middleware/requestThrottle');

describe('request throttling', () => {
  afterEach(() => {
    delete process.env.REQUEST_THROTTLE_MAX;
    delete process.env.REQUEST_THROTTLE_WINDOW_MS;
    resetThrottleBuckets();
  });

  test('reads positive throttle settings from env', () => {
    process.env.REQUEST_THROTTLE_MAX = '3';
    process.env.REQUEST_THROTTLE_WINDOW_MS = '1000';

    expect(getThrottleOptions()).toEqual({ maxRequests: 3, windowMs: 1000 });
  });

  test('blocks requests after the configured limit', () => {
    process.env.REQUEST_THROTTLE_MAX = '1';
    process.env.REQUEST_THROTTLE_WINDOW_MS = '60000';

    const req = { ip: '127.0.0.1', license: { id: 'license-1' } };
    const res = { setHeader: jest.fn() };
    const next = jest.fn();

    requestThrottle(req, res, next);
    requestThrottle(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(next.mock.calls[1][0].status).toBe(429);
  });
});
