import Meeting from '../models/Meeting.js';
import MeetingParticipant from '../models/MeetingParticipant.js';

describe('meeting invitation persistence constraints', () => {
  it('requires unique public meeting, join, and invitation identifiers', () => {
    for (const field of ['meetingCode', 'joinCode', 'invitationId']) {
      const schemaPath = Meeting.schema.path(field);
      expect(schemaPath).toBeDefined();
      expect(schemaPath.options.required).toBe(true);
      expect(schemaPath.options.unique).toBe(true);
    }
    expect(Meeting.schema.path('invitationId').options.select).toBe(false);
  });

  it('retains unique participant membership per meeting', () => {
    expect(MeetingParticipant.schema.indexes().some(([keys, options]) =>
      keys.meetingId === 1 && keys.userId === 1 && options.unique === true,
    )).toBe(true);
  });
});
