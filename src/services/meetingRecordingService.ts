import { createHash } from 'crypto';
import mongoose from 'mongoose';
import Meeting, { MeetingStatus } from '../models/Meeting.js';
import MeetingParticipant from '../models/MeetingParticipant.js';
import MeetingRecording, { IMeetingRecording, RecordingStatus } from '../models/MeetingRecording.js';
import MeetingRecordingChunk from '../models/MeetingRecordingChunk.js';
import { getRecordingStorage } from './recordingStorage.js';

export class RecordingError extends Error { constructor(public status: number, message: string) { super(message); } }
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['video/webm', 'video/mp4', 'video/ogg']);
const activeStatuses = [RecordingStatus.AWAITING_CONSENT, RecordingStatus.RECORDING, RecordingStatus.PAUSED, RecordingStatus.PROCESSING];

export async function createMeetingRecording(meetingId: string, hostId: string, mimeType: string): Promise<IMeetingRecording> {
  if (!ALLOWED_MIME_TYPES.has(mimeType.split(';')[0].toLowerCase())) throw new RecordingError(400, 'This browser recording format is not supported.');
  const meeting = await Meeting.findById(meetingId);
  if (!meeting) throw new RecordingError(404, 'Meeting not found.');
  if (String(meeting.createdBy) !== hostId) throw new RecordingError(403, 'Only the meeting host can start a recording.');
  if (meeting.status !== MeetingStatus.LIVE) throw new RecordingError(409, 'Recording can start only while the meeting is live.');
  const active = await MeetingParticipant.find({ meetingId, leftAt: null }).select('userId').lean();
  if (!active.some((item: any) => String(item.userId) === hostId)) throw new RecordingError(403, 'Join the meeting before starting a recording.');
  const consent = active.map((item: any) => ({ userId: item.userId as mongoose.Types.ObjectId, decision: (String(item.userId) === hostId ? 'consented' : 'pending') as 'consented' | 'pending', ...(String(item.userId) === hostId ? { decidedAt: new Date() } : {}) }));
  const awaiting = consent.some((item) => item.decision === 'pending');
  try { return await MeetingRecording.create({ meetingId, workspaceId: meeting.workspaceId, hostId, activeSlot: meetingId, status: awaiting ? RecordingStatus.AWAITING_CONSENT : RecordingStatus.RECORDING, mimeType, format: mimeType, consent, startedAt: awaiting ? undefined : new Date() }); }
  catch (error) { if ((error as { code?: number }).code === 11000) throw new RecordingError(409, 'A recording is already active for this meeting.'); throw error; }
}

export async function respondToRecordingConsent(meetingId: string, recordingId: string, userId: string, consented: boolean): Promise<IMeetingRecording> {
  const recording = await MeetingRecording.findOne({ _id: recordingId, meetingId });
  if (!recording) throw new RecordingError(404, 'Recording request not found.');
  if (![RecordingStatus.AWAITING_CONSENT, RecordingStatus.PAUSED].includes(recording.status)) throw new RecordingError(409, 'This recording is not waiting for consent.');
  if (!(await MeetingParticipant.exists({ meetingId, userId, leftAt: null }))) throw new RecordingError(403, 'Join the meeting before responding to recording consent.');
  const entry = recording.consent.find((item) => String(item.userId) === userId);
  if (!entry || entry.decision !== 'pending') throw new RecordingError(409, 'No pending recording consent request exists for you.');
  entry.decision = consented ? 'consented' : 'declined'; entry.decidedAt = new Date();
  if (!consented) recording.status = recording.startedAt ? RecordingStatus.PROCESSING : RecordingStatus.CONSENT_DENIED;
  else if (await allActiveParticipantsConsented(recording)) { recording.status = RecordingStatus.RECORDING; recording.startedAt ??= new Date(); }
  await recording.save();
  if (!consented && recording.status === RecordingStatus.CONSENT_DENIED) await MeetingRecording.updateOne({ _id: recording._id }, { $unset: { activeSlot: 1 } });
  return recording;
}

export async function changeMeetingRecording(meetingId: string, recordingId: string, hostId: string, action: 'pause' | 'resume' | 'stop'): Promise<IMeetingRecording> {
  const recording = await MeetingRecording.findOne({ _id: recordingId, meetingId });
  if (!recording) throw new RecordingError(404, 'Recording not found.');
  if (String(recording.hostId) !== hostId) throw new RecordingError(403, 'Only the recording host can control this recording.');
  if (action === 'pause') {
    if (recording.status !== RecordingStatus.RECORDING) throw new RecordingError(409, 'Only an active recording can be paused.');
    recording.status = RecordingStatus.PAUSED; await recording.save(); return recording;
  }
  if (action === 'resume') {
    if (recording.status !== RecordingStatus.PAUSED || !(await allActiveParticipantsConsented(recording))) throw new RecordingError(409, 'Recording cannot resume until all active participants have consented.');
    recording.status = RecordingStatus.RECORDING; await recording.save(); return recording;
  }
  if (![RecordingStatus.RECORDING, RecordingStatus.PAUSED, RecordingStatus.AWAITING_CONSENT, RecordingStatus.PROCESSING].includes(recording.status)) throw new RecordingError(409, 'This recording cannot be stopped in its current state.');
  recording.status = RecordingStatus.PROCESSING; await recording.save();
  return finishRecording(recording, RecordingStatus.COMPLETED);
}

export async function uploadRecordingChunk(meetingId: string, recordingId: string, userId: string, sequence: number, startMs: number, endMs: number, mimeType: string, bytes: Buffer): Promise<{ duplicate: boolean; recording: IMeetingRecording }> {
  const recording = await MeetingRecording.findOne({ _id: recordingId, meetingId });
  if (!recording) throw new RecordingError(404, 'Recording not found.');
  if (String(recording.hostId) !== userId || !(await MeetingParticipant.exists({ meetingId, userId, leftAt: null }))) throw new RecordingError(403, 'Only the active recording host may upload recording chunks.');
  if (![RecordingStatus.RECORDING, RecordingStatus.PAUSED, RecordingStatus.PROCESSING].includes(recording.status)) throw new RecordingError(409, 'This recording is not accepting chunks.');
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > 86_400_000) throw new RecordingError(400, 'Invalid recording chunk metadata.');
  if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || mimeType.split(';')[0].toLowerCase() !== recording.mimeType.split(';')[0].toLowerCase()) throw new RecordingError(413, 'Recording chunks must match the recording format and be no larger than 2 MB.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = await MeetingRecordingChunk.findOne({ recordingId, sequence }).lean();
  if (existing) {
    if (existing.sha256 !== sha256) throw new RecordingError(409, 'A different chunk already uses this sequence number.');
    return { duplicate: true, recording };
  }
  try {
    await getRecordingStorage().writeChunk(recordingId, sequence, bytes);
    await MeetingRecordingChunk.create({ recordingId, sequence, byteLength: bytes.length, sha256 });
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 11000 || code === 'EEXIST') {
      const raced = await MeetingRecordingChunk.findOne({ recordingId, sequence }).lean();
      if (raced?.sha256 === sha256) return { duplicate: true, recording };
      if (code === 11000 && !raced) await getRecordingStorage().removeChunk(recordingId, sequence).catch(() => undefined);
      throw new RecordingError(409, 'A different chunk already uses this sequence number.');
    } else await getRecordingStorage().removeChunk(recordingId, sequence).catch(() => undefined);
    throw error;
  }
  const updated = await MeetingRecording.findOneAndUpdate({ _id: recordingId, fileSize: { $lte: 2 * 1024 * 1024 * 1024 - bytes.length } }, { $inc: { fileSize: bytes.length }, $max: { durationMs: endMs } }, { new: true });
  if (!updated) { await MeetingRecordingChunk.deleteOne({ recordingId, sequence }); await getRecordingStorage().removeChunk(recordingId, sequence); throw new RecordingError(413, 'The recording reached the 2 GB storage limit.'); }
  return { duplicate: false, recording };
}

export async function interruptHostRecording(meetingId: string, hostId: string): Promise<IMeetingRecording | null> {
  const recording = await MeetingRecording.findOne({ meetingId, hostId, status: { $in: activeStatuses } }).sort({ createdAt: -1 });
  if (!recording) return null;
  recording.status = RecordingStatus.INTERRUPTED;
  return finishRecording(recording, RecordingStatus.INTERRUPTED);
}

export async function pauseRecordingForLateParticipant(meetingId: string, userId: string): Promise<IMeetingRecording | null> {
  const recording = await MeetingRecording.findOne({ meetingId, status: RecordingStatus.RECORDING }).sort({ createdAt: -1 });
  if (!recording) return null;
  let entry = recording.consent.find((item) => String(item.userId) === userId);
  if (entry) { entry.decision = 'pending'; entry.decidedAt = undefined; }
  else { recording.consent.push({ userId: new mongoose.Types.ObjectId(userId), decision: 'pending' }); }
  recording.status = RecordingStatus.PAUSED;
  await recording.save();
  return recording;
}

export async function resumeRecordingIfConsentResolved(meetingId: string): Promise<IMeetingRecording | null> {
  const recording = await MeetingRecording.findOne({ meetingId, status: RecordingStatus.PAUSED }).sort({ createdAt: -1 });
  if (!recording || !(await allActiveParticipantsConsented(recording))) return null;
  recording.status = RecordingStatus.RECORDING; await recording.save(); return recording;
}

export async function getCurrentMeetingRecording(meetingId: string) {
  return MeetingRecording.findOne({ meetingId, activeSlot: meetingId, status: { $in: activeStatuses } }).sort({ createdAt: -1 });
}

async function allActiveParticipantsConsented(recording: IMeetingRecording): Promise<boolean> {
  const active = await MeetingParticipant.find({ meetingId: recording.meetingId, leftAt: null }).select('userId').lean();
  return active.length > 0 && active.every((participant: any) => recording.consent.some((entry) => String(entry.userId) === String(participant.userId) && entry.decision === 'consented'));
}

async function finishRecording(recording: IMeetingRecording, finalStatus: RecordingStatus.COMPLETED | RecordingStatus.INTERRUPTED): Promise<IMeetingRecording> {
  try {
    const chunks = await MeetingRecordingChunk.find({ recordingId: recording._id }).sort({ sequence: 1 }).select('sequence').lean();
    const sequences = chunks.map((chunk: any) => chunk.sequence as number);
    if (!sequences.length || sequences.some((sequence, index) => sequence !== index)) throw new Error('Recording upload is incomplete');
    const assembled = await getRecordingStorage().assemble(String(recording._id), recording.mimeType, sequences);
    recording.storageRef = assembled.storageRef; recording.fileSize = assembled.fileSize; recording.format = assembled.format;
    recording.completedAt = new Date(); recording.status = finalStatus;
    await getRecordingStorage().remove(undefined, String(recording._id));
  } catch (error) {
    recording.status = finalStatus === RecordingStatus.INTERRUPTED ? RecordingStatus.INTERRUPTED : RecordingStatus.FAILED;
    if (finalStatus === RecordingStatus.COMPLETED) console.error('Recording finalization failed:', (error as Error).message);
  }
  await recording.save();
  await MeetingRecording.updateOne({ _id: recording._id }, { $unset: { activeSlot: 1 } });
  return recording;
}
