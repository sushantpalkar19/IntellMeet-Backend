import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { aiAnalytics, analyticsOverview, meetingAnalytics, taskAnalytics, workspaceComparison } from '../controllers/analyticsController.js';

const router = Router();
router.use(authenticate);
router.get('/overview', asyncHandler(analyticsOverview));
router.get('/meetings', asyncHandler(meetingAnalytics));
router.get('/tasks', asyncHandler(taskAnalytics));
router.get('/ai', asyncHandler(aiAnalytics));
router.get('/workspaces', asyncHandler(workspaceComparison));
export default router;
