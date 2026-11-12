import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { getNotifications, getReminderPreference, markNotificationRead, setReminderPreference } from '../controllers/scheduleController.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();
router.use(authenticate);
router.get('/', asyncHandler(getNotifications));
router.patch('/:notificationId/read', asyncHandler(markNotificationRead));
router.get('/preferences/reminders', asyncHandler(getReminderPreference));
router.put('/preferences/reminders', asyncHandler(setReminderPreference));
export default router;
