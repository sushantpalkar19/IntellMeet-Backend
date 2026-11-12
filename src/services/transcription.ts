import OpenAI from 'openai';

export interface ProviderTranscriptSegment { text: string; start: number; end: number; }
export interface ProviderTranscript { text: string; segments: ProviderTranscriptSegment[]; }
export type TranscriptionProvider = 'groq' | 'openai';

let client: OpenAI | null = null;
let clientConfigKey = '';

function getProvider(): TranscriptionProvider {
  const provider = (process.env.TRANSCRIPTION_PROVIDER || 'groq').trim().toLowerCase();
  if (provider !== 'groq' && provider !== 'openai') throw new Error('Unsupported transcription provider');
  return provider;
}

function getClient(provider: TranscriptionProvider): OpenAI {
  const apiKey = provider === 'groq' ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error(`${provider === 'groq' ? 'Groq' : 'OpenAI'} transcription is not configured`);
  const baseURL = provider === 'groq' ? 'https://api.groq.com/openai/v1' : undefined;
  const configKey = `${provider}:${baseURL ?? 'default'}:${apiKey}`;
  if (!client || clientConfigKey !== configKey) {
    client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 30000 });
    clientConfigKey = configKey;
  }
  return client;
}

export async function transcribeAudio(audio: Buffer, mimeType: string): Promise<ProviderTranscript> {
  const provider = getProvider();
  const transcriptionClient = getClient(provider);
  const extension = mimeType.includes('webm') ? 'webm'
    : mimeType.includes('mp4') ? 'mp4'
      : mimeType.includes('wav') ? 'wav'
        : mimeType.includes('flac') ? 'flac'
          : mimeType.includes('mpeg') ? 'mpeg'
            : mimeType.includes('mpga') ? 'mpga'
              : mimeType.includes('mpegurl') ? 'mp3'
                : mimeType.includes('ogg') ? 'ogg' : 'mp3';
  const file = new File([new Uint8Array(audio)], `chunk.${extension}`, { type: mimeType });
  const model = provider === 'groq'
    ? (process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo')
    : (process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-transcribe');
  const language = (process.env.GROQ_TRANSCRIPTION_LANGUAGE || 'auto').trim().toLowerCase();
  if (provider === 'groq' && !['auto', 'hi', 'en'].includes(language)) throw new Error('GROQ_TRANSCRIPTION_LANGUAGE must be auto, hi, or en');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const options: Record<string, unknown> = {
        file,
        model,
        response_format: provider === 'groq' ? 'verbose_json' : 'json',
      };
      // Whisper models detect Hindi or English automatically when language is omitted.
      if (provider === 'groq' && language !== 'auto') options.language = language;
      if (provider === 'groq') options.timestamp_granularities = ['segment'];
      const response = await transcriptionClient.audio.transcriptions.create(options as any) as unknown as {
        text?: string;
        segments?: Array<{ text?: string; start?: number; end?: number }>;
      };
      const text = (response.text || '').trim();
      const segments = (response.segments || [])
        .filter((segment) => typeof segment.text === 'string' && segment.text.trim())
        .map((segment) => ({
          text: segment.text!.trim(),
          start: Math.max(0, Number(segment.start) || 0),
          end: Math.max(0, Number(segment.end) || 0),
        }))
        .filter((segment) => segment.end > segment.start);
      return { text, segments };
    } catch (error) {
      const status = (error as { status?: number }).status;
      // Exhausted free-tier quota should surface promptly. Do not burn more requests
      // by immediately retrying 429 responses.
      if (status === 429 || attempt === 2 || (status !== undefined && status !== 408 && status < 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw new Error('Transcription failed');
}
