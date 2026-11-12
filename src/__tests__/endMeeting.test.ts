const mockFindMeeting = jest.fn();
const mockTransitionMeeting = jest.fn();
const mockUpdateParticipants = jest.fn();
const mockEmitEnded = jest.fn();
const mockEmitRecordingStatus = jest.fn();
const mockInterruptRecording = jest.fn();

jest.mock('../models/Meeting.js', () => ({
  __esModule: true,
  default: { findById: mockFindMeeting, findOneAndUpdate: mockTransitionMeeting },
  MeetingStatus: { SCHEDULED: 'scheduled', LIVE: 'live', ENDED: 'ended', CANCELLED: 'cancelled' },
}));
jest.mock('../models/MeetingParticipant.js', () => ({ __esModule: true, default: { updateMany: mockUpdateParticipants } }));
jest.mock('../models/MeetingMessage.js', () => ({ __esModule: true, default: {} }));
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, default: {} }));
jest.mock('../socket/index.js', () => ({ emitMeetingEnded: mockEmitEnded, emitRecordingStatus: mockEmitRecordingStatus }));
jest.mock('../services/meetingRecordingService.js', () => ({ interruptHostRecording: mockInterruptRecording }));

import { endMeeting, joinMeeting } from '../controllers/meetingController.js';

function responseHarness() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  const liveMeeting = { _id: 'meeting-1', status: 'live', endedAt: undefined };
  mockFindMeeting.mockResolvedValue(liveMeeting);
  mockTransitionMeeting.mockImplementation(async (_query: unknown, update: { $set: { endedAt: Date } }) => ({
    ...liveMeeting, status: 'ended', endedAt: update.$set.endedAt,
  }));
  mockUpdateParticipants.mockResolvedValue({ modifiedCount: 2 });
  mockInterruptRecording.mockResolvedValue(null);
});

describe('endMeeting controller', () => {
  it('ends a live meeting, leaves all active participants, and broadcasts cleanup', async () => {
    const res = responseHarness();
    await endMeeting({ meetingId: 'meeting-1' } as never, res);

    expect(mockTransitionMeeting).toHaveBeenCalledWith(
      { _id: 'meeting-1', status: { $in: ['scheduled', 'live'] } },
      { $set: expect.objectContaining({ status: 'ended', endedAt: expect.any(Date) }) },
      { new: true },
    );
    expect(mockUpdateParticipants).toHaveBeenCalledWith({ meetingId: 'meeting-1', leftAt: null }, { leftAt: expect.any(Date) });
    expect(mockEmitEnded).toHaveBeenCalledWith('meeting-1', expect.any(Date));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].meeting.status).toBe('ended');
  });

  it('treats repeated end requests as successful and safely reapplies cleanup', async () => {
    mockFindMeeting.mockResolvedValue({ _id: 'meeting-1', status: 'ended', endedAt: new Date('2026-01-01T00:00:00Z') });
    const res = responseHarness();
    await endMeeting({ meetingId: 'meeting-1' } as never, res);

    expect(mockTransitionMeeting).not.toHaveBeenCalled();
    expect(mockUpdateParticipants).toHaveBeenCalledTimes(1);
    expect(mockEmitEnded).toHaveBeenCalledWith('meeting-1', expect.any(Date));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not change a cancelled meeting', async () => {
    mockFindMeeting.mockResolvedValue({ _id: 'meeting-1', status: 'cancelled' });
    const res = responseHarness();
    await endMeeting({ meetingId: 'meeting-1' } as never, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTransitionMeeting).not.toHaveBeenCalled();
    expect(mockEmitEnded).not.toHaveBeenCalled();
  });

  it('rejects joining after the meeting has ended', async () => {
    mockFindMeeting.mockResolvedValue({ _id: 'meeting-1', status: 'ended' });
    const res = responseHarness();
    await joinMeeting({ userId: 'member-1', meetingId: 'meeting-1' } as never, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTransitionMeeting).not.toHaveBeenCalled();
  });
});
