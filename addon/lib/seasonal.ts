// Catalogos de temporada: aparecen y desaparecen solos segun la fecha (ver docs/specs/
// perfiles-recomendaciones-temporadas.md).
//
// La ventana se evalua en la zona horaria de la configuracion, no en UTC: a las 19:00 del 30 de
// noviembre en Mexico ya es 1 de diciembre en UTC, y el catalogo de Navidad aparecia un dia antes
// de tiempo (y Halloween desaparecia un dia antes).

import consola from 'consola';

const logger = consola.withTag('Seasonal');

export const DEFAULT_SEASONAL_TZ = 'America/Mexico_City';

export interface SeasonalWindow {
  /** "MM-DD" */
  from: string;
  /** "MM-DD", inclusive. Puede ser menor que `from`: la ventana cruza el fin de ano. */
  to: string;
}

function parseMonthDay(value: string): { month: number; day: number } | null {
  const match = /^(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

/** Fecha civil (ano, mes, dia) en la zona horaria pedida, sin depender de la del servidor. */
export function civilDateIn(tz: string, now: Date = new Date()): { year: number; month: number; day: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
  } catch {
    logger.warn(`Zona horaria invalida "${tz}"; se usa ${DEFAULT_SEASONAL_TZ}`);
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_SEASONAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
  }
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** ¿La fecha de hoy (en esa zona) cae dentro de la ventana? */
export function isWithinWindow(window: SeasonalWindow | undefined, tz: string = DEFAULT_SEASONAL_TZ, now: Date = new Date()): boolean {
  if (!window) return true;
  const from = parseMonthDay(window.from);
  const to = parseMonthDay(window.to);
  if (!from || !to) {
    logger.warn(`Ventana invalida ${JSON.stringify(window)}; el catalogo se deja visible`);
    return true;
  }
  const today = civilDateIn(tz, now);
  const asNumber = (m: number, d: number) => m * 100 + d;
  const cur = asNumber(today.month, today.day);
  const start = asNumber(from.month, from.day);
  const end = asNumber(to.month, to.day);
  // Ventana normal (Halloween: 10-01..11-15) o que cruza el ano (Navidad: 12-01..01-06).
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
}

/**
 * Cuantos segundos faltan para el proximo cambio de ventana (medianoche local del dia en que
 * alguna ventana empieza o termina). El manifest se cachea como mucho ese tiempo, para que un
 * catalogo de temporada no se quede pegado despues de su fecha.
 */
export function secondsUntilNextWindowChange(
  windows: Array<SeasonalWindow | undefined>,
  tz: string = DEFAULT_SEASONAL_TZ,
  now: Date = new Date(),
  maxSeconds: number = 6 * 3600,
): number {
  const states = windows.map(w => isWithinWindow(w, tz, now));
  const DAY_MS = 24 * 3600 * 1000;
  // Se busca dia por dia (como mucho el horizonte de maxSeconds) el primero en que algun
  // catalogo cambia de estado; el corte real es la medianoche local de ese dia.
  const horizonDays = Math.ceil(maxSeconds / 86400) + 1;
  for (let i = 1; i <= horizonDays; i++) {
    const probe = new Date(now.getTime() + i * DAY_MS);
    const changed = windows.some((w, idx) => isWithinWindow(w, tz, probe) !== states[idx]);
    if (!changed) continue;
    const secondsToLocalMidnight = secondsUntilLocalMidnight(tz, now) + (i - 1) * 86400;
    return Math.max(60, Math.min(maxSeconds, secondsToLocalMidnight));
  }
  return maxSeconds;
}

function secondsUntilLocalMidnight(tz: string, now: Date): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const num = (type: string) => Number(parts.find(p => p.type === type)?.value || 0);
  const hour = num('hour') % 24;
  const elapsed = hour * 3600 + num('minute') * 60 + num('second');
  return Math.max(60, 86400 - elapsed);
}

export default { isWithinWindow, secondsUntilNextWindowChange, civilDateIn, DEFAULT_SEASONAL_TZ };
