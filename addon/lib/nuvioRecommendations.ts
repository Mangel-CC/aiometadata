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

function toEpochMs(value: any): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** "tt123", "tt123:1:2" -> "tt123"; "tmdb:55" -> "tmdb:55"; lo demas (kitsu:, etc.) no sirve en v1. */
function baseId(contentId: string): string | null {
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
async function toTmdbId(id: string, kind: 'movie' | 'series', config: any): Promise<number | null> {
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

interface Seed { id: string; kind: 'movie' | 'series'; at: number }

async function computeRecommendations(target: NuvioTarget, config: any): Promise<{ main: RecItem[]; anime: RecItem[] }> {
  const [watched, progress] = await Promise.all([
    getWatchedItems(target.accountUUID, target.profileIndex),
    getWatchProgress(target.accountUUID, target.profileIndex),
  ]);

  // Todo lo visto o empezado se excluye; las semillas son lo visto de verdad.
  const seen = new Map<string, 'movie' | 'series'>();
  const seeds = new Map<string, Seed>();
  const addSeed = (id: string, kind: 'movie' | 'series', at: number) => {
    const prev = seeds.get(id);
    if (!prev || at > prev.at) seeds.set(id, { id, kind, at });
  };

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

  const recentSeeds = [...seeds.values()].sort((a, b) => b.at - a.at).slice(0, MAX_SEEDS);
  logger.info(`Perfil ${target.profileIndex}: ${watched.length} vistos, ${progress.length} en progreso, ${seeds.size} semillas (se usan ${recentSeeds.length})`);
  if (!recentSeeds.length) return { main: [], anime: [] };

  // Lo visto pasado a ids de TMDB, para poder descartarlo de las recomendaciones.
  const seenTmdb = new Set<string>();
  await mapWithConcurrency([...seen.entries()], 8, async ([id, kind]) => {
    const tmdbId = await toTmdbId(id, kind, config);
    if (tmdbId) seenTmdb.add(`${kind}:${tmdbId}`);
  });

  const scores = new Map<string, { item: RecItem; anime: boolean; seeds: number }>();
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
    // Las semillas mas recientes pesan mas (1 -> 0.5) y, dentro de cada lista, las primeras.
    const seedWeight = 1 - 0.5 * (rank / Math.max(1, recentSeeds.length - 1));
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
      } else {
        scores.set(key, { item: { tmdbId: result.id, type, score: points }, anime: isAnime(result), seeds: 1 });
      }
    });
  });

  const ranked = [...scores.values()].sort((a, b) => b.item.score - a.item.score);
  const main = ranked.filter(e => !e.anime).slice(0, MAX_ITEMS).map(e => e.item);
  const anime = ranked.filter(e => e.anime).slice(0, MAX_ITEMS).map(e => e.item);
  logger.success(`Perfil ${target.profileIndex}: ${main.length} recomendaciones y ${anime.length} de anime`);
  return { main, anime };
}

const computeInFlight = new Map<string, Promise<{ main: RecItem[]; anime: RecItem[] }>>();

/** Las dos listas del perfil, cacheadas 30 minutos. Si Nuvio falla, listas vacias. */
export async function getNuvioRecommendations(target: NuvioTarget, config: any): Promise<{ main: RecItem[]; anime: RecItem[] }> {
  const key = `nuvio:recs:v1:${target.accountUUID}:${target.profileIndex}`;
  const cached = await readGlobalCache(key);
  if (cached && Array.isArray(cached.main)) return cached;

  let flight = computeInFlight.get(key);
  if (!flight) {
    flight = (async () => {
      try {
        const lists = await computeRecommendations(target, config);
        await writeGlobalCache(key, lists, RECS_TTL);
        return lists;
      } catch (error: any) {
        logger.error(`No se pudieron armar las recomendaciones del perfil ${target.profileIndex}: ${error?.message}`);
        return { main: [], anime: [] };
      }
    })().finally(() => computeInFlight.delete(key));
    computeInFlight.set(key, flight);
  }
  return flight;
}

export default { resolveNuvioTarget, getNuvioRecommendations, NUVIO_RECOMMENDED_ID, NUVIO_RECOMMENDED_ANIME_ID };
