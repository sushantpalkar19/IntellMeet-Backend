const mockMeetingFind = jest.fn();
const mockParticipantExists = jest.fn();
const mockTranscriptFind = jest.fn();
const mockTranscriptFindOneAndUpdate = jest.fn();
const mockChunkFindOneAndUpdate = jest.fn();
const mockChunkCreate = jest.fn();
const mockChunkFind = jest.fn();
const mockChunkUpdateOne = jest.fn();
const mockUserFind = jest.fn();
const mockTranscribe = jest.fn();
const mockGetState = jest.fn();

jest.mock('../models/Meeting.js', () => ({ __esModule: true, default: { findById: mockMeetingFind } }));
jest.mock('../models/MeetingParticipant.js', () => ({ __esModule: true, default: { exists: mockParticipantExists } }));
jest.mock('../models/MeetingTranscript.js', () => ({ __esModule: true, default: { findOne: mockTranscriptFind, findOneAndUpdate: mockTranscriptFindOneAndUpdate, find: jest.fn(), countDocuments: jest.fn() } }));
jest.mock('../models/MeetingTranscriptChunk.js', () => ({ __esModule: true, default: { findOne: mockChunkFind, findOneAndUpdate: mockChunkFindOneAndUpdate, create: mockChunkCreate, updateOne: mockChunkUpdateOne } }));
jest.mock('../models/User.js', () => ({ __esModule: true, default: { findById: mockUserFind } }));
jest.mock('../services/transcription.js', () => ({ transcribeAudio: mockTranscribe }));
jest.mock('../services/transcriptionState.js', () => ({ getTranscriptionState: mockGetState }));

import { uploadTranscriptChunk } from '../controllers/transcriptController.js';

function requestHarness() {
  const req: any = {
    userId: 'authenticated-speaker', meetingId: 'meeting-1',
    headers: {
      'x-transcript-session': 'participant-session-123456',
      'x-transcription-session': 'host-session-123456',
      'x-transcript-sequence': '4', 'x-transcript-chunk-id': 'participant-session-123456-4', 'x-transcript-start-ms': '0', 'x-transcript-end-ms': '15000', 'content-type': 'audio/webm',
    },
    header(name: string) { return this.headers[name.toLowerCase()]; },
    body: Buffer.from('transient fake media bytes'),
  };
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return { req, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMeetingFind.mockReturnValue({ select: jest.fn().mockResolvedValue({ status: 'live' }) });
  mockParticipantExists.mockResolvedValue(true);
  mockGetState.mockReturnValue({ status: 'running', sessionId: 'host-session-123456', startedAt: new Date().toISOString() });
  mockTranscriptFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
  mockChunkFindOneAndUpdate.mockResolvedValue(null);
  mockChunkFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
  mockChunkCreate.mockResolvedValue({});
  mockChunkUpdateOne.mockResolvedValue({});
  mockTranscribe.mockResolvedValue({ text: 'Agenda approved.', segments: [{ text: 'Agenda approved.', start: 0, end: 2 }] });
  mockUserFind.mockReturnValue({ select: jest.fn().mockResolvedValue({ firstName: 'Ari', lastName: 'Example' }) });
  mockTranscriptFindOneAndUpdate.mockResolvedValue({ _id: 'segment-1', meetingId: 'meeting-1', speakerId: 'authenticated-speaker', speakerName: 'Ari Example', text: 'Agenda approved.', startAt: new Date(), endAt: new Date(), createdAt: new Date(), toObject() { return this; } });
});

describe('meeting transcript chunk behavior', () => {
  it('transcribes and persists with speaker identity from the authenticated request', async () => {
    const { req, res } = requestHarness();
    await uploadTranscriptChunk(req, res);
    expect(mockTranscribe).toHaveBeenCalledWith(req.body, 'audio/webm');
    expect(mockTranscriptFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ speakerId: 'authenticated-speaker', sessionId: 'participant-session-123456', sequence: 4, chunkId: 'participant-session-123456-4', segmentIndex: 0 }),
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ speakerName: 'Ari Example', text: 'Agenda approved.' }) }),
      expect.objectContaining({ upsert: true }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].segment.speakerId).toBe('authenticated-speaker');
  });

  it('returns the stored segment without calling transcription again for a duplicate chunk', async () => {
    const existing = { _id: 'segment-existing', speakerId: 'authenticated-speaker', text: 'Already saved' };
    mockTranscriptFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(existing) });
    const { req, res } = requestHarness();
    await uploadTranscriptChunk(req, res);
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].duplicate).toBe(true);
  });

  it('rejects users who are not active meeting participants', async () => {
    mockParticipantExists.mockResolvedValue(false);
    const { req, res } = requestHarness();
    await uploadTranscriptChunk(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('rejects audio chunks above the bounded in-memory upload size', async () => {
    const { req, res } = requestHarness();
    req.body = Buffer.alloc(2 * 1024 * 1024 + 1);
    await uploadTranscriptChunk(req, res);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('rejects a chunk ID that does not match the participant session and sequence', async () => {
    const { req, res } = requestHarness();
    req.headers['x-transcript-chunk-id'] = 'forged-duplicate-id-123456';
    await uploadTranscriptChunk(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('marks temporary transcription failures retryable and persists a later successful retry once', async () => {
    mockTranscribe.mockRejectedValueOnce(new Error('temporary service failure')).mockResolvedValueOnce({ text: 'Recovered speech.', segments: [{ text: 'Recovered speech.', start: 0, end: 1.5 }] });
    const first = requestHarness();
    await uploadTranscriptChunk(first.req, first.res);
    expect(first.res.status).toHaveBeenCalledWith(502);
    expect(mockChunkUpdateOne).toHaveBeenCalledWith(expect.objectContaining({ chunkId: 'participant-session-123456-4' }), { $set: expect.objectContaining({ state: 'failed' }) });

    mockTranscriptFindOneAndUpdate.mockResolvedValueOnce({ _id: 'segment-retry', speakerId: 'authenticated-speaker', speakerName: 'Ari Example', text: 'Recovered speech.', chunkId: 'participant-session-123456-4', startAt: new Date(), endAt: new Date(), createdAt: new Date(), toObject() { return this; } });
    const second = requestHarness();
    await uploadTranscriptChunk(second.req, second.res);
    expect(mockTranscriptFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(second.res.status).toHaveBeenCalledWith(201);
  });

  it('permits only an already-claimed failed chunk to retry after host stop', async () => {
    mockGetState.mockReturnValue({ status: 'stopped', sessionId: 'host-session-123456', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    mockChunkFind.mockReturnValue({ lean: jest.fn().mockResolvedValue({ state: 'failed', sessionId: 'participant-session-123456', sequence: 4 }) });
    mockChunkFindOneAndUpdate.mockResolvedValue({ state: 'processing' });
    const { req, res } = requestHarness();
    await uploadTranscriptChunk(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
  });

  it('accepts the final in-flight media chunk during the bounded stop flush window', async () => {
    mockGetState.mockReturnValue({ status: 'stopped', sessionId: 'host-session-123456', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const { req, res } = requestHarness();
    await uploadTranscriptChunk(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
  });
});
