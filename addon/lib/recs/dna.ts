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

export type KeywordKind = 'theme' | 'tone' | 'place' | 'meta';

// TMDB mezcla en las palabras clave temas de la historia ("magic", "time travel", "zombie") con
// adjetivos de tono ("amused", "hopeful"), lugares y épocas ("washington dc", "1980s") y datos de
// producción ("sequel", "based on novel or book"). Para decir que dos títulos "tratan de lo mismo"
// solo cuentan los temas.
const TONE = new Set(`absurd admiring adoring aggressive ambiguous amazed amused angry antagonistic anxious appreciative
approving assertive audacious awestruck baffled bewildered bold callous candid cautionary celebratory cheerful
comforting compassionate complex critical cruel curious defiant demeaning depressing derisive desperate
disdainful disheartening disgusted distressing dramatic earnest embarrassed empathetic enchanted energetic
enthusiastic euphoric excited exhilarated exuberant factual familiar foreboding frantic frustrated gloomy grim
harsh hilarious hopeful horrified incredulous informative inquisitive inspirational intense introspective
ironic joyful joyous lighthearted macabre melancholy mischievous mocking nostalgic ominous optimistic
outrageous pessimistic philosophical playful powerful pretentious provocative quirky rebellious reflective
regretful relaxed respectful sad sarcastic satirical scary sentimental serious shocking silly sincere skeptical
sneering somber straightforward suspenseful suspicious sympathetic tender tense thoughtful thrilling tragic
unassuming urgent vibrant whimsical wistful witty zany`.split(/\s+/));
const TONE_PHRASES = new Set(['matter of fact', 'mean spirited', 'tearjerker', 'feel good', 'mind bending']);
const META_PREFIXES = ['based on ', 'remake', 'reboot', 'sequel', 'prequel', 'spin off', 'spin-off', 'live action remake'];
const META = new Set(['duringcreditsstinger', 'aftercreditsstinger', 'woman director', 'anime', 'independent film',
  'short film', '3d animation', 'cgi', 'cgi animation', 'stop motion', 'anthology', 'miniseries', 'black and white',
  'silent film', 'sitcom', 'mockumentary', 'documentary', 'animation', 'adult animation', 'live action and animation',
  'shounen', 'shoujo', 'seinen', 'josei', 'manga', 'light novel', 'web novel', 'gay theme', 'lgbt']);
const PLACE_WORDS = /\b(city|state|county|province|island|islands|republic|kingdom|america|europe|asia|africa|usa|u\.s\.a\.|england|london|paris|tokyo|new york|los angeles|chicago|washington|california|texas|florida|mexico|japan|korea|china|france|germany|italy|spain|russia|canada|australia|brazil|india|ireland|scotland|las vegas|san francisco|boston|miami|seoul|hong kong|berlin|rome|moscow)\b/;

export function classifyKeyword(name: string): KeywordKind {
  const n = name.trim().toLowerCase();
  if (!n) return 'meta';
  if (TONE.has(n) || TONE_PHRASES.has(n)) return 'tone';
  if (META.has(n) || META_PREFIXES.some(p => n.startsWith(p))) return 'meta';
  // "paris, france", "1980s", "19th century", "new york city", "small town texas"
  if (n.includes(', ') || /^\d{3,4}s$/.test(n) || /^\d{1,2}(st|nd|rd|th) century$/.test(n) || PLACE_WORDS.test(n)) return 'place';
  return 'theme';
}

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
  /** Qué es cada palabra clave: tema de la historia, tono, lugar/época o dato de producción. */
  keywordKinds: Record<number, KeywordKind>;
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
  const result = await cacheWrapGlobal(`recs:dna:v3:${type}:${tmdbId}`, async () => {
    const params = { id: tmdbId, language: 'en-US', append_to_response: 'keywords,credits' };
    const d: any = type === 'movie' ? await moviedb.movieInfo(params, config) : await moviedb.tvInfo(params, config);
    if (!d?.id) return { missing: true };
    const rawKeywords: any[] = (d.keywords?.keywords || d.keywords?.results || []) as any[];
    const keywords: number[] = rawKeywords.map(k => Number(k.id)).filter(Boolean);
    const keywordKinds: Record<number, KeywordKind> = {};
    for (const k of rawKeywords) if (k?.id) keywordKinds[Number(k.id)] = classifyKeyword(String(k.name || ''));
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
      keywordKinds,
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
