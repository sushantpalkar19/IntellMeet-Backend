import { isValidTimeZone, localDateTimeToUtc } from '../utils/meetingTime.js';

describe('meeting timezone conversion', () => {
  it('converts local times with an explicit IANA zone to UTC', () => {
    expect(localDateTimeToUtc('2026-11-12T09:30', 'Asia/Kolkata').toISOString()).toBe('2026-11-12T04:00:00.000Z');
  });

  it('rejects nonexistent daylight-saving local times and invalid zones', () => {
    expect(() => localDateTimeToUtc('2026-03-08T02:30', 'America/New_York')).toThrow(/daylight-saving/);
    expect(() => localDateTimeToUtc('2026-11-01T01:30', 'America/New_York')).toThrow(/occurs twice/);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
  });
});
