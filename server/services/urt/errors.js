// Errors the URT services raise; the controller maps them to HTTP responses (docs/api/urt-passages.md).
export class UrtError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const notFound = (what) => new UrtError(404, 'URT_NOT_FOUND', `${what} not found`);
export const forbidden = () => new UrtError(403, 'URT_FORBIDDEN', 'This resource belongs to another user');
export const badRequest = (code, message, details) => new UrtError(400, code, message, details ? { details } : {});

/** Raised by a repository when a unique key (userId, passageId) or contentHash is already taken. */
export class DuplicateError extends Error {
  constructor(what) {
    super(`duplicate ${what}`);
    this.what = what;
  }
}
