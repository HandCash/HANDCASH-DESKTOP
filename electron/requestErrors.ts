import type { ErrorRequestHandler, Response } from 'express'

/**
 * Answers a request Express could not take (an unreadable or oversized body, or
 * a route that threw) as a JSON error. Express's own answer is an HTML page with
 * the stack trace and the user's local paths, readable by any origin.
 */
export function jsonRequestErrors(setCorsHeaders: (res: Response) => void): ErrorRequestHandler {
  return (error, _req, res, next) => {
    if (res.headersSent) return next(error)
    const status = Number((error as { status?: unknown } | null)?.status)
    const [code, description, answer] =
      status === 413
        ? ['BODY_TOO_LARGE', 'The request body is too large.', 413]
        : status >= 400 && status < 500
          ? ['BAD_REQUEST', 'The request body is not valid JSON or text.', 400]
          : ['HTTP_ERROR', 'The request failed.', 500]
    setCorsHeaders(res)
    res.status(answer).json({ status: 'error', code, description })
  }
}
