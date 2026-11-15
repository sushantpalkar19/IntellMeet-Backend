const mockWorkspaceFindOne = jest.fn();
const mockWorkspaceFind = jest.fn();
const mockMeetingCreate = jest.fn();
const mockMeetingFindById = jest.fn();
const mockInviteUpsert = jest.fn();
const mockInviteFind = jest.fn();
const mockNotificationUpsert = jest.fn();
const mockNotificationDeleteMany = jest.fn();
const mockEmit = jest.fn();
const mockGenerateMeetingIdentity = jest.fn();
jest.mock('../models/Meeting.js', () => ({ __esModule: true, MeetingStatus: { SCHEDULED: 'scheduled', LIVE: 'live', ENDED: 'ended', CANCELLED: 'cancelled' }, default: { create: mockMeetingCreate, findById: mockMeetingFindById } }));
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, WorkspaceRole: { OWNER: 'owner', ADMIN: 'admin', MEMBER: 'member', VIEWER: 'viewer' }, default: { findOne: mockWorkspaceFindOne, find: mockWorkspaceFind } }));
jest.mock('../models/MeetingInvite.js', () => ({ __esModule: true, default: { findOneAndUpdate: mockInviteUpsert, find: mockInviteFind } }));
jest.mock('../models/Notification.js', () => ({ __esModule: true, default: { findOneAndUpdate: mockNotificationUpsert, deleteMany: mockNotificationDeleteMany } }));
jest.mock('../models/ReminderPreference.js', () => ({ __esModule: true, default: {} }));
jest.mock('../socket/index.js', () => ({ emitUserNotification: mockEmit }));
jest.mock('../services/meetingIdentity.js', () => ({ generateMeetingIdentity: mockGenerateMeetingIdentity }));

import { cancelScheduledMeeting, markNotificationRead, scheduleMeeting, updateScheduledMeeting } from '../controllers/scheduleController.js';

function response() { const res: any = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res); return res; }
const workspaceId = '507f1f77bcf86cd799439011';
const guestId = '507f1f77bcf86cd799439012';
let existingMeeting: any;
function futurePayload(extra: Record<string, unknown> = {}) {
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  return { workspaceId, title: 'Team Sync', description: '', localStart: `${day}T09:30`, localEnd: `${day}T10:30`, timeZone: 'Asia/Calcutta', meetingType: 'team', agenda: 'Priorities', inviteeIds: [guestId, guestId], reminderMinutes: [15, 5], ...extra };
}

describe('scheduled meeting creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkspaceFindOne.mockResolvedValue({ role: 'member' });
    mockGenerateMeetingIdentity.mockResolvedValue({ meetingCode: 'IM-TEST1234', joinCode: 'TEST1234', invitationId: 'test-invitation-id' });
    mockWorkspaceFind.mockReturnValue({ select: async () => [{ userId: guestId }] });
    const meeting: any = { _id: '507f1f77bcf86cd799439013', ...futurePayload(), createdBy: 'host-1', status: 'scheduled', scheduledAt: new Date('2026-11-14T04:00:00.000Z'), endsAt: new Date('2026-11-14T05:00:00.000Z'), createdAt: new Date(), updatedAt: new Date() };
    mockMeetingCreate.mockResolvedValue(meeting);
    existingMeeting = { ...meeting, save: jest.fn().mockResolvedValue(undefined) };
    mockMeetingFindById.mockResolvedValue(existingMeeting);
    mockInviteUpsert.mockResolvedValue({ _id: 'invite-1' });
    mockNotificationUpsert.mockResolvedValue({ _id: 'notification-1', meetingId: meeting._id });
    mockNotificationDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockInviteFind.mockResolvedValue([]);
  });

  it('stores a scheduled meeting in UTC and upserts unique workspace-member invitations', async () => {
    const req: any = { userId: 'host-1', body: futurePayload() }; const res = response();
    await scheduleMeeting(req, res);
    expect(mockMeetingCreate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Team Sync', timeZone: 'Asia/Calcutta', meetingType: 'team', agenda: 'Priorities', reminderMinutes: [15, 5], scheduledAt: expect.any(Date) }));
    expect(mockMeetingCreate).toHaveBeenCalledWith(expect.objectContaining({ meetingCode: 'IM-TEST1234', joinCode: 'TEST1234', invitationId: 'test-invitation-id' }));
    const start = mockMeetingCreate.mock.calls[0][0].scheduledAt as Date;
    expect(start.toISOString()).toMatch(/T04:00:00\.000Z$/);
    expect(mockInviteUpsert).toHaveBeenCalledTimes(1);
    expect(mockInviteUpsert).toHaveBeenCalledWith(expect.objectContaining({ userId: guestId }), expect.objectContaining({ $setOnInsert: expect.any(Object) }), expect.objectContaining({ upsert: true }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns meaningful validation errors without attempting persistence for invalid payloads', async () => {
    const invalid = response();
    await scheduleMeeting({ userId: 'host-1', body: futurePayload({ title: '   ', reminderMinutes: [10] }) } as any, invalid);
    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(invalid.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Bad Request',
      message: expect.stringContaining('title'),
    }));
    expect(mockGenerateMeetingIdentity).not.toHaveBeenCalled();
    expect(mockMeetingCreate).not.toHaveBeenCalled();
  });

  it('rejects viewers and nonexistent daylight-saving local times', async () => {
    mockWorkspaceFindOne.mockResolvedValueOnce({ role: 'viewer' });
    const denied = response(); await scheduleMeeting({ userId: 'viewer-1', body: futurePayload() } as any, denied);
    expect(denied.status).toHaveBeenCalledWith(403); expect(mockMeetingCreate).not.toHaveBeenCalled();
    const invalid = response();
    await scheduleMeeting({ userId: 'host-1', body: futurePayload({ localStart: '2027-03-14T02:30', localEnd: '2027-03-14T03:30', timeZone: 'America/New_York', inviteeIds: [] }) } as any, invalid);
    expect(invalid.status).toHaveBeenCalledWith(400); expect(mockMeetingCreate).not.toHaveBeenCalled();
  });

  it('prevents a workspace member who is not the host from editing or cancelling', async () => {
    const request: any = { userId: 'member-1', params: { meetingId: existingMeeting._id }, body: { title: 'Changed title' } };
    const updateResponse = response(); await updateScheduledMeeting(request, updateResponse);
    expect(updateResponse.status).toHaveBeenCalledWith(403); expect(existingMeeting.save).not.toHaveBeenCalled();
    const cancelResponse = response(); await cancelScheduledMeeting(request, cancelResponse);
    expect(cancelResponse.status).toHaveBeenCalledWith(403); expect(existingMeeting.save).not.toHaveBeenCalled();
  });

  it('clears undelivered reminders when the host reschedules or cancels', async () => {
    existingMeeting.scheduledAt = new Date(Date.now() + 3 * 86400000);
    const request: any = { userId: 'host-1', params: { meetingId: existingMeeting._id }, body: { localStart: futurePayload().localStart, localEnd: futurePayload().localEnd, timeZone: 'Asia/Kolkata' } };
    const updateResponse = response(); await updateScheduledMeeting(request, updateResponse);
    expect(existingMeeting.save).toHaveBeenCalled();
    expect(mockNotificationDeleteMany).toHaveBeenCalledWith(expect.objectContaining({ type: 'meeting_reminder', deliveredAt: { $exists: false } }));
    existingMeeting.status = 'scheduled';
    const cancelResponse = response(); await cancelScheduledMeeting(request, cancelResponse);
    expect(existingMeeting.status).toBe('cancelled');
    expect(mockNotificationDeleteMany).toHaveBeenCalledTimes(2);
  });

  it('scopes marking a notification as read to the authenticated user', async () => {
    const req: any = { userId: 'member-1', params: { notificationId: 'notification-1' } }; const res = response();
    await markNotificationRead(req, res);
    expect(mockNotificationUpsert).toHaveBeenCalledWith({ _id: 'notification-1', userId: 'member-1' }, expect.any(Object), expect.any(Object));
  });
});
