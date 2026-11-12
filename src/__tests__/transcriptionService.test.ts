const mockTranscriptionCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: class MockOpenAI {
    audio = { transcriptions: { create: mockTranscriptionCreate } };
  },
}));

import { transcribeAudio } from '../services/transcription.js';

describe('configurable transcription provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TRANSCRIPTION_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'test-key-never-real';
    process.env.GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
    process.env.GROQ_TRANSCRIPTION_LANGUAGE = 'auto';
    delete process.env.OPENAI_TRANSCRIPTION_MODEL;
    delete process.env.GROQ_TRANSCRIPTION_LANGUAGE;
  });

  it('uses the current general transcription model and retries transient provider failures', async () => {
    const transient = Object.assign(new Error('temporary'), { status: 503 });
    mockTranscriptionCreate.mockRejectedValueOnce(transient).mockResolvedValueOnce({ text: 'Recognized words', segments: [{ text: 'Recognized words', start: 0.5, end: 1.25 }] });
    await expect(transcribeAudio(Buffer.from('short test audio'), 'audio/webm')).resolves.toEqual({ text: 'Recognized words', segments: [{ text: 'Recognized words', start: 0.5, end: 1.25 }] });
    expect(mockTranscriptionCreate).toHaveBeenCalledTimes(2);
    expect(mockTranscriptionCreate).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'whisper-large-v3-turbo', file: expect.any(File), response_format: 'verbose_json', timestamp_granularities: ['segment'] }));
    expect(mockTranscriptionCreate.mock.lastCall?.[0]).not.toHaveProperty('language');
  });

  it('fails closed when the server-side API key is not configured', async () => {
    delete process.env.GROQ_API_KEY;
    await expect(transcribeAudio(Buffer.from('audio'), 'audio/webm')).rejects.toThrow('not configured');
  });

  it.each(['hi', 'en'])('forwards the configured %s language to Groq', async (language) => {
    process.env.GROQ_TRANSCRIPTION_LANGUAGE = language;
    mockTranscriptionCreate.mockResolvedValueOnce({ text: 'recognized', segments: [] });
    await transcribeAudio(Buffer.from('speech'), 'audio/webm');
    expect(mockTranscriptionCreate).toHaveBeenCalledWith(expect.objectContaining({ language }));
  });

  it('does not retry exhausted free-tier quota errors immediately', async () => {
    mockTranscriptionCreate.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));
    await expect(transcribeAudio(Buffer.from('speech'), 'audio/webm')).rejects.toMatchObject({ status: 429 });
    expect(mockTranscriptionCreate).toHaveBeenCalledTimes(1);
  });
});
