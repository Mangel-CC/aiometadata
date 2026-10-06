// Evaluador del motor de recomendaciones (docs/specs/motor-recomendaciones-v2.md, 3.6).
//
// Para cada perfil: se esconden los últimos títulos que gustaron y se vieron de verdad en Nuvio, se le
// da al motor solo el historial anterior a ellos, y se mide cuántos adivina. Se repite en varios cortes
// hacia atrás para que el resultado no dependa de un solo momento.

import consola from 'consola';
import { getWatchedItems, getWatchProgress } from '../nuvio';
import { toTmdbId, type RecItem } from '../nuvioRecommendations';
import { buildSignals, historyBefore } from './signals';
import { getDnaMany } from './dna';

const logger = consola.withTag('RecsEval');

export interface Engine {
  name: string;
  /** `now`: la fecha del corte; el motor no debe ver nada posterior. */
  run(watched: any[], progress: any[], profileIndex: number, config: any, now: number): Promise<{ main: RecItem[]; anime: RecItem[] }>;
}

export interface FoldResult {
  cutoff: string;
  hidden: number;
  hits20: number;
  hits50: number;
  hits200: number;
  ndcg20: number;
  franchises20: number;
  maxSameFranchise20: number;
  superhero20: number;
  /** Archiconocidos y viejos en el top 20 (≥ 10,000 votos y ≥ 8 años): probablemente ya vistos. */
  known20: number;
  hitTitles: string[];
  /** Top 20 de la lista principal (para medir cuánto se parecen las listas de distintos perfiles). */
  top20: string[];
}

export interface EngineReport {
  engine: string;
  folds: FoldResult[];
  recall20: number;
  recall50: number;
  recall200: number;
  ndcg20: number;
  franchises20: number;
  maxSameFranchise20: number;
  superhero20: number;
}

const SUPERHERO_KEYWORDS = new Set([9715, 9717, 180547, 229266]);

function dcg(positions: number[]): number {
  return positions.reduce((sum, p) => sum + 1 / Math.log2(p + 2), 0);
}

export async function evaluateProfile(
  accountUUID: string,
  profileIndex: number,
  config: any,
  engines: Engine[],
  opts: { foldSize?: number; folds?: number } = {},
): Promise<{ profileIndex: number; reports: EngineReport[] }> {
  const foldSize = opts.foldSize ?? 10;
  const foldCount = opts.folds ?? 3;
  const [watched, progress] = await Promise.all([
    getWatchedItems(accountUUID, profileIndex),
    getWatchProgress(accountUUID, profileIndex),
  ]);

  // Candidatos a esconder: reproducidos en Nuvio, que gustaron, ordenados por su primera vez.
  const signals = buildSignals(watched, progress);
  const played = [...signals.values()]
    .filter(s => s.played && s.like > 0 && s.firstAt > 0)
    .sort((a, b) => b.firstAt - a.firstAt);

  const reports = new Map<string, FoldResult[]>(engines.map(e => [e.name, []]));
  for (let f = 0; f < foldCount; f++) {
    const hiddenSignals = played.slice(f * foldSize, (f + 1) * foldSize);
    if (hiddenSignals.length < foldSize) break;
    const cutoff = Math.min(...hiddenSignals.map(s => s.firstAt));
    const train = historyBefore(watched, progress, cutoff);
    const hiddenKeys = new Map<string, string>();
    for (const s of hiddenSignals) {
      const tmdbId = await toTmdbId(s.id, s.kind, config);
      if (tmdbId) hiddenKeys.set(`${s.kind}:${tmdbId}`, s.id);
    }
    logger.info(`Perfil ${profileIndex}, corte ${f + 1}: ${new Date(cutoff).toISOString().slice(0, 10)}, ${hiddenKeys.size} escondidos, entrenando con ${train.watched.length} vistos y ${train.progress.length} en progreso`);

    for (const engine of engines) {
      const t0 = Date.now();
      const lists = await engine.run(train.watched, train.progress, profileIndex, config, cutoff);
      const keyOf = (r: RecItem) => `${r.type}:${r.tmdbId}`;
      const main = lists.main.map(keyOf);
      const anime = lists.anime.map(keyOf);
      const hitsAt = (k: number) => {
        const shown = new Set([...main.slice(0, k), ...anime.slice(0, k)]);
        return [...hiddenKeys.keys()].filter(key => shown.has(key));
      };
      const hit20 = hitsAt(20);
      const positions = [
        ...main.slice(0, 20).map((k, i) => (hiddenKeys.has(k) ? i : -1)),
        ...anime.slice(0, 20).map((k, i) => (hiddenKeys.has(k) ? i : -1)),
      ].filter(i => i >= 0);
      const ideal = dcg([...Array(Math.min(hiddenKeys.size, 20)).keys()]);

      const top = lists.main.slice(0, 20);
      const dnas = await getDnaMany(top, config);
      const franchiseCount = new Map<string, number>();
      let superhero = 0;
      let known = 0;
      for (const r of top) {
        const d = dnas.get(keyOf(r));
        const fr = d?.franchise || keyOf(r);
        franchiseCount.set(fr, (franchiseCount.get(fr) || 0) + 1);
        if (d?.keywords.some(k => SUPERHERO_KEYWORDS.has(k))) superhero++;
        if (d && d.voteCount >= 10000 && d.year && new Date(cutoff).getUTCFullYear() - d.year >= 8) known++;
      }

      if (process.env.RECS_EVAL_DEBUG) {
        for (const [key, id] of hiddenKeys) {
          const mi = main.indexOf(key), ai = anime.indexOf(key);
          const d = (await getDnaMany([{ type: key.split(':')[0] as any, tmdbId: Number(key.split(':')[1]) }], config)).get(key);
          logger.info(`    escondido ${id} ${d?.title || ''} (${key}${d?.anime ? ', anime' : ''}): ${mi >= 0 ? 'lista #' + (mi + 1) : ai >= 0 ? 'anime #' + (ai + 1) : 'no aparece'}`);
        }
      }
      reports.get(engine.name)!.push({
        cutoff: new Date(cutoff).toISOString().slice(0, 10),
        hidden: hiddenKeys.size,
        hits20: hit20.length,
        hits50: hitsAt(50).length,
        hits200: hitsAt(200).length,
        ndcg20: ideal ? dcg(positions) / ideal : 0,
        franchises20: franchiseCount.size,
        maxSameFranchise20: Math.max(0, ...franchiseCount.values()),
        superhero20: superhero,
        known20: known,
        hitTitles: hit20.map(k => hiddenKeys.get(k)!),
        top20: main.slice(0, 20),
      });
      logger.info(`  ${engine.name}: ${hit20.length}/${hiddenKeys.size} en top 20 (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    profileIndex,
    reports: engines.map(e => {
      const folds = reports.get(e.name)!;
      const hidden = folds.reduce((a, f) => a + f.hidden, 0) || 1;
      return {
        engine: e.name,
        folds,
        recall20: folds.reduce((a, f) => a + f.hits20, 0) / hidden,
        recall50: folds.reduce((a, f) => a + f.hits50, 0) / hidden,
        recall200: folds.reduce((a, f) => a + f.hits200, 0) / hidden,
        ndcg20: avg(folds.map(f => f.ndcg20)),
        franchises20: avg(folds.map(f => f.franchises20)),
        maxSameFranchise20: avg(folds.map(f => f.maxSameFranchise20)),
        superhero20: avg(folds.map(f => f.superhero20)),
      };
    }),
  };
}
