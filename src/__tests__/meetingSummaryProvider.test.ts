const mockCreate = jest.fn();
jest.mock('openai', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })) }));
import OpenAI from 'openai';
import { GroqMeetingSummaryProvider } from '../services/meetingSummaryProvider.js';

describe('Groq meeting summary provider', () => {
  const key = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_CHAT_MODEL;
  afterEach(() => { if (key === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = key; if (model === undefined) delete process.env.GROQ_CHAT_MODEL; else process.env.GROQ_CHAT_MODEL = model; jest.clearAllMocks(); });
  it('uses the backend key, configured chat model and strict structured output', async () => {
    process.env.GROQ_API_KEY = 'test-only-key'; process.env.GROQ_CHAT_MODEL = 'openai/gpt-oss-20b';
    mockCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ overview: 'A summary', detailedSummary: '', discussionPoints: [], decisions: [], keyTakeaways: [], unresolvedQuestions: [], actionItems: [] }) } }] });
    await new GroqMeetingSummaryProvider().generate({ meetingTitle: 'Test', meetingDate: '2026-12-01', transcript: 'Transcript', speakers: [] });
    expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-only-key', baseURL: 'https://api.groq.com/openai/v1', maxRetries: 0 }));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-oss-20b', response_format: expect.objectContaining({ json_schema: expect.objectContaining({ strict: true }) }) }));
  });
  it('surfaces provider failures for safe retry by the caller', async () => {
    process.env.GROQ_API_KEY = 'test-only-key'; mockCreate.mockRejectedValue(new Error('temporary error'));
    await expect(new GroqMeetingSummaryProvider().generate({ meetingTitle: 'Test', meetingDate: '2026-12-01', transcript: 'Transcript', speakers: [] })).rejects.toThrow('temporary error');
  });
});
