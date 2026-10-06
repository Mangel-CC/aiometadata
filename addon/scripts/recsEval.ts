// Corre el evaluador del motor de recomendaciones sobre los perfiles de una cuenta y escribe el
// reporte en JSON. Uso (dentro de la imagen, con la misma configuración que producción):
//   node dist/server/scripts/recsEval.js <uuid-principal> [perfiles=1,2,3,4] [salida.json]

import { evaluateProfile, type Engine } from '../lib/recs/evaluate';
import { computeFromHistory, themeCapsFor } from '../lib/nuvioRecommendations';
import { recommendV2, prepareV2, rankV2, type Prepared } from '../lib/recs/engine';

const database = require('../lib/database.js');

export const ENGINES: Record<string, Engine> = {
  v1: { name: 'v1', run: (w, p, idx, config) => computeFromHistory(w, p, idx, config) },
  v2: {
    name: 'v2',
    run: (w, p, _idx, config, now) => recommendV2(w, p, config, {
      now,
      themeCaps: themeCapsFor(config),
      weights: process.env.RECS_WEIGHTS ? JSON.parse(process.env.RECS_WEIGHTS) : undefined,
    }),
  },
};

async function main() {
  const [mainUUID, profilesArg = '1,2,3,4', outPath = '/tmp/recs-eval.json', enginesArg = 'v1'] = process.argv.slice(2);
  if (!mainUUID) throw new Error('Falta el uuid de la configuracion principal');
  await database.initialize?.();
  const mainConfig = await database.getUserConfig(mainUUID);
  const children: string[] = await database.findChildConfigUUIDs(mainUUID);
  const configs = new Map<number, any>([[Number(mainConfig.nuvio?.profileIndex) || 1, mainConfig]]);
  for (const uuid of children) {
    const c = await database.getUserConfig(uuid);
    const idx = Number(c?.nuvio?.profileIndex);
    if (idx) configs.set(idx, c);
  }
  let engines = enginesArg.split(',').map(n => ENGINES[n]).filter(Boolean);
  // RECS_GRID='[{"cf":..},..]': una variante del v2 por combinación de pesos, para ajustarlos.
  if (process.env.RECS_GRID) {
    const grid: any[] = JSON.parse(process.env.RECS_GRID);
    // La preparación (lo lento) es la misma para todas las combinaciones de un mismo corte.
    const prepared = new Map<string, Promise<Prepared>>();
    engines = grid.map((weights, i) => ({
      name: `g${i}`,
      run: async (w: any[], p: any[], idx: number, config: any, now: number) => {
        const key = `${idx}:${now}`;
        if (!prepared.has(key)) prepared.set(key, prepareV2(w, p, config, { now, themeCaps: themeCapsFor(config) }));
        return rankV2(await prepared.get(key)!, weights);
      },
    }));
  }
  const results = [];
  for (const idx of profilesArg.split(',').map(Number)) {
    results.push(await evaluateProfile(mainUUID, idx, configs.get(idx) || mainConfig, engines));
  }
  require('fs').writeFileSync(outPath, JSON.stringify(results, null, 2));
  if (process.env.RECS_GRID) {
    const grid: any[] = JSON.parse(process.env.RECS_GRID);
    const rows = grid.map((weights, i) => {
      const reps = results.map(r => r.reports.find(e => e.engine === `g${i}`)!).filter(Boolean);
      const mean = (f: (e: any) => number) => reps.reduce((a, e) => a + f(e), 0) / (reps.length || 1);
      // Parecido entre perfiles: en el primer corte, cuántos títulos comparten (en promedio) los top 20 de
      // cada par de perfiles. Una lista personal comparte poco; una de tendencias, casi todo.
      const tops = reps.map(e => new Set(e.folds[0]?.top20 || []));
      let pairs = 0, shared = 0;
      for (let a = 0; a < tops.length; a++) for (let b = a + 1; b < tops.length; b++) {
        pairs++;
        shared += [...tops[a]].filter(x => tops[b].has(x)).length;
      }
      return { i, weights, r20: mean(e => e.recall20), r50: mean(e => e.recall50), ndcg: mean(e => e.ndcg20), fr: mean(e => e.franchises20), known: mean(e => e.folds.reduce((a: number, f: any) => a + (f.known20 || 0), 0) / (e.folds.length || 1)), shared: pairs ? shared / pairs : 0 };
    }).sort((a, b) => b.r20 - a.r20 || b.ndcg - a.ndcg || b.r50 - a.r50);
    for (const r of rows) console.log(`GRID g${r.i} acierto@20 ${(r.r20 * 100).toFixed(1)}% @50 ${(r.r50 * 100).toFixed(1)}% ndcg ${r.ndcg.toFixed(3)} franquicias ${r.fr.toFixed(1)} compartidos ${r.shared.toFixed(1)}/20 archiconocidos ${r.known.toFixed(1)}/20 ${JSON.stringify(r.weights)}`);
  }
  for (const r of results) {
    for (const e of r.reports) {
      console.log(`perfil ${r.profileIndex} ${e.engine}: acierto@20 ${(e.recall20 * 100).toFixed(1)}% @50 ${(e.recall50 * 100).toFixed(1)}% @200 ${(e.recall200 * 100).toFixed(1)}% ndcg ${e.ndcg20.toFixed(3)} | franquicias ${e.franchises20.toFixed(1)} max-misma ${e.maxSameFranchise20.toFixed(1)} superheroes ${e.superhero20.toFixed(1)}`);
    }
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
