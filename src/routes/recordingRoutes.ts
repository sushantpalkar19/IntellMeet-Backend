import { Router } from 'express';
import { deleteRecording, createPlaybackTicket, listRecordings, streamRecording } from '../controllers/meetingRecordingController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.get('/', authenticate, listRecordings);
router.post('/:recordingId/playback-ticket', authenticate, createPlaybackTicket);
router.get('/:recordingId/stream', streamRecording);
router.delete('/:recordingId', authenticate, deleteRecording);
export default router;
