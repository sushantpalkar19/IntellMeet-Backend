import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../utils/jwt.js';
import User from '../models/User.js';

// Extend Express Request to include userId
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userPayload?: TokenPayload;
    }
  }
}

/**
 * Authentication middleware to verify JWT access token
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'No token provided',
      });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    const payload = verifyAccessToken(token);

    // Attach user information to request
    req.userId = payload.userId;
    req.userPayload = payload;

    const user = await User.findById(payload.userId).select('mustChangePassword');
    const isPasswordChangeRequest = req.baseUrl === '/api/v1/auth' && req.path === '/change-password';
    if (user?.mustChangePassword && !isPasswordChangeRequest) {
      res.status(403).json({ error: 'Password Change Required', code: 'PASSWORD_CHANGE_REQUIRED', message: 'Change your temporary password to continue' });
      return;
    }
    if (!user) {
      res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
      return;
    }

    next();
  } catch (error) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  }
}
