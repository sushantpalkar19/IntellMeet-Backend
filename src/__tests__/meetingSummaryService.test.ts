const mockMeetingFind = jest.fn();
const mockTranscriptFind = jest.fn();
const mockSummaryFind = jest.fn();
const mockSummaryCreate = jest.fn();
const mockSummaryLock = jest.fn();
const mockSummaryUpdate = jest.fn();
const mockMembersFind = jest.fn();
const mockActionUpdate = jest.fn();
const mockGenerate = jest.fn();

jest.mock('../models/Meeting.js', () => ({ __esModule: true, default: { findById: mockMeetingFind } }));
jest.mock('../models/MeetingTranscript.js', () => ({ __esModule: true, default: { find: mockTranscriptFind } }));
jest.mock('../models/MeetingSummary.js', () => ({ __esModule: true, default: { findOne: mockSummaryFind, create: mockSummaryCreate, findOneAndUpdate: mockSummaryLock, updateOne: mockSummaryUpdate } }));
jest.mock('../models/MeetingActionItem.js', () => ({ __esModule: true, ActionItemStatus: { PENDING: 'PENDING' }, default: { updateOne: mockActionUpdate } }));
jest.mock('../models/WorkspaceMember.js', () => ({ __esModule: true, default: { find: mockMembersFind } }));
jest.mock('../services/meetingSummaryProvider.js', () => ({ getMeetingSummaryProvider: () => ({ generate: mockGenerate }) }));

import { generateMeetingNotes, SummaryError } from '../services/meetingSummaryService.js';

const transcripts = [
  { _id: 'segment-1', speakerId: 'speaker-1', speakerName: 'Ari Example', text: 'Ari will prepare the revised budget report by December 12. The team also discussed the customer launch schedule and agreed to review risks next week.', startAt: new Date() },
];
const notes = {
  overview: 'The team reviewed the launch schedule.', detailedSummary: 'The group agreed to review risks.', discussionPoints: ['Customer launch schedule'],
  decisions: ['Review risks next week'], keyTakeaways: ['Budget report needed'], unresolvedQuestions: [],
  actionItems: [{ taskDescription: 'Prepare the revised budget report', assigneeSpeakerId: 'speaker-1', assigneeEvidence: 'Ari will prepare the revised budget report', dueDate: '2026-12-12', dueDateEvidence: 'by December 12', evidence: 'Ari will prepare the revised budget report by December 12' }],
};
let summaryDoc: any;
beforeEach(() => {
  jest.clearAllMocks();
  mockMeetingFind.mockResolvedValue({ _id: 'meeting-1', workspaceId: 'workspace-1', title: 'Planning', startedAt: new Date('2026-12-01'), createdAt: new Date('2026-11-30') });
  mockTranscriptFind.mockReturnValue({ sort: () => ({ lean: async () => transcripts }) });
  mockSummaryFind.mockResolvedValue(null);
  summaryDoc = { _id: 'summary-1', save: jest.fn().mockResolvedValue(undefined) };
  mockSummaryCreate.mockImplementation(async (value) => Object.assign(summaryDoc, value));
  mockSummaryLock.mockResolvedValue(summaryDoc);
  mockSummaryUpdate.mockResolvedValue({});
  mockMembersFind.mockReturnValue({ select: () => ({ lean: async () => [{ userId: 'speaker-1' }] }) });
  mockActionUpdate.mockResolvedValue({});
  mockGenerate.mockResolvedValue(notes);
});

describe('meeting summary generation from persisted transcript', () => {
  it('stores structured notes and grounded action items with authenticated speaker assignment', async () => {
    const result = await generateMeetingNotes('meeting-1', 'host-1');
    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ meetingTitle: 'Planning', speakers: [{ id: 'speaker-1', name: 'Ari Example' }] }));
    expect(result.generationStatus).toBe('completed');
    expect(result.decisions).toEqual(notes.decisions);
    expect(mockActionUpdate).toHaveBeenCalledWith({ meetingId: 'meeting-1', dedupeKey: expect.any(String) }, { $setOnInsert: expect.objectContaining({ assigneeId: 'speaker-1', dueDate: expect.any(Date), status: 'PENDING', evidence: notes.actionItems[0].evidence }) }, { upsert: true });
  });

  it('rejects empty or insufficient transcript rather than asking the model to invent notes', async () => {
    mockTranscriptFind.mockReturnValue({ sort: () => ({ lean: async () => [] }) });
    await expect(generateMeetingNotes('meeting-1', 'host-1')).rejects.toMatchObject({ status: 422 });
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockSummaryCreate).not.toHaveBeenCalled();
  });

  it('prevents duplicate concurrent generations for the same meeting', async () => {
    mockSummaryFind.mockResolvedValue({ generationStatus: 'processing' });
    await expect(generateMeetingNotes('meeting-1', 'host-1')).rejects.toThrow('already being generated');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('upserts action items by a stable dedupe key across regeneration', async () => {
    mockSummaryFind.mockResolvedValueOnce(null).mockResolvedValueOnce(summaryDoc);
    await generateMeetingNotes('meeting-1', 'host-1');
    await generateMeetingNotes('meeting-1', 'host-1');
    expect(mockActionUpdate).toHaveBeenCalledTimes(2);
    expect(mockActionUpdate.mock.calls[0][0]).toEqual(mockActionUpdate.mock.calls[1][0]);
    expect(mockActionUpdate.mock.calls.every((call) => call[2].upsert === true)).toBe(true);
  });

  it('does not retain an assignee unless they are a transcript speaker with valid evidence', async () => {
    mockGenerate.mockResolvedValue({ ...notes, actionItems: [{ ...notes.actionItems[0], assigneeSpeakerId: 'unknown-speaker', assigneeEvidence: 'not in transcript', dueDate: '2026-12-12', dueDateEvidence: 'no such quote' }] });
    await generateMeetingNotes('meeting-1', 'host-1');
    expect(mockActionUpdate.mock.calls[0][1].$setOnInsert).toEqual(expect.objectContaining({ assigneeId: null, dueDate: null }));
  });

  it('records provider failure without destroying previous notes and allows a later retry', async () => {
    summaryDoc.generationStatus = 'completed'; summaryDoc.overview = 'Previous result';
    mockSummaryFind.mockResolvedValue(summaryDoc);
    mockSummaryLock.mockResolvedValue(summaryDoc);
    mockGenerate.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 })).mockResolvedValueOnce(notes);
    await expect(generateMeetingNotes('meeting-1', 'host-1')).rejects.toThrow('rate limited');
    expect(mockSummaryUpdate).toHaveBeenCalledWith({ _id: 'summary-1' }, { $set: { generationStatus: 'failed', generationError: 'Summary generation failed. Please retry.' } });
    expect(summaryDoc.overview).toBe('Previous result');
    await generateMeetingNotes('meeting-1', 'host-1');
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockActionUpdate).toHaveBeenCalledTimes(1);
  });

  it('rejects provider action items without a verbatim transcript evidence quote', async () => {
    mockGenerate.mockResolvedValue({ ...notes, actionItems: [{ ...notes.actionItems[0], evidence: 'unsupported statement' }] });
    await expect(generateMeetingNotes('meeting-1', 'host-1')).rejects.toBeInstanceOf(SummaryError);
    expect(mockActionUpdate).not.toHaveBeenCalled();
  });
});
