import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';

const router = Router();

/**
 * @route   GET /api/v1/protected/example
 * @desc    Example protected route
 * @access  Private
 */
router.get('/example', authenticate, (req: Request, res: Response) => {
  res.json({
    message: 'This is a protected route',
    user: {
      userId: req.userId,
      email: req.userPayload?.email,
    },
  });
});

/**
 * @route   GET /api/v1/protected/dashboard
 * @desc    Example dashboard data (protected)
 * @access  Private
 */
router.get('/dashboard', authenticate, (req: Request, res: Response) => {
  res.json({
    message: 'Dashboard data',
    userId: req.userId,
    timestamp: new Date().toISOString(),
  });
});

export default router;
