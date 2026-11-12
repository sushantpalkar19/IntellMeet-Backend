import { createHmac, timingSafeEqual } from 'crypto';

type PlaybackClaims = { recordingId: string; userId: string; action: 'play' | 'download'; expiresAt: number };
function key(): string { if (!process.env.JWT_SECRET) throw new Error('Recording access signing is not configured'); return createHmac('sha256', process.env.JWT_SECRET).update('intellmeet-recording-access-v1').digest('hex'); }
export function createPlaybackToken(claims: PlaybackClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', key()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
export function verifyPlaybackToken(token: string): PlaybackClaims | null {
  try {
    if (token.length > 2048) return null;
    const [payload, signature] = token.split('.'); if (!payload || !signature) return null;
    const expected = createHmac('sha256', key()).update(payload).digest(); const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as PlaybackClaims;
    if (!/^[a-f\d]{24}$/i.test(claims.recordingId) || !claims.userId || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= Date.now() || !['play', 'download'].includes(claims.action)) return null;
    return claims;
  } catch { return null; }
}
