import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import MeetingRecording, { RecordingStatus } from '../models/MeetingRecording.js';
import MeetingRecordingChunk from '../models/MeetingRecordingChunk.js';
import WorkspaceMember, { WorkspaceRole } from '../models/WorkspaceMember.js';
import { changeMeetingRecording, createMeetingRecording, getCurrentMeetingRecording, RecordingError, respondToRecordingConsent, uploadRecordingChunk } from '../services/meetingRecordingService.js';
import { getRecordingStorage } from '../services/recordingStorage.js';
import { createPlaybackToken, verifyPlaybackToken } from '../services/recordingPlaybackToken.js';
import { emitRecordingConsentRequest, emitRecordingStatus } from '../socket/index.js';

const startSchema = z.object({ mimeType: z.enum(['video/webm', 'video/mp4', 'video/ogg']) });
const consentSchema = z.object({ consented: z.boolean() });
const chunkHeaders = z.object({ sequence: z.coerce.number().int().min(0), startMs: z.coerce.number().finite().min(0), endMs: z.coerce.number().finite().positive() });
function handleError(res: Response, error: unknown, fallback: string) {
  if (error instanceof RecordingError) { res.status(error.status).json({ message: error.message }); return; }
  console.error(`${fallback}:`, (error as Error).message);
  res.status(500).json({ message: fallback });
}
function serialize(recording: any, meetingTitle?: string) {
  return { id: String(recording._id), meetingId: String(recording.meetingId), workspaceId: String(recording.workspaceId), hostId: String(recording.hostId), meetingTitle: meetingTitle || recording.meetingTitle || '', status: recording.status, durationMs: recording.durationMs, fileSize: recording.fileSize, format: recording.format, mimeType: recording.mimeType, createdAt: recording.createdAt, startedAt: recording.startedAt, completedAt: recording.completedAt };
}

export async function startRecording(req: Request, res: Response): Promise<void> {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: 'Unsupported recording format.' }); return; }
  try {
    const existing = await getCurrentMeetingRecording(req.meetingId!);
    if (existing) { res.status(409).json({ message: 'A recording is already active for this meeting.' }); return; }
    const recording = await createMeetingRecording(req.meetingId!, req.userId!, parsed.data.mimeType);
    const pending = recording.consent.filter((entry) => entry.decision === 'pending').map((entry) => String(entry.userId));
    emitRecordingStatus(req.meetingId!, recording);
    if (pending.length) emitRecordingConsentRequest(req.meetingId!, String(recording._id), pending);
    res.status(201).json({ recording: serialize(recording) });
  } catch (error) { handleError(res, error, 'Could not start meeting recording.'); }
}

export async function respondConsent(req: Request, res: Response): Promise<void> {
  const parsed = consentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ message: 'A consent decision is required.' }); return; }
  try {
    const recording = await respondToRecordingConsent(req.meetingId!, String(req.params.recordingId), req.userId!, parsed.data.consented);
    emitRecordingStatus(req.meetingId!, recording);
    res.status(200).json({ recording: serialize(recording) });
  } catch (error) { handleError(res, error, 'Could not save recording consent.'); }
}

export async function controlRecording(req: Request, res: Response): Promise<void> {
  const action = String(req.params.action);
  if (!['pause', 'resume', 'stop'].includes(action)) { res.status(404).json({ message: 'Recording action not found.' }); return; }
  try {
    const recording = await changeMeetingRecording(req.meetingId!, String(req.params.recordingId), req.userId!, action as 'pause' | 'resume' | 'stop');
    emitRecordingStatus(req.meetingId!, recording);
    res.status(200).json({ recording: serialize(recording) });
  } catch (error) { handleError(res, error, 'Could not update meeting recording.'); }
}

export async function uploadRecording(req: Request, res: Response): Promise<void> {
  const parsed = chunkHeaders.safeParse({ sequence: req.header('x-recording-sequence'), startMs: req.header('x-recording-start-ms'), endMs: req.header('x-recording-end-ms') });
  if (!parsed.success) { res.status(400).json({ message: 'Invalid recording chunk metadata.' }); return; }
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const result = await uploadRecordingChunk(req.meetingId!, String(req.params.recordingId), req.userId!, parsed.data.sequence, parsed.data.startMs, parsed.data.endMs, req.header('content-type') || '', bytes);
    res.status(result.duplicate ? 200 : 201).json({ duplicate: result.duplicate, uploaded: true });
  } catch (error) { handleError(res, error, 'Could not store recording chunk.'); }
}

export async function listRecordings(req: Request, res: Response): Promise<void> {
  const workspaceId = String(req.query.workspaceId || '');
  if (!mongoose.isValidObjectId(workspaceId)) { res.status(400).json({ message: 'A valid workspace ID is required.' }); return; }
  try {
    if (!(await WorkspaceMember.exists({ workspaceId, userId: req.userId }))) { res.status(403).json({ message: 'You do not have access to this workspace.' }); return; }
    const records = await MeetingRecording.find({ workspaceId }).sort({ createdAt: -1 }).limit(100).populate('meetingId', 'title').lean();
    res.status(200).json({ recordings: records.map((record: any) => serialize(record, record.meetingId?.title)) });
  } catch (error) { handleError(res, error, 'Could not load meeting recordings.'); }
}

export async function createPlaybackTicket(req: Request, res: Response): Promise<void> {
  try {
    if (!mongoose.isValidObjectId(String(req.params.recordingId))) { res.status(404).json({ message: 'Recording not found.' }); return; }
    const recording = await MeetingRecording.findById(String(req.params.recordingId));
    if (!recording || ![RecordingStatus.COMPLETED, RecordingStatus.INTERRUPTED].includes(recording.status) || !recording.storageRef) { res.status(404).json({ message: 'Recording is not available for playback.' }); return; }
    if (!(await WorkspaceMember.exists({ workspaceId: recording.workspaceId, userId: req.userId }))) { res.status(403).json({ message: 'You do not have access to this recording.' }); return; }
    const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
    const play = createPlaybackToken({ recordingId: String(recording._id), userId: req.userId!, action: 'play', expiresAt });
    const download = createPlaybackToken({ recordingId: String(recording._id), userId: req.userId!, action: 'download', expiresAt });
    res.status(200).json({ expiresAt: new Date(expiresAt).toISOString(), streamUrl: `/api/v1/recordings/${recording._id}/stream?ticket=${encodeURIComponent(play)}`, downloadUrl: `/api/v1/recordings/${recording._id}/stream?ticket=${encodeURIComponent(download)}` });
  } catch (error) { handleError(res, error, 'Could not create recording access links.'); }
}

export async function streamRecording(req: Request, res: Response): Promise<void> {
  const claims = verifyPlaybackToken(String(req.query.ticket || ''));
  if (!claims || claims.recordingId !== req.params.recordingId) { res.status(401).json({ message: 'Recording access link is invalid or expired.' }); return; }
  try {
    const recording = await MeetingRecording.findById(claims.recordingId);
    if (!recording?.storageRef || ![RecordingStatus.COMPLETED, RecordingStatus.INTERRUPTED].includes(recording.status)) { res.status(404).json({ message: 'Recording is not available.' }); return; }
    const size = await getRecordingStorage().getSize(recording.storageRef);
    const rangeHeader = req.header('range');
    let start = 0; let end = size - 1;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match || rangeHeader.includes(',')) { res.status(416).setHeader('Content-Range', `bytes */${size}`).end(); return; }
      if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) { res.status(416).setHeader('Content-Range', `bytes */${size}`).end(); return; } start = Math.max(0, size - suffix); }
      else { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
      end = Math.min(end, size - 1);
      if (start >= size || end < start) { res.status(416).setHeader('Content-Range', `bytes */${size}`).end(); return; }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    } else res.status(200);
    res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', end - start + 1);
    res.setHeader('Content-Type', recording.mimeType); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (claims.action === 'download') res.setHeader('Content-Disposition', `attachment; filename="intellmeet-recording-${recording._id}.${recording.mimeType.split('/')[1].split(';')[0]}"`);
    else res.setHeader('Content-Disposition', 'inline');
    const stream = getRecordingStorage().open(recording.storageRef, start, end);
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
    stream.pipe(res);
  } catch (error) { handleError(res, error, 'Could not stream meeting recording.'); }
}

export async function deleteRecording(req: Request, res: Response): Promise<void> {
  try {
    const recording = await MeetingRecording.findById(String(req.params.recordingId));
    if (!recording) { res.status(404).json({ message: 'Recording not found.' }); return; }
    const membership = await WorkspaceMember.findOne({ workspaceId: recording.workspaceId, userId: req.userId }).select('role').lean() as any;
    if (!membership) { res.status(403).json({ message: 'You do not have access to this recording.' }); return; }
    if (String(recording.hostId) !== req.userId && ![WorkspaceRole.OWNER, WorkspaceRole.ADMIN].includes(membership.role)) { res.status(403).json({ message: 'Only the recording host or a workspace owner/admin can delete it.' }); return; }
    await getRecordingStorage().remove(recording.storageRef, String(recording._id));
    await MeetingRecordingChunk.deleteMany({ recordingId: recording._id });
    await recording.deleteOne(); res.status(204).send();
  } catch (error) { handleError(res, error, 'Could not delete meeting recording.'); }
}

export async function getActiveRecordingForMeeting(meetingId: string) { return getCurrentMeetingRecording(meetingId); }

