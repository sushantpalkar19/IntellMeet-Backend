import { Request, Response } from 'express';
import Meeting from '../models/Meeting.js';
import MeetingParticipant from '../models/MeetingParticipant.js';
import MeetingTranscript from '../models/MeetingTranscript.js';
import MeetingTranscriptChunk from '../models/MeetingTranscriptChunk.js';
import User from '../models/User.js';
import { transcribeAudio } from '../services/transcription.js';
import { getTranscriptionState } from '../services/transcriptionState.js';

const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const sessionIdPattern = /^[A-Za-z0-9_-]{16,80}$/;

export async function uploadTranscriptChunk(req: Request, res: Response): Promise<void> {
  const userId = req.userId;
  const meetingId = req.meetingId;
  const sessionId = String(req.header('x-transcript-session') || '');
  const transcriptionSessionId = String(req.header('x-transcription-session') || '');
  const sequence = Number(req.header('x-transcript-sequence'));
  const chunkId = String(req.header('x-transcript-chunk-id') || '');
  const startMs = Number(req.header('x-transcript-start-ms'));
  const endMs = Number(req.header('x-transcript-end-ms'));
  const mimeType = String(req.header('content-type') || '').split(';')[0].toLowerCase();
  const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  if (!userId || !meetingId) { res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' }); return; }
  if (!sessionIdPattern.test(sessionId) || !sessionIdPattern.test(transcriptionSessionId) || !sessionIdPattern.test(chunkId) || chunkId !== `${sessionId}-${sequence}` || !Number.isSafeInteger(sequence) || sequence < 0 || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
    res.status(400).json({ error: 'Bad Request', message: 'Invalid transcript chunk metadata' }); return;
  }
  if (!['audio/webm', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/mpeg', 'audio/flac'].includes(mimeType) || !audio.length || audio.length > MAX_AUDIO_BYTES) {
    res.status(413).json({ error: 'Audio Chunk Rejected', message: 'Audio must be a supported type and no larger than 2 MB' }); return;
  }
  try {
    const meeting = await Meeting.findById(meetingId).select('status');
    if (!meeting || meeting.status === 'ended' || meeting.status === 'cancelled') { res.status(404).json({ error: 'Not Found', message: 'Meeting unavailable' }); return; }
    const participant = await MeetingParticipant.exists({ meetingId, userId, leftAt: null });
    if (!participant) { res.status(403).json({ error: 'Forbidden', message: 'Join the meeting before uploading audio' }); return; }
    const chunkIdentity = { meetingId, speakerId: userId, chunkId };
    const transcriptIdentity = { ...chunkIdentity, sessionId, sequence };
    const existing = await MeetingTranscript.findOne(chunkIdentity).lean();
    if (existing) { res.status(200).json({ duplicate: true, segment: serializeSegment(existing) }); return; }
    const existingChunk = await MeetingTranscriptChunk.findOne(chunkIdentity).lean();
    if (existingChunk?.state === 'complete') { res.status(200).json({ duplicate: true, segment: null }); return; }
    const state = getTranscriptionState(meetingId);
    const activeTranscription = (state.status === 'running' || state.status === 'paused') && state.sessionId === transcriptionSessionId;
    // Stop status arrives before MediaRecorder's final dataavailable/stop events.
    // Permit a brief flush window for the current session's already captured tail.
    const stoppedFlushWindow = state.status === 'stopped'
      && state.sessionId === transcriptionSessionId
      && Date.now() - Date.parse(state.updatedAt) <= 30000;
    // A persisted in-progress/failed ledger row proves that this exact chunk was
    // accepted during a host-authorized session, so retries can survive stop/resume.
    const retryOfAcceptedChunk = Boolean(existingChunk
      && (existingChunk.state === 'failed' || existingChunk.state === 'processing')
      && existingChunk.sessionId === sessionId
      && existingChunk.sequence === sequence);
    if (!activeTranscription && !stoppedFlushWindow && !retryOfAcceptedChunk) {
      res.status(409).json({ error: 'Transcription Inactive', message: 'Transcription is not running for this session' }); return;
    }
    const now = new Date();
    const claimed = await MeetingTranscriptChunk.findOneAndUpdate(
      { ...chunkIdentity, $or: [{ state: 'failed' }, { state: 'processing', updatedAt: { $lt: new Date(Date.now() - 120000) } }] },
      { $set: { state: 'processing', updatedAt: now } }, { new: true },
    );
    let chunk = claimed;
    if (!chunk) {
      try { chunk = await MeetingTranscriptChunk.create({ ...transcriptIdentity, state: 'processing', updatedAt: now }); }
      catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        const prior = await MeetingTranscript.findOne(chunkIdentity).lean();
        if (prior) { res.status(200).json({ duplicate: true, segment: serializeSegment(prior) }); return; }
        const priorChunk = await MeetingTranscriptChunk.findOne(chunkIdentity).lean();
        if (priorChunk?.state === 'complete') { res.status(200).json({ duplicate: true, segment: null }); return; }
        res.status(202).json({ processing: true }); return;
      }
    }

    try {
      const result = await transcribeAudio(audio, mimeType);
      const user = await User.findById(userId).select('firstName lastName');
      if (!user) throw new Error('Authenticated user not found');
      const segmentBaseTime = Date.parse(state.startedAt || now.toISOString()) + startMs;
      const transcriptSegments = result.segments.length
        ? result.segments
        : result.text ? [{ text: result.text, start: 0, end: Math.max(0.01, (endMs - startMs) / 1000) }] : [];
      const savedSegments = [];
      const chunkDurationMs = endMs - startMs;
      for (const [segmentIndex, transcriptSegment] of transcriptSegments.entries()) {
        const segmentStartOffset = Math.min(chunkDurationMs, Math.max(0, transcriptSegment.start * 1000));
        const segmentEndOffset = Math.min(chunkDurationMs, Math.max(segmentStartOffset, transcriptSegment.end * 1000));
        if (segmentEndOffset <= segmentStartOffset) continue;
        const segmentIdentity = { ...transcriptIdentity, segmentIndex };
        const segment = await MeetingTranscript.findOneAndUpdate(segmentIdentity, { $setOnInsert: {
          ...transcriptIdentity,
          segmentIndex,
          speakerName: `${user.firstName} ${user.lastName}`.trim(),
          text: transcriptSegment.text,
          startAt: new Date(segmentBaseTime + segmentStartOffset),
          endAt: new Date(segmentBaseTime + segmentEndOffset),
          createdAt: now,
        } }, { upsert: true, new: true, setDefaultsOnInsert: true });
        savedSegments.push(serializeSegment(segment.toObject()));
      }
      await MeetingTranscriptChunk.updateOne(chunkIdentity, { $set: { state: 'complete', updatedAt: new Date() } });
      res.status(201).json({ duplicate: false, segments: savedSegments, segment: savedSegments[0] ?? null });
    } catch (error) {
      await MeetingTranscriptChunk.updateOne(chunkIdentity, { $set: { state: 'failed', updatedAt: new Date() } }).catch(() => undefined);
      const status = (error as { status?: number }).status;
      const errorHeaders = (error as { headers?: Headers | Record<string, string> }).headers;
      const retryAfter = errorHeaders && typeof (errorHeaders as Headers).get === 'function'
        ? (errorHeaders as Headers).get('retry-after')
        : (errorHeaders as Record<string, string> | undefined)?.['retry-after'];
      res.status(status === 429 ? 429 : 502).json({
        error: status === 429 ? 'Transcription Rate Limited' : 'Transcription Failed',
        message: status === 429 ? 'Groq transcription quota is temporarily exhausted; audio is queued for retry' : 'Audio could not be transcribed; retry this chunk',
        ...(retryAfter && Number.isFinite(Number(retryAfter)) ? { retryAfterSeconds: Number(retryAfter) } : {}),
      });
    }
  } catch (error) {
    console.error('Transcript chunk processing error:', (error as Error).message);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to process transcript chunk' });
  }
}

export async function getTranscript(req: Request, res: Response): Promise<void> {
  try {
    const meetingId = req.meetingId;
    if (!meetingId) { res.status(400).json({ error: 'Bad Request', message: 'Meeting ID is required' }); return; }
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '50'), 10) || 50));
    const [segments, total] = await Promise.all([
      MeetingTranscript.find({ meetingId }).sort({ startAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      MeetingTranscript.countDocuments({ meetingId }),
    ]);
    res.status(200).json({ segments: segments.map(serializeSegment), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, attribution: 'Speaker names identify the authenticated participant who uploaded each microphone chunk; they are not voice diarization.' });
  } catch (error) {
    console.error('Transcript retrieval error:', (error as Error).message);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to load transcript' });
  }
}

export async function exportTranscriptText(req: Request, res: Response): Promise<void> {
  try {
    const meetingId = req.meetingId;
    if (!meetingId) { res.status(400).json({ error: 'Bad Request', message: 'Meeting ID is required' }); return; }
    const segments = await MeetingTranscript.find({ meetingId }).sort({ startAt: 1, _id: 1 }).lean();
    const body = segments.map((segment) => `[${new Date(segment.startAt).toLocaleString('en-US')}–${new Date(segment.endAt).toLocaleTimeString('en-US')}] ${segment.speakerName}: ${segment.text}`).join('\n');
    res.type('text/plain').attachment(`intellmeet-transcript-${meetingId}.txt`).send(body);
  } catch (error) {
    console.error('Transcript export error:', (error as Error).message);
    res.status(500).json({ error: 'Internal Server Error', message: 'Failed to export transcript' });
  }
}

function serializeSegment(segment: any) {
  return { id: segment._id, meetingId: segment.meetingId, speakerId: segment.speakerId, speakerName: segment.speakerName, text: segment.text, startAt: segment.startAt, endAt: segment.endAt, chunkId: segment.chunkId, createdAt: segment.createdAt };
}

