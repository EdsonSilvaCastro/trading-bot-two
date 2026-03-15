import { Killzone } from '../types';

/**
 * Returns the ICT killzone for a given UTC datetime.
 * LONDON:    02:00 - 05:00 UTC
 * NEW_YORK:  07:00 - 10:00 UTC
 * ASIA:      20:00 - 00:00 UTC
 * OFF_SESSION: everything else
 */
export function getKillzone(date: Date = new Date()): Killzone {
  const hour = date.getUTCHours();
  if (hour >= 2 && hour < 5) return 'LONDON';
  if (hour >= 7 && hour < 10) return 'NEW_YORK';
  if (hour >= 20 || hour < 1) return 'ASIA';
  return 'OFF_SESSION';
}

/**
 * Returns the day of week abbreviation in UTC.
 */
export function getDayOfWeek(date: Date = new Date()): string {
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return days[date.getUTCDay()];
}
