import { Request, Response } from 'express';
import mongoose from 'mongoose';
import MeetingActionItem, { ActionItemStatus } from '../models/MeetingActionItem.js';
import MeetingSummary from '../models/MeetingSummary.js';
import MeetingTranscript from '../models/MeetingTranscript.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import { generateMeetingNotes, SummaryError } from '../services/meetingSummaryService.js';

function serializeSummary(summary: any) {
  if (!summary) return null;
  return { id: String(summary._id), meetingId: String(summary.meetingId), workspaceId: String(summary.workspaceId), meetingTitle: summary.meetingTitle, meetingDate: summary.meetingDate, overview: summary.overview, detailedSummary: summary.detailedSummary, discussionPoints: summary.discussionPoints, decisions: summary.decisions, keyTakeaways: summary.keyTakeaways, unresolvedQuestions: summary.unresolvedQuestions, generationStatus: summary.generationStatus, generationError: summary.generationError, transcriptSegmentCount: summary.transcriptSegmentCount, generatedAt: summary.generatedAt, updatedAt: summary.updatedAt };
}
function serializeAction(item: any) {
  return { id: String(item._id), meetingId: String(item.meetingId), taskDescription: item.taskDescription, assigneeId: item.assigneeId ? String(item.assigneeId) : null, assigneeName: item.assigneeName || null, dueDate: item.dueDate || null, status: item.status, evidence: item.evidence, createdAt: item.createdAt, updatedAt: item.updatedAt };
}

export async function generateSummary(req: Request, res: Response): Promise<void> {
  if (!req.meetingId || !req.userId) { res.status(401).json({ message: 'Authentication required' }); return; }
  try { const summary = await generateMeetingNotes(req.meetingId, req.userId); res.status(200).json({ summary: serializeSummary(summary) }); }
  catch (error) {
    if (error instanceof SummaryError) { res.status(error.status).json({ error: error.status === 502 ? 'Provider Error' : 'Summary Error', message: error.message }); return; }
    const status = (error as { status?: number }).status;
    if (status === 429) { res.status(503).json({ error: 'Provider Unavailable', message: 'The summary service is temporarily rate limited. Please retry shortly.' }); return; }
    console.error('Meeting summary generation failed:', (error as Error).message);
    res.status(502).json({ error: 'Provider Error', message: 'Meeting summary generation failed. Please retry.' });
  }
}

export async function getSummary(req: Request, res: Response): Promise<void> {
  try { const summary = await MeetingSummary.findOne({ meetingId: req.meetingId }).lean(); res.status(200).json({ summary: serializeSummary(summary) }); }
  catch (error) { console.error('Meeting summary retrieval failed:', (error as Error).message); res.status(500).json({ message: 'Could not load meeting notes.' }); }
}

export async function getActionItems(req: Request, res: Response): Promise<void> {
  try { const items = await MeetingActionItem.find({ meetingId: req.meetingId }).sort({ createdAt: 1, _id: 1 }).lean(); res.status(200).json({ actionItems: items.map(serializeAction) }); }
  catch (error) { console.error('Meeting action item retrieval failed:', (error as Error).message); res.status(500).json({ message: 'Could not load meeting action items.' }); }
}

export async function updateActionItem(req: Request, res: Response): Promise<void> {
  try {
    const { actionItemId } = req.params;
    if (!mongoose.isValidObjectId(actionItemId)) { res.status(400).json({ message: 'Invalid action item ID.' }); return; }
    const allowed = ['assigneeId', 'dueDate'];
    if (Object.keys(req.body).some((key) => !allowed.includes(key))) { res.status(400).json({ message: 'Only assignee and due date can be edited here.' }); return; }
    const item = await MeetingActionItem.findOne({ _id: actionItemId, meetingId: req.meetingId });
    if (!item) { res.status(404).json({ message: 'Action item not found.' }); return; }
    if ('assigneeId' in req.body) {
      if (req.body.assigneeId === null || req.body.assigneeId === '') { item.assigneeId = null; item.assigneeName = undefined; }
      else {
        const assigneeId = String(req.body.assigneeId);
        if (!mongoose.isValidObjectId(assigneeId) || !(await WorkspaceMember.exists({ workspaceId: req.workspaceId, userId: assigneeId }))) { res.status(400).json({ message: 'Assignee must be a member of this workspace.' }); return; }
        const speaker = await MeetingTranscript.findOne({ meetingId: req.meetingId, speakerId: assigneeId }).select('speakerName').lean() as any;
        if (!speaker) { res.status(400).json({ message: 'Assignee must have authenticated speaker attribution in this meeting transcript.' }); return; }
        item.assigneeId = new mongoose.Types.ObjectId(assigneeId); item.assigneeName = speaker.speakerName;
      }
    }
    if ('dueDate' in req.body) {
      if (req.body.dueDate === null || req.body.dueDate === '') item.dueDate = null;
      else {
        const date = new Date(req.body.dueDate);
        if (typeof req.body.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== req.body.dueDate) { res.status(400).json({ message: 'Due date must be a valid YYYY-MM-DD date.' }); return; }
        item.dueDate = date;
      }
    }
    item.source = 'user'; await item.save(); res.status(200).json({ actionItem: serializeAction(item) });
  } catch (error) { console.error('Meeting action item update failed:', (error as Error).message); res.status(500).json({ message: 'Could not update action item.' }); }
}

export async function updateActionItemStatus(req: Request, res: Response): Promise<void> {
  const { status } = req.body as { status?: string };
  if (!mongoose.isValidObjectId(req.params.actionItemId)) { res.status(400).json({ message: 'Invalid action item ID.' }); return; }
  if (!Object.values(ActionItemStatus).includes(status as ActionItemStatus)) { res.status(400).json({ message: 'Invalid action item status.' }); return; }
  try {
    const item = await MeetingActionItem.findOneAndUpdate({ _id: req.params.actionItemId, meetingId: req.meetingId }, { $set: { status } }, { new: true, runValidators: true });
    if (!item) { res.status(404).json({ message: 'Action item not found.' }); return; }
    res.status(200).json({ actionItem: serializeAction(item) });
  } catch (error) { console.error('Meeting action item status update failed:', (error as Error).message); res.status(500).json({ message: 'Could not update action item status.' }); }
}

export async function deleteActionItem(req: Request, res: Response): Promise<void> {
  try {
    if (!mongoose.isValidObjectId(req.params.actionItemId)) { res.status(400).json({ message: 'Invalid action item ID.' }); return; }
    const deleted = await MeetingActionItem.findOneAndDelete({ _id: req.params.actionItemId, meetingId: req.meetingId });
    if (!deleted) { res.status(404).json({ message: 'Action item not found.' }); return; }
    res.status(204).send();
  } catch (error) { console.error('Meeting action item deletion failed:', (error as Error).message); res.status(500).json({ message: 'Could not delete action item.' }); }
}
