const crypto = require('crypto');

const {
  generateApiKey,
  hashApiKey,
  makeKeyPreview,
} = require('../src/services/licenseService');

describe('license service helpers', () => {
  test('generates opaque player API keys with the pk prefix', () => {
    const key = generateApiKey();

    expect(key).toMatch(/^pk-[a-f0-9]{48}$/);
    expect(generateApiKey()).not.toBe(key);
  });

  test('hashes API keys using sha256 hex output', () => {
    const apiKey = 'pk-example';
    const expected = crypto.createHash('sha256').update(apiKey).digest('hex');

    expect(hashApiKey(apiKey)).toBe(expected);
    expect(hashApiKey(apiKey)).toHaveLength(64);
  });

  test.each([
    ['', '***'],
    ['abcd', 'a***d'],
    ['pk-1234567890abcdef', 'pk-1...cdef'],
  ])('makes safe key previews for %p', (input, expected) => {
    expect(makeKeyPreview(input)).toBe(expected);
  });
});


describe('license service helper edge cases', () => {
  test('makeKeyPreview trims whitespace before previewing', () => {
    expect(makeKeyPreview('  pk-abcdef123456  ')).toBe('pk-a...3456');
  });

  test('makeKeyPreview handles one-character keys defensively', () => {
    expect(makeKeyPreview('x')).toBe('x***x');
  });

  test('hashApiKey is deterministic and different keys hash differently', () => {
    expect(hashApiKey('pk-one')).toBe(hashApiKey('pk-one'));
    expect(hashApiKey('pk-one')).not.toBe(hashApiKey('pk-two'));
  });

  test('generated API keys have enough random hex material after the prefix', () => {
    const key = generateApiKey();
    const [, hex] = key.split('pk-');
    expect(hex).toHaveLength(48);
    expect(Buffer.from(hex, 'hex')).toHaveLength(24);
  });
});
