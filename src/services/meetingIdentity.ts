import { randomBytes } from 'crypto';
import Meeting from '../models/Meeting.js';

export interface MeetingIdentity {
  meetingCode: string;
  joinCode: string;
  invitationId: string;
}

/** Generate collision-checked identifiers required by the Meeting schema. */
export async function generateMeetingIdentity(): Promise<MeetingIdentity> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const meetingCode = `IM-${randomBytes(4).toString('hex').toUpperCase()}`;
    const joinCode = randomBytes(4).toString('hex').toUpperCase();
    const invitationId = randomBytes(24).toString('base64url');
    const exists = await Meeting.exists({ $or: [{ meetingCode }, { joinCode }, { invitationId }] });
    if (!exists) return { meetingCode, joinCode, invitationId };
  }
  throw new Error('Could not generate a unique meeting invitation');
}
