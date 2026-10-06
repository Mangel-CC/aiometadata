// Etiquetas de AniList para el ADN del anime (docs/specs/motor-recomendaciones-v2.md, 3.3).
//
// En TMDB el anime de temporada casi no tiene palabras clave ni votos, así que el perfil de contenido
// no podía distinguir un isekai de un drama escolar. AniList etiqueta cada estreno desde el primer día
// (Isekai, Reincarnation, Overpowered MC…). No hay tabla TMDB→AniList fiable para estrenos, así que se
// busca por título original y se acepta solo si el año coincide (±1). Cacheado 30 días por título.

import consola from 'consola';
import { cacheWrapGlobal, readGlobalCache } from '../getCache.js';
import type { Dna } from './dna';

const logger = consola.withTag('AniListTags');
const TTL = 30 * 24 * 3600;
const BATCH = 10;
const MIN_GAP_MS = 2500; // AniList limita a ~30 peticiones por minuto (a veces menos); un lote cada 2.5 s.

interface Tags { tags: Array<{ name: string; rank: number }>; genres: string[] }

const keyOf = (tmdbId: number) => `recs:anilist:v1:${tmdbId}`;
let lastCall = 0;

function gql(str: string): string {
  return JSON.stringify(str);
}

async function fetchBatch(items: Dna[], attempt = 0): Promise<Map<number, Tags | null>> {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const fields = 'id startDate { year } seasonYear genres tags { name rank isGeneralSpoiler isMediaSpoiler }';
  const query = `query {\n${items.map((d, i) => `  a${i}: Page(perPage: 3) { media(search: ${gql(d.originalTitle || d.title)}, type: ANIME, sort: SEARCH_MATCH) { ${fields} } }`).join('\n')}\n}`;
  const out = new Map<number, Tags | null>();
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) {
      // Se respeta su Retry-After (o un minuto) y se reintenta una sola vez.
      const retryAfter = Math.min(90, Number(res.headers.get('retry-after')) || 60);
      if (attempt >= 1) {
        logger.warn('AniList sigue pidiendo esperar (429); se deja para la próxima pasada');
        return out;
      }
      logger.warn(`AniList pidió esperar ${retryAfter} s (429)`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return fetchBatch(items, attempt + 1);
    }
    const json: any = await res.json();
    items.forEach((d, i) => {
      const media: any[] = json?.data?.[`a${i}`]?.media || [];
      const match = media.find(m => {
        const y = m.startDate?.year || m.seasonYear;
        return !d.year || !y || Math.abs(y - d.year) <= 1;
      });
      out.set(d.tmdbId, match ? {
        tags: (match.tags || []).filter((t: any) => !t.isGeneralSpoiler && !t.isMediaSpoiler).map((t: any) => ({ name: t.name, rank: Number(t.rank) || 0 })),
        genres: match.genres || [],
      } : null);
    });
  } catch (error: any) {
    logger.warn(`AniList falló: ${error.message}`);
  }
  return out;
}

/** Rellena anilistTags/anilistGenres de los ADN de anime (modifica los objetos). */
export async function attachAnilistTags(dnas: Dna[]): Promise<void> {
  const anime = dnas.filter(d => d.anime && (d.originalTitle || d.title));
  const missing: Dna[] = [];
  for (const d of anime) {
    const cached = await readGlobalCache(keyOf(d.tmdbId));
    if (cached && Array.isArray(cached.tags)) {
      d.anilistTags = cached.tags;
      d.anilistGenres = cached.genres || [];
    } else if (cached && cached.none) {
      // Ya se buscó y AniList no lo tiene.
    } else {
      missing.push(d);
    }
  }
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const found = await fetchBatch(batch);
    for (const d of batch) {
      if (!found.has(d.tmdbId)) continue; // error o 429: no se cachea, se intenta otra vez después
      const tags = found.get(d.tmdbId);
      await cacheWrapGlobal(keyOf(d.tmdbId), async () => tags || { none: true }, TTL);
      if (tags) {
        d.anilistTags = tags.tags;
        d.anilistGenres = tags.genres;
      }
    }
  }
  if (missing.length) logger.info(`AniList: ${missing.length} anime consultados, ${anime.length - missing.length} ya en caché`);
}
