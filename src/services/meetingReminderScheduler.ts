import Meeting, { MeetingStatus } from '../models/Meeting.js';
import MeetingInvite from '../models/MeetingInvite.js';
import Notification from '../models/Notification.js';
import ReminderPreference from '../models/ReminderPreference.js';
import { emitUserNotification } from '../socket/index.js';

let timer: NodeJS.Timeout | undefined;
let running = false;

/** DB-backed polling: due reminders survive process restarts; unique delivery keys make creation idempotent. */
export async function processMeetingReminders(now = new Date()): Promise<void> {
  const upperBound = new Date(now.getTime() + 30 * 60_000);
  const meetings = await Meeting.find({ status: MeetingStatus.SCHEDULED, scheduledAt: { $gt: now, $lte: upperBound } }).select('_id workspaceId createdBy title scheduledAt reminderMinutes');
  for (const meeting of meetings) {
    const invitees = await MeetingInvite.find({ meetingId: meeting._id, status: 'invited' }).select('userId');
    const recipients = [...new Set([String(meeting.createdBy), ...invitees.map((item) => String(item.userId))])];
    const delta = meeting.scheduledAt!.getTime() - now.getTime();
    for (const userId of recipients) {
      const preference = await ReminderPreference.findOne({ userId });
      if (preference?.enabled === false) continue;
      const offsets = meeting.reminderMinutes?.length ? meeting.reminderMinutes : preference?.reminderMinutes || [15, 5];
      for (const minutes of offsets) {
        if (delta > minutes * 60_000) continue;
        // If polling resumes near start, send only the closest configured reminder, not a burst of old reminders.
        if (offsets.some((closer) => closer < minutes && delta <= closer * 60_000)) continue;
        const deliveryKey = `reminder:${meeting._id}:${userId}:${minutes}:${meeting.scheduledAt!.getTime()}`;
        await Notification.updateOne({ deliveryKey }, { $setOnInsert: { userId, workspaceId: meeting.workspaceId, meetingId: meeting._id, type: 'meeting_reminder', title: 'Upcoming meeting', message: `${meeting.title} starts in ${minutes} minutes.`, deliveryKey, scheduledFor: now } }, { upsert: true });
      }
    }
  }

  const due = await Notification.find({ deliveredAt: { $exists: false }, scheduledFor: { $lte: now }, $or: [{ claimUntil: { $exists: false } }, { claimUntil: { $lte: now } }] }).sort({ scheduledFor: 1 }).limit(200);
  for (const notification of due) {
    const claimUntil = new Date(now.getTime() + 60_000);
    const claimed = await Notification.findOneAndUpdate({ _id: notification._id, deliveredAt: { $exists: false }, $or: [{ claimUntil: { $exists: false } }, { claimUntil: { $lte: now } }] }, { $set: { claimUntil } }, { new: true });
    if (!claimed) continue;
    emitUserNotification(String(claimed.userId), claimed);
    await Notification.updateOne({ _id: claimed._id, claimUntil }, { $set: { deliveredAt: now }, $unset: { claimUntil: 1 } });
  }
}

export function startMeetingReminderScheduler(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void processMeetingReminders().catch((error) => console.error('Meeting reminder poll failed:', (error as Error).message)).finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  void processMeetingReminders().catch((error) => console.error('Meeting reminder startup poll failed:', (error as Error).message));
}

export function stopMeetingReminderScheduler(): void { if (timer) clearInterval(timer); timer = undefined; running = false; }
