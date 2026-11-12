import { Router } from 'express';
import {
  createMeeting,
  listMeetings,
  getMeeting,
  joinMeeting,
  endMeeting,
  getMeetingMessages,
  getMeetingInvitation,
  joinMeetingByCode,
} from '../controllers/meetingController.js';
import { authenticate } from '../middleware/auth.js';
import { joinCodeRateLimit } from '../middleware/joinCodeRateLimit.js';
import { requireMeetingAccess, requireMeetingHost } from '../middleware/meetingAuth.js';
import express from 'express';
import { exportTranscriptText, getTranscript, uploadTranscriptChunk } from '../controllers/transcriptController.js';
import { deleteActionItem, generateSummary, getActionItems, getSummary, updateActionItem, updateActionItemStatus } from '../controllers/meetingNotesController.js';
import { controlRecording, respondConsent, startRecording, uploadRecording } from '../controllers/meetingRecordingController.js';
import { cancelScheduledMeeting, getCalendarMeetings, getScheduledMeeting, manageMeetingInvitees, removeMeetingInvitee, scheduleMeeting, updateScheduledMeeting } from '../controllers/scheduleController.js';
import { requireMember, requireWorkspaceMembership } from '../middleware/workspaceAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

/**
 * @route   POST /api/v1/meetings
 * @desc    Create a new meeting
 * @access  Private (member of workspace)
 */
router.post('/', authenticate, createMeeting);
router.post('/scheduled', authenticate, requireWorkspaceMembership, requireMember, asyncHandler(scheduleMeeting));
router.post('/join-by-code', authenticate, joinCodeRateLimit, joinMeetingByCode);

/**
 * @route   GET /api/v1/meetings
 * @desc    List meetings for workspaces the user can access
 * @access  Private
 */
router.get('/', authenticate, listMeetings);
router.get('/calendar', authenticate, asyncHandler(getCalendarMeetings));
router.get('/upcoming', authenticate, asyncHandler(getCalendarMeetings));

/**
 * @route   GET /api/v1/meetings/:meetingId
 * @desc    Get meeting details
 * @access  Private (member of workspace)
 */
router.get('/:meetingId', authenticate, requireMeetingAccess, getMeeting);
router.get('/:meetingId/schedule-details', authenticate, requireMeetingAccess, asyncHandler(getScheduledMeeting));
router.put('/:meetingId/schedule', authenticate, requireMeetingAccess, asyncHandler(updateScheduledMeeting));
router.post('/:meetingId/cancel', authenticate, requireMeetingAccess, asyncHandler(cancelScheduledMeeting));
router.get('/:meetingId/invitees', authenticate, requireMeetingAccess, asyncHandler(manageMeetingInvitees));
router.post('/:meetingId/invitees', authenticate, requireMeetingAccess, asyncHandler(manageMeetingInvitees));
router.delete('/:meetingId/invitees/:userId', authenticate, requireMeetingAccess, asyncHandler(removeMeetingInvitee));
router.get('/:meetingId/invitation', authenticate, getMeetingInvitation);

/**
 * @route   POST /api/v1/meetings/:meetingId/join
 * @desc    Join a meeting
 * @access  Private (member of workspace)
 */
router.post('/:meetingId/join', authenticate, requireMeetingAccess, joinMeeting);

/**
 * @route   POST /api/v1/meetings/:meetingId/end
 * @desc    End a meeting
 * @access  Private (actual meeting host only)
 */
router.post('/:meetingId/end', authenticate, requireMeetingAccess, requireMeetingHost, endMeeting);

/**
 * @route   GET /api/v1/meetings/:meetingId/messages
 * @desc    Get meeting messages with pagination
 * @access  Private (member of workspace)
 */
router.get('/:meetingId/messages', authenticate, requireMeetingAccess, getMeetingMessages);

router.get('/:meetingId/transcripts', authenticate, requireMeetingAccess, getTranscript);
router.get('/:meetingId/transcripts/export.txt', authenticate, requireMeetingAccess, exportTranscriptText);
router.post(
  '/:meetingId/transcripts/chunks',
  authenticate,
  requireMeetingAccess,
  express.raw({ type: ['audio/webm', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/mpeg', 'audio/flac'], limit: '2mb' }),
  uploadTranscriptChunk,
);

router.post('/:meetingId/summary/generate', authenticate, requireMeetingAccess, generateSummary);
router.post('/:meetingId/summary/regenerate', authenticate, requireMeetingAccess, generateSummary);
router.get('/:meetingId/summary', authenticate, requireMeetingAccess, getSummary);
router.get('/:meetingId/action-items', authenticate, requireMeetingAccess, getActionItems);
router.patch('/:meetingId/action-items/:actionItemId', authenticate, requireMeetingAccess, updateActionItem);
router.patch('/:meetingId/action-items/:actionItemId/status', authenticate, requireMeetingAccess, updateActionItemStatus);
router.delete('/:meetingId/action-items/:actionItemId', authenticate, requireMeetingAccess, deleteActionItem);

router.post('/:meetingId/recordings/start', authenticate, requireMeetingAccess, startRecording);
router.post('/:meetingId/recordings/:recordingId/consent', authenticate, requireMeetingAccess, respondConsent);
router.post('/:meetingId/recordings/:recordingId/chunks', authenticate, requireMeetingAccess, express.raw({ type: ['video/webm', 'video/mp4', 'video/ogg'], limit: '2mb' }), uploadRecording);
router.post('/:meetingId/recordings/:recordingId/:action', authenticate, requireMeetingAccess, controlRecording);

export default router;
