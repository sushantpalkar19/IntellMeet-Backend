const mockMeetings = [{ _id: 'meeting-1', workspaceId: 'workspace-1', createdBy: 'host-1', title: 'Planning', scheduledAt: new Date('2026-11-12T12:10:00.000Z'), reminderMinutes: [15, 5] }];
const mockUpdateNotification = jest.fn();
const mockEmitNotification = jest.fn();
jest.mock('../models/Meeting.js', () => ({ __esModule: true, MeetingStatus: { SCHEDULED: 'scheduled' }, default: { find: jest.fn(() => ({ select: async () => mockMeetings })) } }));
jest.mock('../models/MeetingInvite.js', () => ({ __esModule: true, default: { find: jest.fn(() => ({ select: async () => [{ userId: 'guest-1' }] })) } }));
jest.mock('../models/ReminderPreference.js', () => ({ __esModule: true, default: { findOne: jest.fn().mockResolvedValue(null) } }));
jest.mock('../models/Notification.js', () => ({ __esModule: true, default: { updateOne: mockUpdateNotification, find: jest.fn(() => ({ sort() { return this; }, limit: async () => [] })) } }));
jest.mock('../socket/index.js', () => ({ emitUserNotification: mockEmitNotification }));

import Notification from '../models/Notification.js';
import { processMeetingReminders } from '../services/meetingReminderScheduler.js';

describe('persistent meeting reminder polling', () => {
  beforeEach(() => { jest.clearAllMocks(); mockUpdateNotification.mockResolvedValue({ upsertedCount: 1 }); });

  it('recreates due reminders after restart using unique idempotency keys', async () => {
    const now = new Date('2026-11-12T12:00:00.000Z');
    await processMeetingReminders(now);
    await processMeetingReminders(now); // models a second poll/process restart
    expect(mockUpdateNotification).toHaveBeenCalledTimes(4); // host and invitee, once for each poll
    const keys = mockUpdateNotification.mock.calls.map(([filter]) => filter.deliveryKey);
    expect(new Set(keys).size).toBe(2);
    expect(mockUpdateNotification).toHaveBeenCalledWith(expect.objectContaining({ deliveryKey: expect.stringContaining(':15:') }), expect.anything(), expect.objectContaining({ upsert: true }));
    expect((Notification.find as jest.Mock)).toHaveBeenCalled();
  });
});
