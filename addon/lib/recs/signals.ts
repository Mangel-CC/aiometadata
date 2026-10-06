// Señales del motor v2 (docs/specs/motor-recomendaciones-v2.md, 3.1): cuánto gustó cada título,
// deducido de cómo se vio, porque Nuvio no guarda calificaciones.

import { baseId, toEpochMs } from '../nuvioRecommendations';

const DAY = 86400000;

export interface TitleSignal {
  /** tt… o tmdb:N */
  id: string;
  /** Título como lo guarda Nuvio (en el idioma de la app). */
  title: string;
  kind: 'movie' | 'series';
  /** −1 … +1 */
  like: number;
  /** 0 … 1: cuánto pesa por lo reciente. */
  timeWeight: number;
  /** Hubo reproducción en Nuvio (si no, se marcó a mano). */
  played: boolean;
  /** Primera y última interacción conocidas (ms). Lo marcado a mano solo tiene la fecha del marcado. */
  firstAt: number;
  lastAt: number;
  /** Episodios vistos al 80 % (series). */
  episodes: number;
  /** Visto o empezado: se excluye de las recomendaciones, con cualquier gusto. */
  seen: true;
}

export interface SignalOptions {
  now?: number;
  watchedThreshold?: number;
  manualLike?: number;
  manualTimeWeight?: number;
  halfLifeDays?: number;
  timeFloor?: number;
}

const DEFAULTS: Required<Omit<SignalOptions, 'now'>> = {
  watchedThreshold: 0.8,
  manualLike: 0.9,
  manualTimeWeight: 0.7,
  halfLifeDays: 365,
  timeFloor: 0.35,
};

function kindOf(contentType: string): 'movie' | 'series' {
  return String(contentType || '').toLowerCase() === 'movie' ? 'movie' : 'series';
}

/** De 1 episodio (+0.6) a ~10 o más (+1.0). */
function seriesLike(episodes: number): number {
  if (episodes <= 0) return 0;
  return Math.min(1, 0.6 + 0.4 * Math.log10(Math.max(1, episodes)));
}

export function buildSignals(watched: any[], progress: any[], options: SignalOptions = {}): Map<string, TitleSignal> {
  const o = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();

  interface Acc {
    kind: 'movie' | 'series';
    watchedEpisodes: Set<string>;
    watchedMovie: boolean;
    watchedAt: number[];
    progress: Array<{ completion: number; at: number; episodeKey: string }>;
    title: string;
  }
  const acc = new Map<string, Acc>();
  const get = (id: string, kind: 'movie' | 'series') => {
    let a = acc.get(id);
    if (!a) {
      a = { kind, watchedEpisodes: new Set(), watchedMovie: false, watchedAt: [], progress: [], title: '' };
      acc.set(id, a);
    }
    return a;
  };

  for (const row of watched) {
    const id = baseId(row.content_id);
    if (!id) continue;
    const a = get(id, kindOf(row.content_type));
    if (!a.title && row.title) a.title = String(row.title);
    if (a.kind === 'movie') a.watchedMovie = true;
    else a.watchedEpisodes.add(`${row.season ?? 0}:${row.episode ?? 0}`);
    const at = toEpochMs(row.watched_at);
    if (at) a.watchedAt.push(at);
  }
  for (const row of progress) {
    const id = baseId(row.content_id);
    if (!id) continue;
    const a = get(id, kindOf(row.content_type));
    const duration = Number(row.duration) || 0;
    const completion = duration > 0 ? Math.min(1, (Number(row.position) || 0) / duration) : 0;
    a.progress.push({ completion, at: toEpochMs(row.last_watched), episodeKey: `${row.season ?? 0}:${row.episode ?? 0}` });
  }

  const out = new Map<string, TitleSignal>();
  for (const [id, a] of acc) {
    const played = a.progress.length > 0;
    const times = [...a.watchedAt, ...a.progress.map(p => p.at)].filter(Boolean);
    const firstAt = times.length ? Math.min(...times) : 0;
    const lastAt = times.length ? Math.max(...times) : 0;
    const daysSince = lastAt ? (now - lastAt) / DAY : Infinity;

    let like = 0;
    let episodes = 0;
    if (a.kind === 'movie') {
      const best = a.progress.reduce((m, p) => Math.max(m, p.completion), 0);
      if (played && best >= o.watchedThreshold) like = 1;
      else if (a.watchedMovie) like = played ? 1 : o.manualLike;
      else if (played && best >= 0.15 && daysSince > 30) like = -0.6;
      else like = 0; // empezada hace poco, o < 15 % y nunca retomada
    } else {
      const done = new Set(a.watchedEpisodes);
      for (const p of a.progress) if (p.completion >= o.watchedThreshold) done.add(p.episodeKey);
      episodes = done.size;
      if (episodes > 0) {
        like = seriesLike(episodes);
        if (!played) like = Math.min(like, o.manualLike);
      }
      if (episodes <= 2 && played && daysSince > 45) {
        const anyLong = a.progress.some(p => p.completion >= 0.15);
        if (anyLong || episodes > 0) like = -0.4;
      }
    }

    // Lo marcado a mano no tiene fecha real: peso de tiempo fijo, no el de la fecha del marcado.
    const timeWeight = played
      ? Math.max(o.timeFloor, Math.pow(0.5, Math.max(0, (now - lastAt) / DAY) / o.halfLifeDays))
      : o.manualTimeWeight;

    out.set(id, { id, title: a.title, kind: a.kind, like, timeWeight, played, firstAt, lastAt, episodes, seen: true });
  }
  return out;
}

/** Recorta el historial a lo ocurrido antes de `cutoff` (para evaluar sin ver el futuro). */
export function historyBefore(watched: any[], progress: any[], cutoff: number): { watched: any[]; progress: any[] } {
  return {
    watched: watched.filter(r => toEpochMs(r.watched_at) < cutoff),
    progress: progress.filter(r => toEpochMs(r.last_watched) < cutoff),
  };
}
