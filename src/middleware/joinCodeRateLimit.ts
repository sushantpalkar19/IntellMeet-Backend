import { Request, Response, NextFunction } from 'express';

const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

export function joinCodeRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }
  if (current.count >= MAX_ATTEMPTS) {
    res.status(429).json({ error: 'Too Many Requests', message: 'Too many meeting code attempts. Try again shortly.' });
    return;
  }
  current.count += 1;
  next();
}
