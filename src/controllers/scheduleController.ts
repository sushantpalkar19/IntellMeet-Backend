import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import Meeting, { MeetingStatus } from '../models/Meeting.js';
import MeetingInvite from '../models/MeetingInvite.js';
import WorkspaceMember, { WorkspaceRole } from '../models/WorkspaceMember.js';
import Notification from '../models/Notification.js';
import ReminderPreference from '../models/ReminderPreference.js';
import { localDateTimeToUtc, isValidTimeZone } from '../utils/meetingTime.js';
import { emitUserNotification } from '../socket/index.js';

const scheduleSchema = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().trim().max(1000).optional().default(''),
  localStart: z.string(), localEnd: z.string(), timeZone: z.string().min(1).max(64),
  meetingType: z.enum(['team', 'one_on_one', 'other']).default('team'), agenda: z.string().max(10000).optional().default(''),
  inviteeIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(100).optional().default([]),
  reminderMinutes: z.array(z.union([z.literal(5), z.literal(15), z.literal(30)])).max(3).optional().default([15, 5]),
});
const updateSchema = scheduleSchema.partial().extend({ inviteeIds: scheduleSchema.shape.inviteeIds.optional() });
const id = (value: string) => mongoose.Types.ObjectId.isValid(value);
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request', message });
const workspaceIdsFor = async (userId: string) => (await WorkspaceMember.find({ userId }).select('workspaceId')).map((m) => String(m.workspaceId));
const toMeeting = (meeting: any) => ({ id: String(meeting._id), workspaceId: String(meeting.workspaceId), title: meeting.title, description: meeting.description, createdBy: String(meeting.createdBy), status: meeting.status, scheduledAt: meeting.scheduledAt, endsAt: meeting.endsAt, timeZone: meeting.timeZone || 'UTC', meetingType: meeting.meetingType || 'team', agenda: meeting.agenda || '', reminderMinutes: meeting.reminderMinutes || [15, 5], startedAt: meeting.startedAt, endedAt: meeting.endedAt, createdAt: meeting.createdAt, updatedAt: meeting.updatedAt });

async function parseSchedule(body: unknown, partial = false) {
  const parsed = (partial ? updateSchema : scheduleSchema).safeParse(body);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Invalid meeting details' } as const;
  const data = parsed.data as z.infer<typeof scheduleSchema>;
  if (data.timeZone && !isValidTimeZone(data.timeZone)) return { error: 'Choose a valid IANA time zone.' } as const;
  if (partial && data.localStart === undefined && data.localEnd === undefined) return { data } as const;
  if (partial && (!data.localStart || !data.localEnd || !data.timeZone)) return { error: 'Start, end and time zone must be updated together.' } as const;
  if (!data.localStart || !data.localEnd || !data.timeZone) return { error: 'Start, end and time zone are required.' } as const;
  try {
    const start = localDateTimeToUtc(data.localStart, data.timeZone); const end = localDateTimeToUtc(data.localEnd, data.timeZone);
    if (start.getTime() <= Date.now()) return { error: 'Meeting start must be in the future.' } as const;
    if (end <= start) return { error: 'Meeting end must be after its start.' } as const;
    return { data, start, end } as const;
  } catch (error) { return { error: (error as Error).message } as const; }
}

async function addInvitees(meeting: any, inviterId: string, inviteeIds: string[]) {
  const uniqueIds = [...new Set(inviteeIds)].filter((userId) => userId !== inviterId);
  if (!uniqueIds.length) return [];
  const memberships = await WorkspaceMember.find({ workspaceId: meeting.workspaceId, userId: { $in: uniqueIds } }).select('userId');
  if (memberships.length !== uniqueIds.length) throw new Error('Every invitee must be an existing member of this workspace.');
  const created = [];
  for (const userId of uniqueIds) {
    const invite = await MeetingInvite.findOneAndUpdate({ meetingId: meeting._id, userId }, { $setOnInsert: { meetingId: meeting._id, workspaceId: meeting.workspaceId, userId, invitedBy: inviterId, status: 'invited' } }, { new: true, upsert: true });
    created.push(invite);
    const notification = await Notification.findOneAndUpdate({ deliveryKey: `invite:${meeting._id}:${userId}` }, { $setOnInsert: { userId, workspaceId: meeting.workspaceId, meetingId: meeting._id, type: 'meeting_invitation', title: 'Meeting invitation', message: `You are invited to ${meeting.title}.`, deliveryKey: `invite:${meeting._id}:${userId}`, scheduledFor: new Date(), deliveredAt: new Date() } }, { new: true, upsert: true });
    emitUserNotification(String(userId), notification);
  }
  return created;
}

export async function scheduleMeeting(req: Request, res: Response): Promise<void> {
  const userId = req.userId; const workspaceId = String(req.body.workspaceId || '');
  if (!userId || !id(workspaceId)) { fail(res, 400, 'A valid workspace is required.'); return; }
  const membership = await WorkspaceMember.findOne({ workspaceId, userId });
  if (!membership || membership.role === WorkspaceRole.VIEWER) { fail(res, membership ? 403 : 404, 'You cannot schedule meetings in this workspace.'); return; }
  const parsed = await parseSchedule(req.body);
  if ('error' in parsed) { fail(res, 400, parsed.error || 'Meeting details are invalid.'); return; }
  let meeting: any;
  try {
    meeting = await Meeting.create({ workspaceId, title: parsed.data.title, description: parsed.data.description, createdBy: userId, status: MeetingStatus.SCHEDULED, scheduledAt: parsed.start, endsAt: parsed.end, timeZone: parsed.data.timeZone, meetingType: parsed.data.meetingType, agenda: parsed.data.agenda, reminderMinutes: [...new Set(parsed.data.reminderMinutes)] });
    await addInvitees(meeting, userId, parsed.data.inviteeIds);
    res.status(201).json({ meeting: toMeeting(meeting) });
  } catch (error) {
    if (meeting) { await Meeting.deleteOne({ _id: meeting._id }); await MeetingInvite.deleteMany({ meetingId: meeting._id }); await Notification.deleteMany({ meetingId: meeting._id, type: 'meeting_invitation' }); }
    const message = (error as Error).message;
    res.status(message.includes('invitee') ? 400 : 500).json({ error: 'Meeting scheduling failed', message: message.includes('invitee') ? message : 'Could not schedule meeting.' });
  }
}

export async function getCalendarMeetings(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const now = new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : (req.path.endsWith('/upcoming') ? now : new Date('invalid'));
  const to = req.query.to ? new Date(String(req.query.to)) : (req.path.endsWith('/upcoming') ? new Date(now.getTime() + 90 * 86400000) : new Date('invalid'));
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > 370 * 86400000) { fail(res, 400, 'Provide a valid calendar range of at most 370 days.'); return; }
  const workspaceIds = await workspaceIdsFor(userId); const workspaceId = req.query.workspaceId ? String(req.query.workspaceId) : undefined;
  if (workspaceId && !workspaceIds.includes(workspaceId)) { fail(res, 403, 'You do not have access to this workspace.'); return; }
  if (req.query.status && !Object.values(MeetingStatus).includes(String(req.query.status) as MeetingStatus)) { fail(res, 400, 'Meeting status filter is invalid.'); return; }
  const invited = await MeetingInvite.find({ userId, status: 'invited' }).distinct('meetingId');
  const filter: any = { scheduledAt: { $gte: from, $lt: to } };
  if (workspaceId) filter.workspaceId = workspaceId;
  else filter.$or = [{ workspaceId: { $in: workspaceIds } }, { _id: { $in: invited } }];
  if (req.query.status && Object.values(MeetingStatus).includes(String(req.query.status) as MeetingStatus)) filter.status = req.query.status;
  const meetings = await Meeting.find(filter).sort({ scheduledAt: 1 }).limit(500).lean();
  res.json({ meetings: meetings.map(toMeeting) });
}

export async function getScheduledMeeting(req: Request, res: Response): Promise<void> {
  const meeting: any = await Meeting.findById(req.params.meetingId).lean();
  if (!meeting) { fail(res, 404, 'Meeting not found.'); return; }
  const userId = req.userId!; const invite = await MeetingInvite.exists({ meetingId: meeting._id, userId });
  if (String(meeting.createdBy) !== userId && !invite && !await WorkspaceMember.exists({ workspaceId: meeting.workspaceId, userId })) { fail(res, 403, 'You do not have access to this meeting.'); return; }
  const invitees = await MeetingInvite.find({ meetingId: meeting._id }).populate('userId', 'firstName lastName email').lean();
  res.json({ meeting: toMeeting(meeting), invitees: invitees.map((i: any) => ({ id: String(i._id), userId: String(i.userId._id), firstName: i.userId.firstName, lastName: i.userId.lastName, email: i.userId.email, status: i.status })) });
}

export async function updateScheduledMeeting(req: Request, res: Response): Promise<void> {
  const meeting: any = await Meeting.findById(req.params.meetingId);
  if (!meeting) { fail(res, 404, 'Meeting not found.'); return; }
  if (meeting.status === MeetingStatus.CANCELLED || meeting.status === MeetingStatus.ENDED) { fail(res, 400, 'This meeting can no longer be changed.'); return; }
  const parsed = await parseSchedule(req.body, true);
  if ('error' in parsed) { fail(res, 400, parsed.error || 'Meeting details are invalid.'); return; }
  const membership = await WorkspaceMember.findOne({ workspaceId: meeting.workspaceId, userId: req.userId });
  const allowed = String(meeting.createdBy) === req.userId || membership?.role === WorkspaceRole.OWNER || membership?.role === WorkspaceRole.ADMIN;
  if (!allowed) { fail(res, 403, 'Only the meeting host or workspace admin can reschedule it.'); return; }
  const oldScheduledAt = meeting.scheduledAt;
  const inviteeIds = parsed.data.inviteeIds;
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined && !['localStart', 'localEnd', 'inviteeIds'].includes(key)) meeting[key] = value;
  }
  if (parsed.start) meeting.scheduledAt = parsed.start;
  if (parsed.end) meeting.endsAt = parsed.end;
  await meeting.save();
  if (inviteeIds) await addInvitees(meeting, req.userId!, inviteeIds);
  if (String(oldScheduledAt) !== String(meeting.scheduledAt)) await Notification.deleteMany({ meetingId: meeting._id, type: 'meeting_reminder', deliveredAt: { $exists: false } });
  if (String(oldScheduledAt) !== String(meeting.scheduledAt)) {
    const invitees = await MeetingInvite.find({ meetingId: meeting._id, status: 'invited' });
    for (const invite of invitees) {
      const deliveryKey = `rescheduled:${meeting._id}:${invite.userId}:${meeting.scheduledAt.getTime()}`;
      const notification = await Notification.findOneAndUpdate({ deliveryKey }, { $setOnInsert: { userId: invite.userId, workspaceId: meeting.workspaceId, meetingId: meeting._id, type: 'meeting_rescheduled', title: 'Meeting rescheduled', message: `${meeting.title} has a new scheduled time.`, deliveryKey, scheduledFor: new Date(), deliveredAt: new Date() } }, { new: true, upsert: true });
      emitUserNotification(String(invite.userId), notification);
    }
  }
  res.json({ meeting: toMeeting(meeting) });
}

export async function cancelScheduledMeeting(req: Request, res: Response): Promise<void> {
  const meeting: any = await Meeting.findById(req.params.meetingId);
  if (!meeting) { fail(res, 404, 'Meeting not found.'); return; }
  const membership = await WorkspaceMember.findOne({ workspaceId: meeting.workspaceId, userId: req.userId });
  const allowed = String(meeting.createdBy) === req.userId || membership?.role === WorkspaceRole.OWNER || membership?.role === WorkspaceRole.ADMIN;
  if (!allowed) { fail(res, 403, 'Only the meeting host or workspace admin can cancel it.'); return; }
  if (meeting.status === MeetingStatus.LIVE || meeting.status === MeetingStatus.ENDED) { fail(res, 400, 'A live or ended meeting cannot be cancelled.'); return; }
  meeting.status = MeetingStatus.CANCELLED; await meeting.save();
  await Notification.deleteMany({ meetingId: meeting._id, type: 'meeting_reminder', deliveredAt: { $exists: false } });
  for (const invite of await MeetingInvite.find({ meetingId: meeting._id, status: 'invited' })) {
    const notification = await Notification.findOneAndUpdate({ deliveryKey: `cancelled:${meeting._id}:${invite.userId}` }, { $setOnInsert: { userId: invite.userId, workspaceId: meeting.workspaceId, meetingId: meeting._id, type: 'meeting_cancelled', title: 'Meeting cancelled', message: `${meeting.title} was cancelled.`, deliveryKey: `cancelled:${meeting._id}:${invite.userId}`, scheduledFor: new Date(), deliveredAt: new Date() } }, { new: true, upsert: true }); emitUserNotification(String(invite.userId), notification);
  }
  res.json({ meeting: toMeeting(meeting) });
}

export async function manageMeetingInvitees(req: Request, res: Response): Promise<void> {
  const meeting: any = await Meeting.findById(req.params.meetingId);
  if (!meeting) { fail(res, 404, 'Meeting not found.'); return; }
  const membership = await WorkspaceMember.findOne({ workspaceId: meeting.workspaceId, userId: req.userId });
  if (String(meeting.createdBy) !== req.userId && ![WorkspaceRole.OWNER, WorkspaceRole.ADMIN].includes(membership?.role as WorkspaceRole)) { fail(res, 403, 'Only the host or workspace admin can manage invitees.'); return; }
  if (req.method === 'GET') { req.params.meetingId = String(meeting._id); await getScheduledMeeting(req, res); return; }
  const body = z.object({ inviteeIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(100) }).safeParse(req.body);
  if (!body.success) { fail(res, 400, 'Provide valid workspace member IDs.'); return; }
  try { await addInvitees(meeting, req.userId!, body.data.inviteeIds); res.json({ invitees: await MeetingInvite.find({ meetingId: meeting._id }).select('userId status') }); }
  catch (error) { fail(res, 400, (error as Error).message); }
}

export async function removeMeetingInvitee(req: Request, res: Response): Promise<void> {
  const inviteeId = req.params.userId;
  if (typeof inviteeId !== 'string' || !id(inviteeId)) { fail(res, 400, 'A valid invitee is required.'); return; }
  const meeting: any = await Meeting.findById(req.params.meetingId);
  const membership = meeting && await WorkspaceMember.findOne({ workspaceId: meeting.workspaceId, userId: req.userId });
  if (!meeting) { fail(res, 404, 'Meeting not found.'); return; }
  if (String(meeting.createdBy) !== req.userId && ![WorkspaceRole.OWNER, WorkspaceRole.ADMIN].includes(membership?.role as WorkspaceRole)) { fail(res, 403, 'Only the host or workspace admin can manage invitees.'); return; }
  await MeetingInvite.deleteOne({ meetingId: meeting._id, userId: inviteeId });
  await Notification.deleteOne({ meetingId: meeting._id, userId: inviteeId, type: 'meeting_invitation', readAt: { $exists: false } });
  res.json({ removed: true });
}

export async function getNotifications(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const [notifications, total, unread] = await Promise.all([Notification.find({ userId: req.userId }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Notification.countDocuments({ userId: req.userId }), Notification.countDocuments({ userId: req.userId, readAt: { $exists: false } })]);
  res.json({ notifications, pagination: { page, limit, total }, unread });
}

export async function markNotificationRead(req: Request, res: Response): Promise<void> {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.notificationId, userId: req.userId }, { $set: { readAt: new Date() } }, { new: true });
  if (!notification) { fail(res, 404, 'Notification not found.'); return; } res.json({ notification });
}

export async function getReminderPreference(req: Request, res: Response): Promise<void> {
  const preference = await ReminderPreference.findOneAndUpdate({ userId: req.userId }, { $setOnInsert: { userId: req.userId, enabled: true, reminderMinutes: [15, 5] } }, { new: true, upsert: true }); res.json({ preference });
}
export async function setReminderPreference(req: Request, res: Response): Promise<void> {
  const parsed = z.object({ enabled: z.boolean(), reminderMinutes: z.array(z.union([z.literal(5), z.literal(15), z.literal(30)])).max(3) }).safeParse(req.body);
  if (!parsed.success) { fail(res, 400, 'Reminder preferences are invalid.'); return; }
  const preference = await ReminderPreference.findOneAndUpdate({ userId: req.userId }, { $set: { enabled: parsed.data.enabled, reminderMinutes: [...new Set(parsed.data.reminderMinutes)] } }, { new: true, upsert: true }); res.json({ preference });
}
