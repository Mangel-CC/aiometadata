// Motor de recomendaciones v2 (docs/specs/motor-recomendaciones-v2.md).
//
//   señales (cuánto gustó cada título)
//     → saturación por franquicia (15 de Marvel no valen 15 votos)
//     → candidatos de 4 fuentes: colaborativo (MovieLens), contenido (perfil de gusto),
//       TMDB (recomendaciones) y novedades afines
//     → ranking híbrido con pesos ajustados por evaluación
//     → variedad (topes por bloque de 10, 1 por franquicia)
//     → explicación ("Porque viste…")

import consola from 'consola';
import * as moviedb from '../getTmdb.js';
import { cacheWrapGlobal } from '../getCache.js';
import { mapWithConcurrency } from '../../utils/concurrency';
import { toTmdbId, type RecItem } from '../nuvioRecommendations';
import { buildSignals, type TitleSignal } from './signals';
import { getDna, getDnaMany, type Dna } from './dna';
import { movieNeighbors } from './movielens';
import { attachAnilistTags } from './anilistTags';

const logger = consola.withTag('RecsV2');

export interface Weights {
  /** Tendencia (popularidad actual en TMDB). */
  pop: number;
  cf: number;
  content: number;
  tmdb: number;
  quality: number;
  fresh: number;
}

// Ajustados con la evaluación del 2026-10-06 (ver motor-recomendaciones-v2-evaluacion.md).
export const DEFAULT_WEIGHTS: Weights = { cf: 0.2, content: 0.8, tmdb: 0.1, quality: 0.6, fresh: 1.5, pop: 0.4 };

export interface V2Options {
  weights?: Partial<Weights>;
  themeCaps?: Record<string, number>;
  now?: number;
  maxTmdbSeeds?: number;
}

export interface RecItemV2 extends RecItem {
  because?: string[];
}

/** Peso de cada familia de rasgos en el perfil de contenido. */
const FAMILY_WEIGHT: Record<string, number> = { g: 1.0, k: 1.4, d: 1.2, c: 0.6, co: 0.4, l: 0.8, e: 0.5, at: 1.4, ag: 0.8 };
const SUPERHERO_KEYWORDS = new Set([9715, 9717, 180547, 229266]);
const KIDS_GENRES = new Set([10751, 10762]);
const DEFAULT_CAPS: Record<string, number> = { superhero: 2, animation: 3, kids: 2, anime: 2 };
const FRANCHISE_CAP = 1;
const SAME_SEED_CAP = 2;
const WINDOW = 10;

/** Rasgos del ADN con su intensidad (1 salvo las etiquetas de AniList, que traen relevancia). */
function features(d: Dna): Map<string, number> {
  const f = new Map<string, number>();
  for (const g of d.genres) f.set(`g:${g}`, 1);
  for (const k of d.keywords) f.set(`k:${k}`, 1);
  for (const x of d.directors) f.set(`d:${x}`, 1);
  for (const x of d.cast) f.set(`c:${x}`, 1);
  for (const x of d.companies) f.set(`co:${x}`, 1);
  if (d.language) f.set(`l:${d.language}`, 1);
  if (d.year) f.set(`e:${Math.floor(d.year / 10) * 10}`, 1);
  for (const t of d.anilistTags || []) if (t.rank >= 40) f.set(`at:${t.name}`, t.rank / 100);
  for (const g of d.anilistGenres || []) f.set(`ag:${g}`, 1);
  return f;
}

function family(feature: string): string {
  return feature.slice(0, feature.indexOf(':'));
}

function keyOf(type: string, id: number): string {
  return `${type}:${id}`;
}

async function cachedDiscover(type: 'movie' | 'series', params: Record<string, any>, config: any): Promise<any[]> {
  const key = `recs:discover:v1:${type}:${JSON.stringify(params)}`;
  const data = await cacheWrapGlobal(key, () => (type === 'movie' ? moviedb.discoverMovie(params, config) : moviedb.discoverTv(params, config)), 24 * 3600).catch(() => null);
  return Array.isArray(data?.results) ? data.results : [];
}

function isoDaysAgo(days: number, now: number): string {
  return new Date(now - days * 86400000).toISOString().slice(0, 10);
}

interface Cand {
  type: 'movie' | 'series';
  tmdbId: number;
  cf: number;
  tmdb: number;
  /** Contribución por semilla (para la explicación y el tope por semilla). */
  seedContrib: Map<string, number>;
  fromContent: boolean;
  fromNew: boolean;
}

export async function prepareV2(watched: any[], progress: any[], config: any, opts: V2Options = {}): Promise<Prepared> {
  const now = opts.now ?? Date.now();
  const caps = { ...DEFAULT_CAPS, ...(opts.themeCaps || {}) };

  // 1. Señales y lo ya visto.
  const signals = buildSignals(watched, progress, { now });
  const seenKeys = new Set<string>();
  const seedList: Array<{ sig: TitleSignal; tmdbId: number }> = [];
  await mapWithConcurrency([...signals.values()], 4, async (sig) => {
    const tmdbId = await toTmdbId(sig.id, sig.kind, config);
    if (!tmdbId) return;
    seenKeys.add(keyOf(sig.kind, tmdbId));
    if (sig.like !== 0) seedList.push({ sig, tmdbId });
  });
  if (!seedList.some(s => s.sig.like > 0)) return { items: [], caps };

  // 2. ADN de lo visto y saturación por franquicia.
  const seedDna = await getDnaMany(seedList.map(s => ({ type: s.sig.kind, tmdbId: s.tmdbId })), config);
  await attachAnilistTags([...seedDna.values()]);
  const groups = new Map<string, number>();
  for (const s of seedList) {
    if (s.sig.like <= 0) continue;
    const fr = seedDna.get(keyOf(s.sig.kind, s.tmdbId))?.franchise || keyOf(s.sig.kind, s.tmdbId);
    groups.set(fr, (groups.get(fr) || 0) + 1);
  }
  const seeds = seedList.map(s => {
    const k = keyOf(s.sig.kind, s.tmdbId);
    const dna = seedDna.get(k);
    const fr = dna?.franchise || k;
    const sat = s.sig.like > 0 ? Math.sqrt(groups.get(fr) || 1) : 1;
    return { key: k, type: s.sig.kind, tmdbId: s.tmdbId, dna, weight: (s.sig.like * s.sig.timeWeight) / sat, title: dna?.title || s.sig.id };
  });
  const positives = seeds.filter(s => s.weight > 0).sort((a, b) => b.weight - a.weight);

  // 3. Candidatos.
  const cands = new Map<string, Cand>();
  const cand = (type: 'movie' | 'series', tmdbId: number): Cand | null => {
    const k = keyOf(type, tmdbId);
    if (seenKeys.has(k)) return null;
    let c = cands.get(k);
    if (!c) {
      c = { type, tmdbId, cf: 0, tmdb: 0, seedContrib: new Map(), fromContent: false, fromNew: false };
      cands.set(k, c);
    }
    return c;
  };

  // 3a. Colaborativo: vecinos de MovieLens de cada película que gustó.
  for (const s of positives) {
    if (s.type !== 'movie') continue;
    for (const nb of movieNeighbors(s.tmdbId)) {
      const c = cand('movie', nb.tmdbId);
      if (!c) continue;
      const v = s.weight * nb.score;
      c.cf += v;
      c.seedContrib.set(s.key, (c.seedContrib.get(s.key) || 0) + v);
    }
  }

  // 3b. TMDB: recomendaciones de las semillas con más peso (ya saturadas, así que variadas).
  const tmdbSeeds = positives.slice(0, opts.maxTmdbSeeds ?? 40);
  await mapWithConcurrency(tmdbSeeds, 4, async (s) => {
    let data: any;
    try {
      data = s.type === 'movie'
        ? await moviedb.movieRecommendations({ id: s.tmdbId }, config)
        : await moviedb.tvRecommendations({ id: s.tmdbId }, config);
    } catch {
      return;
    }
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    results.forEach((r, pos) => {
      if (!r?.id) return;
      const c = cand(s.type, Number(r.id));
      if (!c) return;
      const v = s.weight * (1 - pos / (results.length * 2));
      c.tmdb += v;
      c.seedContrib.set(s.key, (c.seedContrib.get(s.key) || 0) + v);
    });
  });

  // 4. Perfil de contenido (TF-IDF sobre el ADN; los gustos negativos restan).
  const df = new Map<string, number>();
  const docs = [...seedDna.values()];
  for (const d of docs) for (const f of features(d).keys()) df.set(f, (df.get(f) || 0) + 1);
  const idf = (f: string) => Math.log(1 + (docs.length + 1) / ((df.get(f) || 0) + 1));
  const profile = new Map<string, number>();
  for (const s of seeds) {
    if (!s.dna) continue;
    for (const [f, strength] of features(s.dna)) {
      profile.set(f, (profile.get(f) || 0) + s.weight * strength * FAMILY_WEIGHT[family(f)] * idf(f));
    }
  }
  const profileNorm = Math.sqrt([...profile.values()].reduce((a, v) => a + v * v, 0)) || 1;
  const contentScore = (d: Dna): { score: number; top: string | null } => {
    let dot = 0;
    let norm = 0;
    let best: [string, number] | null = null;
    for (const [f, strength] of features(d)) {
      const v = strength * FAMILY_WEIGHT[family(f)] * idf(f);
      norm += v * v;
      const p = profile.get(f) || 0;
      dot += p * v;
      if (p * v > 0 && (!best || p * v > best[1])) best = [f, p * v];
    }
    return { score: norm ? dot / (profileNorm * Math.sqrt(norm)) : 0, top: best?.[0] || null };
  };

  // 3c. Contenido: descubrir por los rasgos más fuertes del perfil (palabras clave y personas),
  // aunque no tengan relación directa con ninguna semilla.
  const topBy = (fam: string, n: number) => [...profile.entries()]
    .filter(([f, v]) => family(f) === fam && v > 0 && (df.get(f) || 0) >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([f]) => f.slice(f.indexOf(':') + 1));
  const topKeywords = topBy('k', 8);
  const topDirectors = topBy('d', 4);
  const discoverJobs: Array<{ type: 'movie' | 'series'; params: Record<string, any> }> = [];
  for (const k of topKeywords) {
    discoverJobs.push({ type: 'movie', params: { with_keywords: k, sort_by: 'vote_count.desc', 'vote_count.gte': 100 } });
    discoverJobs.push({ type: 'series', params: { with_keywords: k, sort_by: 'vote_count.desc', 'vote_count.gte': 50 } });
  }
  for (const d of topDirectors) discoverJobs.push({ type: 'movie', params: { with_crew: d, sort_by: 'vote_count.desc' } });
  // 3d. Estrenos: lo nuevo casi no tiene votos ni aparece como "recomendado" de nada todavía, así que
  // se busca aparte y el perfil de contenido decide cuáles sirven. El anime de temporada va aparte
  // porque es justo lo que más se empieza a ver y lo que menos datos tiene.
  const recent = (days: number) => ({ from: isoDaysAgo(days, now), to: isoDaysAgo(0, now) });
  const rm = recent(150);
  const rs = recent(270);
  for (const page of [1, 2, 3]) {
    discoverJobs.push({ type: 'movie', params: { region: 'MX', with_release_type: '4|5', 'release_date.gte': rm.from, 'release_date.lte': rm.to, sort_by: 'popularity.desc', page } });
    discoverJobs.push({ type: 'series', params: { with_genres: '16', with_origin_country: 'JP', 'first_air_date.gte': rs.from, 'first_air_date.lte': rs.to, sort_by: 'popularity.desc', page } });
    // Temporadas nuevas de series ya existentes (también anime): episodios al aire en los últimos 90 días.
    discoverJobs.push({ type: 'series', params: { with_genres: '16', with_origin_country: 'JP', 'air_date.gte': isoDaysAgo(90, now), 'air_date.lte': isoDaysAgo(0, now), sort_by: 'popularity.desc', page } });
  }
  for (const page of [1, 2]) {
    discoverJobs.push({ type: 'series', params: { without_genres: '16', 'first_air_date.gte': rs.from, 'first_air_date.lte': rs.to, sort_by: 'popularity.desc', 'vote_count.gte': 5, page } });
  }
  await mapWithConcurrency(discoverJobs, 4, async (job) => {
    const results = await cachedDiscover(job.type, job.params, config);
    const isNew = 'release_date.gte' in job.params || 'first_air_date.gte' in job.params || 'air_date.gte' in job.params;
    for (const r of results) {
      const c = cand(job.type, Number(r.id));
      if (!c) continue;
      if (isNew) c.fromNew = true; else c.fromContent = true;
    }
  });

  // 5. Recorte previo y ADN de los candidatos (cacheado 30 días).
  const maxCf = Math.max(1e-9, ...[...cands.values()].map(c => c.cf));
  const maxTmdb = Math.max(1e-9, ...[...cands.values()].map(c => c.tmdb));
  // Lo de colaborativo/TMDB entra por puntuación; lo de contenido y estrenos entra siempre (no tiene
  // puntuación propia todavía: la decide el perfil de contenido).
  const byScore = [...cands.values()]
    .filter(c => c.cf > 0 || c.tmdb > 0)
    .sort((a, b) => Math.max(b.cf / maxCf, b.tmdb / maxTmdb) - Math.max(a.cf / maxCf, a.tmdb / maxTmdb))
    .slice(0, 500);
  const pre = [...new Set([...byScore, ...[...cands.values()].filter(c => c.fromContent || c.fromNew)])];
  const candDna = await getDnaMany(pre.map(c => ({ type: c.type, tmdbId: c.tmdbId })), config);
  await attachAnilistTags([...candDna.values()]);

  // 6. Componentes de la puntuación (los pesos se aplican en rankV2).
  const items: Prepared['items'] = [];
  for (const c of pre) {
    const dna = candDna.get(keyOf(c.type, c.tmdbId));
    if (!dna) continue;
    // A lo de más de un año se le piden 20 votos; a un estreno, casi nada (aún no lo ha votado nadie).
    const age = dna.year ? new Date(now).getUTCFullYear() - dna.year : 99;
    if (age > 1 && dna.voteCount < 20) continue;
    const content = contentScore(dna);
    const bayes = (dna.voteCount * dna.voteAverage + 200 * 6.5) / (dna.voteCount + 200);
    const topSeeds = [...c.seedContrib.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k]) => k);
    const themes: string[] = [];
    if (dna.keywords.some(k => SUPERHERO_KEYWORDS.has(k))) themes.push('superhero');
    if (dna.genres.includes(16)) themes.push('animation');
    if (dna.genres.some(g => KIDS_GENRES.has(g))) themes.push('kids');
    if (dna.anime) themes.push('anime');
    items.push({
      type: c.type,
      tmdbId: c.tmdbId,
      dna,
      comps: {
        cf: c.cf / maxCf,
        content: content.score,
        tmdb: c.tmdb / maxTmdb,
        quality: Math.min(1, Math.max(0, (bayes - 5.5) / 3)),
        fresh: age <= 1 ? 1 : age <= 3 ? 0.5 : 0,
        pop: Math.min(1, Math.log10(1 + dna.popularity) / 3),
      },
      because: topSeeds.map(k => seeds.find(x => x.key === k)?.title).filter(Boolean) as string[],
      topSeed: topSeeds[0] || `content:${content.top}`,
      themes,
    });
  }
  logger.info(`v2: ${positives.length} semillas (${groups.size} franquicias), ${cands.size} candidatos, ${items.length} puntuables`);
  return { items, caps };
}

export interface Prepared {
  items: Array<{
    type: 'movie' | 'series';
    tmdbId: number;
    dna: Dna;
    comps: Record<keyof Weights, number>;
    because: string[];
    topSeed: string;
    themes: string[];
  }>;
  caps: Record<string, number>;
}

/** Puntúa con los pesos y aplica la variedad. Barato: el ajuste de pesos lo repite muchas veces. */
export function rankV2(prep: Prepared, weights: Partial<Weights> = {}): { main: RecItemV2[]; anime: RecItemV2[] } {
  const w: Weights = { ...DEFAULT_WEIGHTS, ...weights };
  const caps = prep.caps;
  type Scored = Prepared['items'][number] & { score: number };
  const scored: Scored[] = prep.items.map(it => ({
    ...it,
    // Relevancia = qué tan afín es al gusto (colaborativo, contenido, TMDB). Calidad, frescura y tendencia
    // solo la multiplican: un estreno popular que no se parece a nada de lo visto no sube por estar de
    // moda (si sumaran por su cuenta, todos los perfiles terminaban con la misma lista de tendencias).
    score: (weights as any).additive
      ? (Object.keys(w) as Array<keyof Weights>).reduce((sum, k) => sum + w[k] * (it.comps[k] || 0), 0)
      : (w.cf * it.comps.cf + w.content * it.comps.content + w.tmdb * it.comps.tmdb)
        * (1 + w.quality * (it.comps.quality - 0.5) + w.fresh * it.comps.fresh + w.pop * it.comps.pop),
  })).sort((x, y) => y.score - x.score);

  // 7. Variedad.
  const diversify = (pool: Scored[], ignore: string[]): Scored[] => {
    const remaining = [...pool];
    const out: Scored[] = [];
    while (remaining.length) {
      const recent = out.slice(-WINDOW);
      const count = (pred: (s: Scored) => boolean) => recent.filter(pred).length;
      const fits = (s: Scored) =>
        count(r => r.dna.franchise === s.dna.franchise) < FRANCHISE_CAP
        && count(r => r.topSeed === s.topSeed) < SAME_SEED_CAP
        && s.themes.every(t => ignore.includes(t) || caps[t] === undefined || count(r => r.themes.includes(t)) < caps[t]);
      const idx = remaining.findIndex(fits);
      out.push(remaining.splice(idx < 0 ? 0 : idx, 1)[0]);
      if (out.length >= 200) break;
    }
    return out;
  };
  const toItem = (s: Scored): RecItemV2 => ({ tmdbId: s.tmdbId, type: s.type, score: s.score, because: s.because });
  return {
    main: diversify(scored.filter(s => !s.dna.anime), []).map(toItem),
    anime: diversify(scored.filter(s => s.dna.anime), ['animation', 'kids', 'anime']).map(toItem),
  };
}

export async function recommendV2(watched: any[], progress: any[], config: any, opts: V2Options = {}): Promise<{ main: RecItemV2[]; anime: RecItemV2[] }> {
  return rankV2(await prepareV2(watched, progress, config, opts), opts.weights);
}

export { getDna };
