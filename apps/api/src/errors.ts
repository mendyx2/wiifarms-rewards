/** An error that is safe to show to the caller. Anything else becomes a generic 500. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const badRequest = (code: string, msg: string) => new AppError(400, code, msg);
export const unauthorized = (msg = "Please sign in.") => new AppError(401, "UNAUTHENTICATED", msg);
export const forbidden = (code: string, msg: string) => new AppError(403, code, msg);
export const notFound = (msg = "Not found.") => new AppError(404, "NOT_FOUND", msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
