const mockFindActiveLicenseByApiKey = jest.fn();

jest.mock('../src/services/licenseService', () => ({
  findActiveLicenseByApiKey: mockFindActiveLicenseByApiKey,
}));

const { requireLicense } = require('../src/middleware/requireLicense');

function makeResponse() {
  return {};
}

describe('requireLicense middleware', () => {
  beforeEach(() => {
    mockFindActiveLicenseByApiKey.mockReset();
  });

  test('rejects missing API keys before hitting the database', async () => {
    const req = { headers: {} };
    const next = jest.fn();

    await requireLicense(req, makeResponse(), next);

    expect(mockFindActiveLicenseByApiKey).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401, message: 'Missing API key' }));
  });

  test('rejects inactive or unknown API keys', async () => {
    mockFindActiveLicenseByApiKey.mockResolvedValue(null);
    const req = { headers: { 'x-api-key': 'pk-missing' } };
    const next = jest.fn();

    await requireLicense(req, makeResponse(), next);

    expect(mockFindActiveLicenseByApiKey).toHaveBeenCalledWith('pk-missing');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403, message: 'Invalid or inactive API key' }));
  });

  test('attaches active license metadata to the request', async () => {
    mockFindActiveLicenseByApiKey.mockResolvedValue({
      _id: { toString: () => 'license-1' },
      consumerName: 'DraftKit',
      keyPreview: 'pk-a...1234',
    });
    const req = { headers: { 'x-api-key': '  pk-good  ' } };
    const next = jest.fn();

    await requireLicense(req, makeResponse(), next);

    expect(mockFindActiveLicenseByApiKey).toHaveBeenCalledWith('pk-good');
    expect(req.license).toEqual({
      id: 'license-1',
      consumerName: 'DraftKit',
      keyPreview: 'pk-a...1234',
    });
    expect(next).toHaveBeenCalledWith();
  });

  test('passes database errors to next', async () => {
    const error = new Error('database unavailable');
    mockFindActiveLicenseByApiKey.mockRejectedValue(error);
    const next = jest.fn();

    await requireLicense({ headers: { 'x-api-key': 'pk-good' } }, makeResponse(), next);

    expect(next).toHaveBeenCalledWith(error);
  });
});


describe('requireLicense middleware edge cases', () => {
  beforeEach(() => {
    mockFindActiveLicenseByApiKey.mockReset();
  });

  test.each([[''], ['   '], [123]])('rejects blank or non-string API key header %#', async (headerValue) => {
    const req = { headers: { 'x-api-key': headerValue } };
    const next = jest.fn();
    await requireLicense(req, makeResponse(), next);
    expect(mockFindActiveLicenseByApiKey).not.toHaveBeenCalled();
    expect(req.license).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401, message: 'Missing API key' }));
  });

  test('does not attach license data when the lookup fails', async () => {
    mockFindActiveLicenseByApiKey.mockResolvedValue(null);
    const req = { headers: { 'x-api-key': 'pk-bad' } };
    const next = jest.fn();
    await requireLicense(req, makeResponse(), next);
    expect(req.license).toBeUndefined();
  });
});
