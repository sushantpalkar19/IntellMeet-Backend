import { createHash } from 'crypto';
import Meeting from '../models/Meeting.js';
import MeetingTranscript from '../models/MeetingTranscript.js';
import MeetingSummary from '../models/MeetingSummary.js';
import MeetingActionItem, { ActionItemStatus } from '../models/MeetingActionItem.js';
import WorkspaceMember from '../models/WorkspaceMember.js';
import { getMeetingSummaryProvider, GeneratedMeetingNotes } from './meetingSummaryProvider.js';

export class SummaryError extends Error { constructor(public status: number, message: string) { super(message); } }
const MAX_TRANSCRIPT_CHARS = 100000;
const MIN_WORDS = 12;

export async function generateMeetingNotes(meetingId: string, userId: string) {
  const meeting = await Meeting.findById(meetingId);
  if (!meeting) throw new SummaryError(404, 'Meeting not found');
  const transcripts = await MeetingTranscript.find({ meetingId }).sort({ startAt: 1, _id: 1 }).lean();
  const combined = transcripts.map((segment: any) => `${segment.speakerName}: ${segment.text}`).join('\n');
  if (combined.trim().split(/\s+/).filter(Boolean).length < MIN_WORDS) throw new SummaryError(422, 'There is not enough transcript to generate reliable meeting notes yet.');
  if (combined.length > MAX_TRANSCRIPT_CHARS) throw new SummaryError(413, 'This transcript is too large to summarize in one request.');

  let summary = await MeetingSummary.findOne({ meetingId });
  if (summary?.generationStatus === 'processing') throw new SummaryError(409, 'A summary is already being generated.');
  const workspaceId = meeting.workspaceId;
  if (!summary) {
    try {
      summary = await MeetingSummary.create({ meetingId, workspaceId, generatedBy: userId, meetingTitle: meeting.title, meetingDate: meeting.startedAt || meeting.scheduledAt || meeting.createdAt, generationStatus: 'processing', transcriptSegmentCount: transcripts.length });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new SummaryError(409, 'A summary is already being generated.');
      throw error;
    }
  } else {
    const locked = await MeetingSummary.findOneAndUpdate({ _id: summary._id, generationStatus: { $ne: 'processing' } }, { $set: { generationStatus: 'processing', generationError: undefined } }, { new: true });
    if (!locked) throw new SummaryError(409, 'A summary is already being generated.');
    summary = locked;
  }

  try {
    const speakers = [...new Map(transcripts.map((s: any) => [String(s.speakerId), { id: String(s.speakerId), name: s.speakerName }])).values()];
    const generated = await getMeetingSummaryProvider().generate({ meetingTitle: meeting.title, meetingDate: new Date(meeting.startedAt || meeting.scheduledAt || meeting.createdAt).toISOString(), transcript: combined, speakers });
    validateGeneratedNotes(generated, combined, speakers, transcripts);
    Object.assign(summary, { generatedBy: userId, meetingTitle: meeting.title, meetingDate: meeting.startedAt || meeting.scheduledAt || meeting.createdAt, overview: generated.overview, detailedSummary: generated.detailedSummary, discussionPoints: generated.discussionPoints, decisions: generated.decisions, keyTakeaways: generated.keyTakeaways, unresolvedQuestions: generated.unresolvedQuestions, transcriptSegmentCount: transcripts.length, generationStatus: 'completed', generationError: undefined, generatedAt: new Date() });
    await summary.save();

    const memberships = await WorkspaceMember.find({ workspaceId }).select('userId').lean();
    const memberIds = new Set(memberships.map((m: any) => String(m.userId)));
    for (const item of generated.actionItems) {
      const assigneeId = item.assigneeSpeakerId && memberIds.has(item.assigneeSpeakerId) ? item.assigneeSpeakerId : null;
      const speaker = speakers.find((s) => s.id === assigneeId);
      const normalized = item.taskDescription.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const dedupeKey = createHash('sha256').update(`${normalized}|${item.evidence.toLowerCase().trim()}`).digest('hex');
      try {
        await MeetingActionItem.updateOne({ meetingId, dedupeKey }, { $setOnInsert: { meetingId, workspaceId, summaryId: summary._id, dedupeKey, taskDescription: item.taskDescription, assigneeId, assigneeName: speaker?.name, assigneeEvidence: assigneeId ? item.assigneeEvidence : undefined, dueDate: item.dueDate ? new Date(`${item.dueDate}T00:00:00.000Z`) : null, dueDateEvidence: item.dueDate ? item.dueDateEvidence : undefined, evidence: item.evidence, evidenceSegmentIds: transcripts.filter((segment: any) => segment.text.includes(item.evidence)).map((segment: any) => segment._id), status: ActionItemStatus.PENDING, source: 'ai' } }, { upsert: true });
      } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    }
    return summary;
  } catch (error) {
    await MeetingSummary.updateOne({ _id: summary._id }, { $set: { generationStatus: 'failed', generationError: 'Summary generation failed. Please retry.' } });
    throw error;
  }
}

function validateGeneratedNotes(notes: GeneratedMeetingNotes, transcript: string, speakers: Array<{ id: string; name: string }>, transcriptSegments: any[]) {
  if (!notes || typeof notes.overview !== 'string' || !Array.isArray(notes.actionItems) || !Array.isArray(notes.decisions) || !Array.isArray(notes.discussionPoints) || !Array.isArray(notes.keyTakeaways) || !Array.isArray(notes.unresolvedQuestions)) throw new SummaryError(502, 'Summary provider returned invalid meeting notes.');
  for (const item of notes.actionItems) {
    if (typeof item.taskDescription !== 'string' || item.taskDescription.length > 1000 || !item.taskDescription.trim() || typeof item.evidence !== 'string' || !item.evidence.trim() || !transcript.includes(item.evidence)) throw new SummaryError(502, 'Summary provider returned an action item without transcript evidence.');
    if (item.assigneeSpeakerId) {
      const person = speakers.find((speaker) => speaker.id === item.assigneeSpeakerId);
      const matchingSegment = transcriptSegments.find((segment) => item.assigneeEvidence && segment.text.includes(item.assigneeEvidence));
      const personMentioned = person && item.assigneeEvidence && [person.name, person.name.split(/\s+/)[0]].some((name) => name && item.assigneeEvidence.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
      if (!person || !matchingSegment || (String(matchingSegment.speakerId) !== person.id && !personMentioned)) { item.assigneeSpeakerId = null; item.assigneeEvidence = ''; }
    }
    if (item.dueDate) {
      let dateIsValid = false;
      if (/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)) {
        const date = new Date(`${item.dueDate}T00:00:00.000Z`);
        dateIsValid = !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === item.dueDate;
      }
      const evidence = item.dueDateEvidence?.toLocaleLowerCase() || '';
      const date = dateIsValid ? new Date(`${item.dueDate}T00:00:00.000Z`) : null;
      const month = date?.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLocaleLowerCase();
      const day = date?.getUTCDate();
      const explicitDateEvidence = Boolean(date && item.dueDateEvidence && transcript.includes(item.dueDateEvidence) && ((evidence.includes(item.dueDate) || (month && evidence.includes(month) && new RegExp(`\\b${day}\\b`).test(evidence)) || new RegExp(`\\b${day}[/-]${date.getUTCMonth() + 1}([/-]\\d{2,4})?\\b`).test(evidence))));
      if (!explicitDateEvidence) { item.dueDate = null; item.dueDateEvidence = ''; }
    }
  }
}
