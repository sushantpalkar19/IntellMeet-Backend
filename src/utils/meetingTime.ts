/** Convert a timezone-local datetime (YYYY-MM-DDTHH:mm) to UTC without assuming server/browser zone. */
export function localDateTimeToUtc(value: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error('Use a valid local date and time.');
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second = 0] = timePart.split(':').map(Number);
  const nominal = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let candidate = nominal;
  const matchesLocal = (timestamp: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    return Number(parts.year) === year && Number(parts.month) === month && Number(parts.day) === day && Number(parts.hour) === hour && Number(parts.minute) === minute && Number(parts.second) === second;
  };
  for (let i = 0; i < 4; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    candidate += nominal - represented;
  }
  if (!matchesLocal(candidate)) {
    throw new Error('That local time does not exist in the selected time zone because of a daylight-saving transition.');
  }
  for (let offsetMinutes = -180; offsetMinutes <= 180; offsetMinutes += 15) {
    if (offsetMinutes !== 0 && matchesLocal(candidate + offsetMinutes * 60_000)) throw new Error('That local time occurs twice in the selected time zone because of a daylight-saving transition. Choose another time.');
  }
  return new Date(candidate);
}

export function isValidTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); return true; } catch { return false; }
}
