import { describe, expect, it } from 'vite-plus/test';

import {
  REQUEST_ID_HEADER,
  generateRequestId,
  isValidRequestId,
  requestIdFromHeaders,
  resolveRequestId,
} from './request-id.ts';

/**
 * Matches a canonical UUID.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('passes a valid id through', () => {
    expect(resolveRequestId('req_1.a:b=c-2')).toBe('req_1.a:b=c-2');
    expect(resolveRequestId('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it.each([
    ['129 characters', 'a'.repeat(129)],
    ['a newline', 'abc\ndef'],
    ['a space', 'abc def'],
    ['a double quote', 'abc"def'],
    ['a single quote', "abc'def"],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('replaces an id with %s by a UUID', (_label, candidate) => {
    expect(resolveRequestId(candidate)).toMatch(UUID);
  });
});

describe('isValidRequestId', () => {
  it('accepts only 1 to 128 safe characters', () => {
    expect(isValidRequestId('abc-123')).toBe(true);
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('a'.repeat(129))).toBe(false);
  });
});

describe('generateRequestId', () => {
  it('returns a different valid UUID each time', () => {
    const first = generateRequestId();
    expect(first).toMatch(UUID);
    expect(isValidRequestId(first)).toBe(true);
    expect(generateRequestId()).not.toBe(first);
  });
});

describe('requestIdFromHeaders', () => {
  it('reads a valid x-request-id header', () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: 'abc-123' });
    expect(requestIdFromHeaders(headers)).toBe('abc-123');
  });

  it('generates an id when the header is missing or invalid', () => {
    expect(requestIdFromHeaders(new Headers())).toMatch(UUID);
    expect(requestIdFromHeaders(new Headers({ [REQUEST_ID_HEADER]: 'bad id' }))).toMatch(UUID);
  });
});
