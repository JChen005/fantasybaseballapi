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

  test('uses a high default request limit', () => {
    expect(getThrottleOptions()).toEqual({ maxRequests: 10000, windowMs: 60000 });
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
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });
});


describe('request throttling edge cases', () => {
  afterEach(() => {
    delete process.env.REQUEST_THROTTLE_MAX;
    delete process.env.REQUEST_THROTTLE_WINDOW_MS;
    jest.useRealTimers();
    resetThrottleBuckets();
  });

  test('falls back when env throttle settings are invalid', () => {
    process.env.REQUEST_THROTTLE_MAX = 'not-a-number';
    process.env.REQUEST_THROTTLE_WINDOW_MS = '-5';

    expect(getThrottleOptions()).toEqual({ maxRequests: 10000, windowMs: 60000 });
  });

  test('tracks different license ids independently', () => {
    process.env.REQUEST_THROTTLE_MAX = '1';
    process.env.REQUEST_THROTTLE_WINDOW_MS = '60000';

    const res = { setHeader: jest.fn() };
    const next = jest.fn();

    requestThrottle({ ip: '127.0.0.1', license: { id: 'license-a' } }, res, next);
    requestThrottle({ ip: '127.0.0.1', license: { id: 'license-b' } }, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(next.mock.calls[1][0]).toBeUndefined();
  });

  test('resets a bucket after its time window expires', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    process.env.REQUEST_THROTTLE_MAX = '1';
    process.env.REQUEST_THROTTLE_WINDOW_MS = '1000';

    const res = { setHeader: jest.fn() };
    const next = jest.fn();
    const req = { ip: '127.0.0.1', license: { id: 'license-window' } };

    requestThrottle(req, res, next);
    jest.setSystemTime(new Date('2026-01-01T00:00:01.500Z'));
    requestThrottle(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(next.mock.calls[1][0]).toBeUndefined();
  });
});


describe('request throttling additional behavior', () => {
  afterEach(() => {
    delete process.env.REQUEST_THROTTLE_MAX;
    delete process.env.REQUEST_THROTTLE_WINDOW_MS;
    resetThrottleBuckets();
  });

  test('uses IP address when no license id is attached yet', () => {
    process.env.REQUEST_THROTTLE_MAX = '1';
    process.env.REQUEST_THROTTLE_WINDOW_MS = '60000';
    const res = { setHeader: jest.fn() };
    const next = jest.fn();
    requestThrottle({ ip: '192.0.2.1' }, res, next);
    requestThrottle({ ip: '192.0.2.2' }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(next.mock.calls[1][0]).toBeUndefined();
  });

  test('sets RateLimit headers on allowed requests', () => {
    process.env.REQUEST_THROTTLE_MAX = '3';
    process.env.REQUEST_THROTTLE_WINDOW_MS = '60000';
    const res = { setHeader: jest.fn() };
    const next = jest.fn();
    requestThrottle({ ip: '127.0.0.1', license: { id: 'license-headers' } }, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Limit', '3');
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', '2');
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Reset', expect.any(String));
    expect(next).toHaveBeenCalledWith();
  });

  test('falls back for decimal throttle settings', () => {
    process.env.REQUEST_THROTTLE_MAX = '1.5';
    process.env.REQUEST_THROTTLE_WINDOW_MS = '60000.5';
    expect(getThrottleOptions()).toEqual({ maxRequests: 10000, windowMs: 60000 });
  });
});
