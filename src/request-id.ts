/**
 * Header that carries the request id.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Longest accepted request id, in characters.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Shape of an accepted request id: letters, digits and `_.:=-` only, so it is safe to log and
 * forward.
 */
const VALID_REQUEST_ID = new RegExp(`^[A-Za-z0-9_.:=-]{1,${MAX_REQUEST_ID_LENGTH}}$`);

/**
 * Creates a fresh request id, a random UUID.
 */
export const generateRequestId = (): string => crypto.randomUUID();

/**
 * True for 1 to 128 characters of letters, digits and `_.:=-`. Anything else, including an empty
 * string, a space or a line break, is rejected so an incoming id cannot inject log lines.
 */
export const isValidRequestId = (value: string | null | undefined): value is string =>
  typeof value === 'string' && VALID_REQUEST_ID.test(value);

/**
 * Returns `candidate` when it is a valid request id, otherwise a generated one.
 */
export const resolveRequestId = (candidate: string | null | undefined): string =>
  isValidRequestId(candidate) ? candidate : generateRequestId();

/**
 * Reads the `x-request-id` header and returns it when valid, otherwise a generated id.
 */
export const requestIdFromHeaders = (headers: Headers): string =>
  resolveRequestId(headers.get(REQUEST_ID_HEADER));
