import { Request, Response } from 'express';
import mongoose from 'mongoose';
import WorkspaceMember from '../models/WorkspaceMember.js';
import Meeting, { MeetingStatus } from '../models/Meeting.js';
import MeetingParticipant from '../models/MeetingParticipant.js';
import WorkspaceTask from '../models/WorkspaceTask.js';
import MeetingTranscript from '../models/MeetingTranscript.js';
import MeetingSummary from '../models/MeetingSummary.js';
import MeetingActionItem from '../models/MeetingActionItem.js';
import MeetingRecording from '../models/MeetingRecording.js';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import { analyticsQuerySchema } from '../validators/analyticsValidator.js';

interface AnalyticsScope { workspaceIds: mongoose.Types.ObjectId[]; from: Date; to: Date; groupBy: 'day' | 'week' | 'month'; page: number; limit: number; }

async function scopeFor(req: Request, res: Response): Promise<AnalyticsScope | null> {
  const parsed = analyticsQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0]?.message || 'Invalid analytics filters.' }); return null; }
  const now = new Date();
  const from = parsed.data.from ? new Date(`${parsed.data.from}T00:00:00.000Z`) : new Date(now.getTime() - 29 * 86400000);
  const to = parsed.data.to ? new Date(`${parsed.data.to}T23:59:59.999Z`) : now;
  if (from > to) { res.status(400).json({ message: 'The start date must be on or before the end date.' }); return null; }
  if (to.getTime() - from.getTime() > 366 * 86400000) { res.status(400).json({ message: 'Analytics date ranges cannot exceed 366 days.' }); return null; }
  const memberships = await WorkspaceMember.find({ userId: req.userId }).select('workspaceId').lean();
  const allowed = memberships.map((membership) => String(membership.workspaceId));
  if (parsed.data.workspaceId && !allowed.includes(parsed.data.workspaceId)) {
    res.status(403).json({ error: 'Forbidden', message: 'You do not have access to analytics for this workspace.' }); return null;
  }
  const selected = parsed.data.workspaceId ? [parsed.data.workspaceId] : allowed;
  return { workspaceIds: selected.map((id) => new mongoose.Types.ObjectId(id)), from, to, groupBy: parsed.data.groupBy, page: parsed.data.page, limit: parsed.data.limit };
}

function workspaceMatch(scope: AnalyticsScope) { return { workspaceId: { $in: scope.workspaceIds } }; }
function createdRange(scope: AnalyticsScope) { return { createdAt: { $gte: scope.from, $lte: scope.to } }; }
function periodExpression(groupBy: AnalyticsScope['groupBy']) {
  if (groupBy === 'month') return { $dateToString: { format: '%Y-%m', date: '$date', timezone: 'UTC' } };
  if (groupBy === 'week') return { $dateToString: { format: '%G-W%V', date: '$date', timezone: 'UTC' } };
  return { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: 'UTC' } };
}
function periodUnit(groupBy: AnalyticsScope['groupBy']) { return groupBy === 'week' ? 'week' : groupBy === 'month' ? 'month' : 'day'; }

export async function analyticsOverview(req: Request, res: Response): Promise<void> {
  const scope = await scopeFor(req, res); if (!scope) return;
  const now = new Date(); const meetingFilter = { ...workspaceMatch(scope), ...createdRange(scope) };
  const [meetingStatus, duration, attendance, summaries, taskStatuses] = await Promise.all([
    Meeting.aggregate([{ $match: meetingFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Meeting.aggregate([{ $match: { ...meetingFilter, status: 'ended', startedAt: { $type: 'date' }, endedAt: { $type: 'date' }, $expr: { $gt: ['$endedAt', '$startedAt'] } } }, { $project: { durationMs: { $subtract: ['$endedAt', '$startedAt'] } } }, { $group: { _id: null, totalMs: { $sum: '$durationMs' }, averageMs: { $avg: '$durationMs' }, count: { $sum: 1 } } }]),
    MeetingParticipant.aggregate([{ $match: { joinedAt: { $gte: scope.from, $lte: scope.to } } }, { $lookup: { from: Meeting.collection.name, localField: 'meetingId', foreignField: '_id', as: 'meeting' } }, { $unwind: '$meeting' }, { $match: { 'meeting.workspaceId': { $in: scope.workspaceIds } } }, { $count: 'count' }]),
    MeetingSummary.countDocuments({ ...workspaceMatch(scope), ...createdRange(scope), generationStatus: 'completed' }),
    WorkspaceTask.aggregate([{ $match: { ...workspaceMatch(scope), ...createdRange(scope) } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const counts = Object.fromEntries(meetingStatus.map((row: any) => [row._id, row.count]));
  const tasks = Object.fromEntries(taskStatuses.map((row: any) => [row._id, row.count]));
  const durationData = duration[0] || { totalMs: 0, averageMs: null, count: 0 };
  const attendanceCount = attendance[0]?.count || 0;
  const upcomingStart = scope.from > now ? scope.from : now;
  const upcoming = upcomingStart <= scope.to ? await Meeting.countDocuments({ ...workspaceMatch(scope), status: MeetingStatus.SCHEDULED, scheduledAt: { $gte: upcomingStart, $lte: scope.to } }) : 0;
  res.json({
    range: { from: scope.from.toISOString(), to: scope.to.toISOString() },
    meetings: { total: Object.values(counts).reduce((sum: number, value: any) => sum + value, 0), completed: counts.ended || 0, live: counts.live || 0, upcoming, cancelled: counts.cancelled || 0, totalDurationMs: durationData.totalMs, averageDurationMs: durationData.averageMs, durationSampleCount: durationData.count },
    attendanceRecords: attendanceCount,
    ai: { summariesGenerated: summaries },
    tasks: { total: Object.values(tasks).reduce((sum: number, value: any) => sum + value, 0), todo: tasks.TODO || 0, inProgress: tasks.IN_PROGRESS || 0, completed: tasks.DONE || 0 },
  });
}

export async function meetingAnalytics(req: Request, res: Response): Promise<void> {
  const scope = await scopeFor(req, res); if (!scope) return;
  const meetingFilter = { ...workspaceMatch(scope), ...createdRange(scope) };
  const [activity, status, durations, byWorkspace, attendance] = await Promise.all([
    Meeting.aggregate([{ $match: meetingFilter }, { $project: { date: '$createdAt' } }, { $group: { _id: periodExpression(scope.groupBy), count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Meeting.aggregate([{ $match: meetingFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Meeting.aggregate([{ $match: { ...workspaceMatch(scope), status: 'ended', endedAt: { $gte: scope.from, $lte: scope.to }, startedAt: { $type: 'date' }, $expr: { $gt: ['$endedAt', '$startedAt'] } } }, { $project: { date: '$endedAt', durationMs: { $subtract: ['$endedAt', '$startedAt'] } } }, { $group: { _id: periodExpression(scope.groupBy), totalMs: { $sum: '$durationMs' }, averageMs: { $avg: '$durationMs' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Meeting.aggregate([{ $match: meetingFilter }, { $group: { _id: '$workspaceId', count: { $sum: 1 } } }, { $lookup: { from: Workspace.collection.name, localField: '_id', foreignField: '_id', as: 'workspace' } }, { $unwind: '$workspace' }, { $project: { _id: 0, workspaceId: { $toString: '$_id' }, name: '$workspace.name', count: 1 } }, { $sort: { count: -1, name: 1 } }, { $skip: (scope.page - 1) * scope.limit }, { $limit: scope.limit }]),
    MeetingParticipant.aggregate([{ $match: { joinedAt: { $gte: scope.from, $lte: scope.to } } }, { $lookup: { from: Meeting.collection.name, localField: 'meetingId', foreignField: '_id', as: 'meeting' } }, { $unwind: '$meeting' }, { $match: { 'meeting.workspaceId': { $in: scope.workspaceIds } } }, { $project: { date: '$joinedAt', meetingId: '$meeting._id' } }, { $group: { _id: periodExpression(scope.groupBy), attendanceRecords: { $sum: 1 }, meetings: { $addToSet: '$meetingId' } } }, { $project: { attendanceRecords: 1, meetingCount: { $size: '$meetings' } } }, { $sort: { _id: 1 } }]),
  ]);
  res.json({ groupBy: scope.groupBy, unit: periodUnit(scope.groupBy), activity, status: Object.fromEntries(status.map((row: any) => [row._id, row.count])), durations, byWorkspace, attendance });
}

export async function taskAnalytics(req: Request, res: Response): Promise<void> {
  const scope = await scopeFor(req, res); if (!scope) return;
  const filter = { ...workspaceMatch(scope), ...createdRange(scope) };
  const [statuses, priorities, byWorkspace, assignees] = await Promise.all([
    WorkspaceTask.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    WorkspaceTask.aggregate([{ $match: filter }, { $group: { _id: '$priority', count: { $sum: 1 } } }]),
    WorkspaceTask.aggregate([{ $match: filter }, { $group: { _id: '$workspaceId', count: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] } } } }, { $lookup: { from: Workspace.collection.name, localField: '_id', foreignField: '_id', as: 'workspace' } }, { $unwind: '$workspace' }, { $project: { _id: 0, workspaceId: { $toString: '$_id' }, name: '$workspace.name', count: 1, completed: 1 } }, { $sort: { count: -1, name: 1 } }, { $skip: (scope.page - 1) * scope.limit }, { $limit: scope.limit }]),
    WorkspaceTask.aggregate([
      { $match: { ...filter, assigneeId: { $ne: null } } },
      { $group: { _id: { workspaceId: '$workspaceId', assigneeId: '$assigneeId' }, assigned: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] } } } },
      { $lookup: { from: User.collection.name, localField: '_id.assigneeId', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { _id: 0, workspaceId: { $toString: '$_id.workspaceId' }, userId: { $toString: '$_id.assigneeId' }, name: { $trim: { input: { $concat: ['$user.firstName', ' ', '$user.lastName'] } } }, assigned: 1, completed: 1 } },
      { $sort: { assigned: -1, name: 1 } }, { $skip: (scope.page - 1) * scope.limit }, { $limit: scope.limit },
    ]),
  ]);
  const count = (key: string) => statuses.find((row: any) => row._id === key)?.count || 0;
  const total = statuses.reduce((sum: number, row: any) => sum + row.count, 0); const completed = count('DONE');
  res.json({ total, completed, todo: count('TODO'), inProgress: count('IN_PROGRESS'), completionPercent: total ? Math.round(completed / total * 100) : null, priorities: Object.fromEntries(priorities.map((row: any) => [row._id, row.count])), byWorkspace, byAssignee: assignees });
}

export async function aiAnalytics(req: Request, res: Response): Promise<void> {
  const scope = await scopeFor(req, res); if (!scope) return;
  const range = createdRange(scope);
  const [summaryMetrics, transcriptMetrics, actions, recordingMetrics] = await Promise.all([
    MeetingSummary.aggregate([{ $match: { ...workspaceMatch(scope), ...range, generationStatus: 'completed' } }, { $group: { _id: '$meetingId' } }, { $count: 'count' }]),
    MeetingTranscript.aggregate([
      { $match: { createdAt: { $gte: scope.from, $lte: scope.to } } },
      { $lookup: { from: Meeting.collection.name, localField: 'meetingId', foreignField: '_id', as: 'meeting' } },
      { $unwind: '$meeting' }, { $match: { 'meeting.workspaceId': { $in: scope.workspaceIds } } },
      { $group: { _id: '$meetingId', segments: { $sum: 1 } } },
      { $group: { _id: null, meetings: { $sum: 1 }, segments: { $sum: '$segments' } } },
    ]),
    MeetingActionItem.countDocuments({ ...workspaceMatch(scope), ...range }),
    MeetingRecording.aggregate([{ $match: { ...workspaceMatch(scope), ...range, status: 'completed', storageRef: { $exists: true, $ne: '' } } }, { $group: { _id: '$meetingId', recordings: { $sum: 1 } } }, { $group: { _id: null, meetings: { $sum: 1 }, recordings: { $sum: '$recordings' } } }]),
  ]);
  res.json({ transcriptMeetings: transcriptMetrics[0]?.meetings || 0, transcriptSegments: transcriptMetrics[0]?.segments || 0, summariesGenerated: summaryMetrics[0]?.count || 0, meetingsWithSummaries: summaryMetrics[0]?.count || 0, actionItems: actions, recordings: recordingMetrics[0]?.recordings || 0, meetingsWithRecordings: recordingMetrics[0]?.meetings || 0 });
}

export async function workspaceComparison(req: Request, res: Response): Promise<void> {
  const scope = await scopeFor(req, res); if (!scope) return;
  const workspaceIds = scope.workspaceIds;
  const [workspaces, meetings, tasks] = await Promise.all([
    Workspace.find({ _id: { $in: workspaceIds } }).select('name').sort({ name: 1 }).skip((scope.page - 1) * scope.limit).limit(scope.limit).lean(),
    Meeting.aggregate([{ $match: { ...workspaceMatch(scope), ...createdRange(scope) } }, { $group: { _id: '$workspaceId', meetings: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'ended'] }, 1, 0] } } } }]),
    WorkspaceTask.aggregate([{ $match: { ...workspaceMatch(scope), ...createdRange(scope) } }, { $group: { _id: '$workspaceId', tasks: { $sum: 1 }, completedTasks: { $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] } } } }]),
  ]);
  const meetingMap = new Map(meetings.map((row: any) => [String(row._id), row])); const taskMap = new Map(tasks.map((row: any) => [String(row._id), row]));
  res.json({ workspaces: workspaces.map((workspace: any) => {
    const meeting = meetingMap.get(String(workspace._id)) || { meetings: 0, completed: 0 };
    const task = taskMap.get(String(workspace._id)) || { tasks: 0, completedTasks: 0 };
    return { id: String(workspace._id), name: workspace.name, meetings: meeting.meetings, completed: meeting.completed, tasks: task.tasks, completedTasks: task.completedTasks };
  }), page: scope.page, limit: scope.limit });
}
