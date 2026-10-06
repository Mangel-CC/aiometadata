// "Recomendado para ti" desde el historial de un perfil de Nuvio (ver docs/specs/
// perfiles-recomendaciones-temporadas.md, 3.2).
//
// Semillas: lo marcado como visto, y lo que esta en progreso desde el 80 %. Para cada semilla
// reciente se piden las recomendaciones de TMDB; un titulo recomendado por varias semillas suma
// puntos. Todo lo visto o empezado (con cualquier porcentaje) se descarta. El resultado se separa
// en anime y el resto, cada uno en su catalogo.

import consola from 'consola';
import * as moviedb from './getTmdb.js';
import { cacheWrapGlobal, readGlobalCache, writeGlobalCache } from './getCache.js';
import { mapWithConcurrency } from '../utils/concurrency';
import { isAnime } from '../utils/isAnime';
import { getWatchedItems, getWatchProgress, hasNuvioSession } from './nuvio';

const logger = consola.withTag('NuvioRecs');

export const NUVIO_RECOMMENDED_ID = 'nuvio.recommended';
export const NUVIO_RECOMMENDED_ANIME_ID = 'nuvio.recommended.anime';

const WATCHED_THRESHOLD = Number(process.env.NUVIO_WATCHED_THRESHOLD || 0.8);
const MAX_SEEDS = Number(process.env.NUVIO_MAX_SEEDS || 40);
const RECS_TTL = Number(process.env.NUVIO_RECS_TTL || 30 * 60);
const FIND_TTL = 30 * 24 * 3600;
const MAX_ITEMS = 200;
const MIN_VOTES = 20;

export interface NuvioTarget {
  /** uuid de la configuracion principal, donde vive la sesion. */
  accountUUID: string;
  profileIndex: number;
}

export interface RecItem {
  tmdbId: number;
  type: 'movie' | 'series';
  score: number;
  /** Títulos vistos que más empujaron esta recomendación ("Porque viste…"). */
  because?: string[];
}

/**
 * A que cuenta y perfil corresponde una configuracion: una hija usa la sesion de su principal y su
 * propio nuvio.profileIndex; la principal es el perfil 1 salvo que diga otro.
 */
export async function resolveNuvioTarget(config: any, userUUID: string): Promise<NuvioTarget | null> {
  if (!userUUID) return null;
  const accountUUID = config?._inheritedFrom?.uuid || userUUID;
  const configured = Number(config?.nuvio?.profileIndex);
  const profileIndex = Number.isInteger(configured) && configured > 0
    ? configured
    : (config?._inheritedFrom ? 0 : 1);
  if (!profileIndex) return null;
  if (!(await hasNuvioSession(accountUUID))) return null;
  return { accountUUID, profileIndex };
}

export function toEpochMs(value: any): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** "tt123", "tt123:1:2" -> "tt123"; "tmdb:55" -> "tmdb:55"; lo demas (kitsu:, etc.) no sirve en v1. */
export function baseId(contentId: string): string | null {
  const id = String(contentId || '').trim();
  const imdb = /^(tt\d+)/.exec(id);
  if (imdb) return imdb[1];
  const tmdb = /^tmdb:(\d+)/.exec(id);
  if (tmdb) return `tmdb:${tmdb[1]}`;
  return null;
}

function kindOf(contentType: string): 'movie' | 'series' {
  return String(contentType || '').toLowerCase() === 'movie' ? 'movie' : 'series';
}

/** id de IMDb o tmdb:N -> id de TMDB del tipo pedido. Cacheado 30 dias: no cambia. */
export async function toTmdbId(id: string, kind: 'movie' | 'series', config: any): Promise<number | null> {
  if (id.startsWith('tmdb:')) return Number(id.slice(5)) || null;
  const result = await cacheWrapGlobal(`nuvio:find:${id}`, async () => {
    const found: any = await moviedb.find({ id, external_source: 'imdb_id' }, config);
    return {
      movie: found?.movie_results?.[0]?.id || null,
      tv: found?.tv_results?.[0]?.id || null,
    };
  }, FIND_TTL).catch(() => null);
  if (!result || result.error) return null;
  return (kind === 'movie' ? result.movie : result.tv) || (kind === 'movie' ? result.tv : result.movie) || null;
}

interface Candidate {
  item: RecItem;
  anime: boolean;
  seeds: number;
  genres: Set<number>;
  /** Temas que no son genero de TMDB pero que acaparan la lista (superheroes). */
  themes: Set<string>;
  /** La semilla que mas lo empujo: lo que sale de una misma semilla se parece entre si. */
  topSeed: string;
  topPoints: number;
}

// Variedad (ver spec 3.2.3). La lista por puntos sola se llena de "mas de lo mismo": diez
// recomendados de Marvel, o puras caricaturas, porque las recomendaciones de TMDB se quedan dentro
// de la misma familia y se refuerzan entre si. Se reordena para que, en cada bloque de 10, ningun
// tema ni ninguna semilla acapare; lo que se recorre no se pierde, baja.
const DIVERSITY_POOL = 400;
const WINDOW = 10;
const THEME_CAPS: Record<string, number> = {
  superhero: 2,
  animation: 3,
  kids: 2,
  anime: 2,
};
const SAME_SEED_CAP = 2;
const GENRE_SIMILARITY_PENALTY = 0.35;
const SUPERHERO_KEYWORDS = new Set([9715, 9717, 180547, 229266]); // superhero, based on comic, MCU, DCEU
const ANIMATION_GENRE = 16;
const KIDS_GENRES = new Set([10751, 10762]); // Family (cine), Kids (TV)

function themesOf(c: Candidate): string[] {
  const themes = [...c.themes];
  if (c.genres.has(ANIMATION_GENRE)) themes.push('animation');
  if ([...c.genres].some(g => KIDS_GENRES.has(g))) themes.push('kids');
  if (c.anime) themes.push('anime');
  return themes;
}

/** Marca superheroes con las palabras clave de TMDB (cacheadas 7 dias). */
async function tagThemes(candidates: Candidate[], config: any): Promise<void> {
  await mapWithConcurrency(candidates, 8, async (c) => {
    try {
      const data: any = c.item.type === 'movie'
        ? await moviedb.movieKeywords(String(c.item.tmdbId), config)
        : await moviedb.tvKeywords(String(c.item.tmdbId), config);
      const list: any[] = data?.keywords || data?.results || [];
      if (list.some(k => SUPERHERO_KEYWORDS.has(Number(k?.id)))) c.themes.add('superhero');
    } catch {
      // Sin palabras clave el titulo simplemente no cuenta como superheroes.
    }
  });
}

function genreSimilarity(a: Set<number>, b: Set<number>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Reordena en orden de puntos pero, en cada bloque de WINDOW, con tope por tema y por semilla, y
 * castigando lo que se parece en generos a lo recien elegido. Si nada cumple los topes (pool chico),
 * se toma el mejor sin topes para no dejar la lista corta.
 */
/** Topes del perfil: los de siempre, con lo que diga config.nuvio.themeCaps encima (p.ej. un nino). */
export function themeCapsFor(config: any): Record<string, number> {
  const caps = { ...THEME_CAPS };
  const own = config?.nuvio?.themeCaps;
  if (own && typeof own === 'object') {
    for (const [theme, value] of Object.entries(own)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) caps[theme] = n;
    }
  }
  return caps;
}

function diversify(pool: Candidate[], caps: Record<string, number>, ignoreThemes: string[] = []): Candidate[] {
  const remaining = [...pool];
  const out: Candidate[] = [];
  const maxScore = remaining[0]?.item.score || 1;
  while (remaining.length) {
    const recent = out.slice(-WINDOW);
    const themeCount = new Map<string, number>();
    const seedCount = new Map<string, number>();
    for (const c of recent) {
      for (const t of themesOf(c)) themeCount.set(t, (themeCount.get(t) || 0) + 1);
      seedCount.set(c.topSeed, (seedCount.get(c.topSeed) || 0) + 1);
    }
    const fits = (c: Candidate) =>
      (seedCount.get(c.topSeed) || 0) < SAME_SEED_CAP
      && themesOf(c).every(t => ignoreThemes.includes(t) || caps[t] === undefined || (themeCount.get(t) || 0) < caps[t]);
    const last = out.slice(-5);
    let bestIdx = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      if (!fits(c)) continue;
      const similarity = last.reduce((m, o) => Math.max(m, genreSimilarity(c.genres, o.genres)), 0);
      const value = c.item.score / maxScore - GENRE_SIMILARITY_PENALTY * similarity;
      if (value > bestValue) { bestValue = value; bestIdx = i; }
      // La lista viene ordenada por puntos: pasado cierto punto ya nada puede ganar.
      if (c.item.score / maxScore < bestValue) break;
    }
    if (bestIdx < 0) bestIdx = 0;
    out.push(remaining.splice(bestIdx, 1)[0]);
  }
  return out;
}

interface Seed { id: string; kind: 'movie' | 'series'; at: number; played: boolean }

/** Lo marcado a mano como visto (sin reproduccion en Nuvio) cuenta, pero mucho menos. */
const MANUAL_SEED_WEIGHT = Number(process.env.NUVIO_MANUAL_SEED_WEIGHT || 0.3);

async function computeRecommendations(target: NuvioTarget, config: any): Promise<{ main: RecItem[]; anime: RecItem[] }> {
  const [watched, progress] = await Promise.all([
    getWatchedItems(target.accountUUID, target.profileIndex),
    getWatchProgress(target.accountUUID, target.profileIndex),
  ]);
  if (process.env.NUVIO_RECS_ENGINE === 'v1') return computeFromHistory(watched, progress, target.profileIndex, config);
  try {
    // Motor v2 (docs/specs/motor-recomendaciones-v2.md). Se carga aquí para no crear una importación
    // circular (el v2 usa utilidades de este archivo).
    const { recommendV2 } = require('./recs/engine');
    return await recommendV2(watched, progress, config, { themeCaps: themeCapsFor(config) });
  } catch (error: any) {
    logger.error(`El motor v2 falló para el perfil ${target.profileIndex} (${error?.message}); se usa el v1`);
    return computeFromHistory(watched, progress, target.profileIndex, config);
  }
}

/** El motor v1 sobre un historial dado; separado para poder evaluarlo con historiales recortados. */
export async function computeFromHistory(watched: any[], progress: any[], profileIndex: number, config: any): Promise<{ main: RecItem[]; anime: RecItem[] }> {
  const target = { profileIndex };

  // Todo lo visto o empezado se excluye; las semillas son lo visto de verdad.
  const seen = new Map<string, 'movie' | 'series'>();
  const seeds = new Map<string, Seed>();
  const addSeed = (id: string, kind: 'movie' | 'series', at: number) => {
    const prev = seeds.get(id);
    if (!prev || at > prev.at) seeds.set(id, { id, kind, at, played: false });
  };

  // Lo que tiene registro de reproduccion se vio en Nuvio. Lo demas se marco a mano, muchas veces
  // de memoria y en rafagas (diez peliculas de Marvel en el mismo minuto): eso no dice que se haya
  // visto hace poco ni que sea lo que mas gusta, y como "lo mas reciente" se comia las semillas.
  const played = new Set<string>();
  for (const row of progress) {
    const id = baseId(row.content_id);
    if (id) played.add(id);
  }

  for (const row of watched) {
    const id = baseId(row.content_id);
    if (!id) continue;
    const kind = kindOf(row.content_type);
    seen.set(id, kind);
    addSeed(id, kind, toEpochMs(row.watched_at));
  }
  for (const row of progress) {
    const id = baseId(row.content_id);
    if (!id) continue;
    const kind = kindOf(row.content_type);
    seen.set(id, kind);
    const duration = Number(row.duration) || 0;
    const position = Number(row.position) || 0;
    // Pelicula al 80 %, o una serie con al menos un episodio al 80 %.
    if (duration > 0 && position / duration >= WATCHED_THRESHOLD) addSeed(id, kind, toEpochMs(row.last_watched));
  }

  for (const seed of seeds.values()) seed.played = played.has(seed.id);
  // Primero lo reproducido (por fecha) y despues lo marcado a mano, para completar.
  const recentSeeds = [...seeds.values()]
    .sort((a, b) => Number(b.played) - Number(a.played) || b.at - a.at)
    .slice(0, MAX_SEEDS);
  const playedCount = recentSeeds.filter(seed => seed.played).length;
  logger.info(`Perfil ${target.profileIndex}: ${watched.length} vistos, ${progress.length} en progreso, ${seeds.size} semillas (se usan ${recentSeeds.length}: ${playedCount} reproducidas, ${recentSeeds.length - playedCount} marcadas a mano)`);
  if (!recentSeeds.length) return { main: [], anime: [] };

  // Lo visto pasado a ids de TMDB, para poder descartarlo de las recomendaciones.
  const seenTmdb = new Set<string>();
  await mapWithConcurrency([...seen.entries()], 8, async ([id, kind]) => {
    const tmdbId = await toTmdbId(id, kind, config);
    if (tmdbId) seenTmdb.add(`${kind}:${tmdbId}`);
  });

  const scores = new Map<string, Candidate>();
  await mapWithConcurrency(recentSeeds, 6, async (seed, rank) => {
    const tmdbId = await toTmdbId(seed.id, seed.kind, config);
    if (!tmdbId) return;
    let data: any;
    try {
      data = seed.kind === 'movie'
        ? await moviedb.movieRecommendations({ id: tmdbId }, config)
        : await moviedb.tvRecommendations({ id: tmdbId }, config);
    } catch (error: any) {
      logger.debug(`Sin recomendaciones para ${seed.kind}:${tmdbId}: ${error?.message}`);
      return;
    }
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    // Las semillas reproducidas mas recientes pesan mas (1 -> 0.5), las marcadas a mano poco, y
    // dentro de cada lista, las primeras.
    const seedWeight = seed.played
      ? 1 - 0.5 * (rank / Math.max(1, playedCount - 1))
      : MANUAL_SEED_WEIGHT;
    results.forEach((result, position) => {
      if (!result?.id) return;
      if ((Number(result.vote_count) || 0) < MIN_VOTES) return;
      // /movie/{id}/recommendations solo da peliculas y /tv/{id}/recommendations solo series.
      const type = seed.kind;
      const key = `${type}:${result.id}`;
      if (seenTmdb.has(key)) return;
      const points = seedWeight * (1 - position / (results.length * 2));
      const entry = scores.get(key);
      if (entry) {
        entry.item.score += points;
        entry.seeds += 1;
        if (points > entry.topPoints) { entry.topPoints = points; entry.topSeed = seed.id; }
      } else {
        scores.set(key, {
          item: { tmdbId: result.id, type, score: points },
          anime: isAnime(result),
          seeds: 1,
          genres: new Set<number>((result.genre_ids || []).map(Number)),
          themes: new Set<string>(),
          topSeed: seed.id,
          topPoints: points,
        });
      }
    });
  });

  const ranked = [...scores.values()].sort((a, b) => b.item.score - a.item.score);
  const mainPool = ranked.filter(e => !e.anime).slice(0, DIVERSITY_POOL);
  const animePool = ranked.filter(e => e.anime).slice(0, DIVERSITY_POOL);
  await tagThemes([...mainPool, ...animePool], config);
  const caps = themeCapsFor(config);
  const main = diversify(mainPool, caps).slice(0, MAX_ITEMS).map(e => e.item);
  const anime = diversify(animePool, caps, ['animation', 'kids']).slice(0, MAX_ITEMS).map(e => e.item);
  logger.success(`Perfil ${target.profileIndex}: ${main.length} recomendaciones y ${anime.length} de anime`);
  return { main, anime };
}

const computeInFlight = new Map<string, Promise<{ main: RecItem[]; anime: RecItem[] }>>();

/** Las dos listas del perfil, cacheadas 30 minutos. Si Nuvio falla, listas vacias. */
/** Una copia vieja de la lista se guarda una semana para mostrarla mientras se recalcula la nueva. */
const STALE_TTL = 7 * 24 * 3600;

/**
 * Las dos listas del perfil. Frescas por 30 minutos; vencidas, se devuelve la anterior al instante y se
 * recalcula en segundo plano (el cálculo del v2 puede tardar la primera vez). Si Nuvio falla, vacías.
 */
export async function getNuvioRecommendations(target: NuvioTarget, config: any): Promise<{ main: RecItem[]; anime: RecItem[] }> {
  const key = `nuvio:recs:v5:${target.accountUUID}:${target.profileIndex}:${JSON.stringify(themeCapsFor(config))}`;
  const staleKey = `${key}:stale`;
  const cached = await readGlobalCache(key);
  if (cached && Array.isArray(cached.main)) return cached;

  let flight = computeInFlight.get(key);
  if (!flight) {
    flight = (async () => {
      try {
        const lists = await computeRecommendations(target, config);
        await writeGlobalCache(key, lists, RECS_TTL);
        await writeGlobalCache(staleKey, lists, STALE_TTL);
        return lists;
      } catch (error: any) {
        logger.error(`No se pudieron armar las recomendaciones del perfil ${target.profileIndex}: ${error?.message}`);
        return { main: [], anime: [] };
      }
    })().finally(() => computeInFlight.delete(key));
    computeInFlight.set(key, flight);
  }
  const stale = await readGlobalCache(staleKey);
  if (stale && Array.isArray(stale.main)) return stale;
  return flight;
}

export default { resolveNuvioTarget, getNuvioRecommendations, NUVIO_RECOMMENDED_ID, NUVIO_RECOMMENDED_ANIME_ID };
