const mockEmit = jest.fn();
const mockSocketsLeave = jest.fn();
const mockFetchSockets = jest.fn();
const mockUpdateParticipant = jest.fn();
const mockFindUser = jest.fn();
const mockFindMeeting = jest.fn();
const mockInterruptRecording = jest.fn();
const mockResumeRecording = jest.fn();
const mockIo = {
  use: jest.fn(),
  on: jest.fn(),
  to: jest.fn(() => ({ emit: mockEmit })),
  in: jest.fn(() => ({ socketsLeave: mockSocketsLeave, fetchSockets: mockFetchSockets })),
};

jest.mock('socket.io', () => ({ Server: class { constructor() { return mockIo; } } }));
jest.mock('../models/Meeting.js', () => ({
  __esModule: true,
  default: { findById: mockFindMeeting },
  MeetingStatus: { SCHEDULED: 'scheduled', LIVE: 'live', ENDED: 'ended', CANCELLED: 'cancelled' },
}));
jest.mock('../models/MeetingParticipant.js', () => ({ __esModule: true, default: { updateOne: mockUpdateParticipant, updateMany: jest.fn() } }));
jest.mock('../models/MeetingMessage.js', () => ({ __esModule: true, default: {} }));
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, default: {} }));
jest.mock('../models/User.js', () => ({ __esModule: true, default: { findById: mockFindUser } }));
jest.mock('../services/meetingRecordingService.js', () => ({
  getCurrentMeetingRecording: jest.fn(),
  interruptHostRecording: mockInterruptRecording,
  pauseRecordingForLateParticipant: jest.fn(),
  resumeRecordingIfConsentResolved: mockResumeRecording,
}));

import { emitMeetingEnded, initializeSocketIO, screenSharingMap } from '../socket/index.js';

describe('meeting-ended socket broadcast', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    screenSharingMap.clear();
    mockFetchSockets.mockResolvedValue([]);
    mockUpdateParticipant.mockResolvedValue({ modifiedCount: 1 });
    mockFindUser.mockResolvedValue({ firstName: 'Member', lastName: 'One', email: 'member@example.test' });
    mockFindMeeting.mockReturnValue({ select: jest.fn().mockResolvedValue({ createdBy: 'host-1' }) });
    mockInterruptRecording.mockResolvedValue(null);
    mockResumeRecording.mockResolvedValue(null);
    initializeSocketIO({} as never);
  });

  it('notifies the room, stops screen share, evicts sockets, and clears room state', () => {
    screenSharingMap.set('meeting-1', 'host-1');
    emitMeetingEnded('meeting-1', new Date('2026-11-11T00:00:00Z'));

    expect(mockEmit).toHaveBeenNthCalledWith(1, 'screenshare:stopped', { meetingId: 'meeting-1', userId: 'host-1' });
    expect(mockEmit).toHaveBeenNthCalledWith(2, 'meeting:ended', { meetingId: 'meeting-1', endedAt: expect.any(Date) });
    expect(mockSocketsLeave).toHaveBeenCalledWith('meeting-1');
    expect(screenSharingMap.has('meeting-1')).toBe(false);
  });

  it('handles participant leave without changing the meeting status', async () => {
    const handlers: Record<string, (...args: any[]) => Promise<void> | void> = {};
    const rooms = new Set(['socket-1', 'meeting-1']);
    const socket = {
      id: 'socket-1', userId: 'member-1', data: { userId: 'member-1' }, rooms,
      on: jest.fn((event: string, handler: (...args: any[]) => Promise<void> | void) => { handlers[event] = handler; }),
      emit: jest.fn(), leave: jest.fn((room: string) => { rooms.delete(room); }),
    };
    const connection = mockIo.on.mock.calls.find(([event]) => event === 'connection')?.[1] as (socket: any) => void;
    connection(socket);
    await handlers['meeting:leave']?.({ meetingId: 'meeting-1' });

    expect(socket.leave).toHaveBeenCalledWith('meeting-1');
    expect(socket.emit).toHaveBeenCalledWith('meeting:left', { meetingId: 'meeting-1' });
    expect(mockEmit).toHaveBeenCalledWith('participant:left', expect.objectContaining({ meetingId: 'meeting-1', userId: 'member-1' }));
    expect(mockUpdateParticipant).toHaveBeenCalledWith({ meetingId: 'meeting-1', userId: 'member-1', leftAt: null }, { leftAt: expect.any(Date) });
    expect(mockEmit).not.toHaveBeenCalledWith('meeting:ended', expect.anything());
  });

  it('keeps presence when another tab for that participant remains in the meeting', async () => {
    mockFetchSockets.mockResolvedValue([{ id: 'socket-2', data: { userId: 'member-1' } }]);
    const handlers: Record<string, (...args: any[]) => Promise<void> | void> = {};
    const socket = {
      id: 'socket-1', userId: 'member-1', data: { userId: 'member-1' }, rooms: new Set(['socket-1', 'meeting-1']),
      on: jest.fn((event: string, handler: (...args: any[]) => Promise<void> | void) => { handlers[event] = handler; }),
      emit: jest.fn(), leave: jest.fn(),
    };
    const connection = mockIo.on.mock.calls.find(([event]) => event === 'connection')?.[1] as (socket: any) => void;
    connection(socket);
    await handlers['meeting:leave']?.({ meetingId: 'meeting-1' });

    expect(mockUpdateParticipant).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalledWith('participant:left', expect.anything());
    expect(mockEmit).not.toHaveBeenCalledWith('meeting:ended', expect.anything());
  });
});
