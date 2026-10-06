// "ADN" de un título para el motor v2 (docs/specs/motor-recomendaciones-v2.md, 3.2 y 3.3): los rasgos
// que se comparan con el gusto del perfil, y la franquicia a la que pertenece. Sale de TMDB y se cachea
// 30 días ya reducido (sin el payload completo de créditos).

import * as moviedb from '../getTmdb.js';
import { cacheWrapGlobal } from '../getCache.js';
import { mapWithConcurrency } from '../../utils/concurrency';

const DNA_TTL = 30 * 24 * 3600;

/** Palabras clave de universos que cruzan colecciones de TMDB (MCU, DCEU…). */
const UNIVERSE_KEYWORDS: Record<number, string> = {
  180547: 'universe:mcu',
  229266: 'universe:dceu',
  // Agregar aqui solo ids verificados en TMDB (https://www.themoviedb.org/keyword/<id>).
};

export interface Dna {
  type: 'movie' | 'series';
  tmdbId: number;
  title: string;
  /** Título original (en japonés para el anime): con él se busca en AniList. */
  originalTitle: string;
  year: number | null;
  language: string | null;
  genres: number[];
  keywords: number[];
  /** Director (cine) o creadores (series). */
  directors: number[];
  /** Hasta 5 actores principales. */
  cast: number[];
  companies: number[];
  collection: number | null;
  /** Franquicia para saturación y variedad: universo > colección > el propio título. */
  franchise: string;
  voteAverage: number;
  voteCount: number;
  popularity: number;
  anime: boolean;
  /** Etiquetas de AniList (solo anime; ver anilistTags.ts), con su relevancia 0–100. */
  anilistTags: Array<{ name: string; rank: number }>;
  anilistGenres: string[];
}

function franchiseOf(type: string, tmdbId: number, collection: number | null, keywords: number[]): string {
  for (const k of keywords) if (UNIVERSE_KEYWORDS[k]) return UNIVERSE_KEYWORDS[k];
  if (collection) return `collection:${collection}`;
  return `${type}:${tmdbId}`;
}

export async function getDna(type: 'movie' | 'series', tmdbId: number, config: any): Promise<Dna | null> {
  const result = await cacheWrapGlobal(`recs:dna:v2:${type}:${tmdbId}`, async () => {
    const params = { id: tmdbId, language: 'en-US', append_to_response: 'keywords,credits' };
    const d: any = type === 'movie' ? await moviedb.movieInfo(params, config) : await moviedb.tvInfo(params, config);
    if (!d?.id) return { missing: true };
    const keywords: number[] = ((d.keywords?.keywords || d.keywords?.results || []) as any[]).map(k => Number(k.id)).filter(Boolean);
    const genres: number[] = (d.genres || []).map((g: any) => Number(g.id)).filter(Boolean);
    const directors: number[] = type === 'movie'
      ? (d.credits?.crew || []).filter((c: any) => c.job === 'Director').map((c: any) => Number(c.id))
      : (d.created_by || []).map((c: any) => Number(c.id));
    const cast: number[] = (d.credits?.cast || []).slice(0, 5).map((c: any) => Number(c.id));
    const companies: number[] = (d.production_companies || []).slice(0, 3).map((c: any) => Number(c.id));
    const collection = type === 'movie' ? Number(d.belongs_to_collection?.id) || null : null;
    const date = type === 'movie' ? d.release_date : d.first_air_date;
    const language = d.original_language || null;
    const dna: Dna = {
      type,
      tmdbId,
      title: d.title || d.name || '',
      originalTitle: d.original_title || d.original_name || '',
      year: date ? Number(String(date).slice(0, 4)) || null : null,
      language,
      genres,
      keywords,
      directors,
      cast,
      companies,
      collection,
      franchise: franchiseOf(type, tmdbId, collection, keywords),
      voteAverage: Number(d.vote_average) || 0,
      voteCount: Number(d.vote_count) || 0,
      popularity: Number(d.popularity) || 0,
      anime: genres.includes(16) && (language === 'ja' || (d.origin_country || []).includes('JP')),
      anilistTags: [],
      anilistGenres: [],
    };
    return dna;
  }, DNA_TTL).catch(() => null);
  if (!result || result.error || result.missing) return null;
  return result as Dna;
}

export async function getDnaMany(items: Array<{ type: 'movie' | 'series'; tmdbId: number }>, config: any, concurrency = 4): Promise<Map<string, Dna>> {
  const out = new Map<string, Dna>();
  await mapWithConcurrency(items, concurrency, async (it) => {
    const dna = await getDna(it.type, it.tmdbId, config);
    if (dna) out.set(`${it.type}:${it.tmdbId}`, dna);
  });
  return out;
}
