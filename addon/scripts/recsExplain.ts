// Explica las primeras recomendaciones de un perfil con el motor v2: aporte de cada fuente, rasgos del
// gusto que coincidieron y semillas que más empujaron. Uso:
//   node dist/server/scripts/recsExplain.js <uuid-principal> <perfil> [n=10]

import { getWatchedItems, getWatchProgress } from '../lib/nuvio';
import { themeCapsFor } from '../lib/nuvioRecommendations';
import { prepareV2, rankV2 } from '../lib/recs/engine';
import { cacheWrapGlobal } from '../lib/getCache.js';

const database = require('../lib/database.js');
const KEY = process.env.TMDB_API;

async function tmdbName(path: string): Promise<string> {
  const data = await cacheWrapGlobal(`recs:name:v1:${path}`, async () => {
    const r = await fetch(`https://api.themoviedb.org/3/${path}?api_key=${KEY}&language=es-MX`);
    return r.ok ? await r.json() : { name: null };
  }, 30 * 24 * 3600).catch(() => ({}));
  return data?.name || path;
}

const GENRES: Record<string, string> = { 28: 'Acción', 12: 'Aventura', 16: 'Animación', 35: 'Comedia', 80: 'Crimen', 99: 'Documental', 18: 'Drama', 10751: 'Familia', 14: 'Fantasía', 36: 'Historia', 27: 'Terror', 10402: 'Música', 9648: 'Misterio', 10749: 'Romance', 878: 'Ciencia ficción', 53: 'Suspense', 10752: 'Bélica', 37: 'Western', 10759: 'Acción y aventura', 10765: 'Sci-Fi y fantasía', 10762: 'Infantil', 10764: 'Reality', 10766: 'Telenovela', 10767: 'Talk show', 10768: 'Guerra y política', 10763: 'Noticias' };

async function featureName(f: string): Promise<string> {
  const [fam, id] = [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)];
  if (fam === 'g') return `género ${GENRES[id] || id}`;
  if (fam === 'k') return `tema "${await tmdbName(`keyword/${id}`)}"`;
  if (fam === 'd') return `director/creador ${await tmdbName(`person/${id}`)}`;
  if (fam === 'c') return `actor ${await tmdbName(`person/${id}`)}`;
  if (fam === 'co') return `estudio ${await tmdbName(`company/${id}`)}`;
  if (fam === 'l') return `idioma ${id}`;
  if (fam === 'e') return `década ${id}s`;
  if (fam === 'at') return `etiqueta AniList "${id}"`;
  if (fam === 'ag') return `género AniList ${id}`;
  return f;
}

async function main() {
  const [uuid, profileArg = '1', nArg = '10'] = process.argv.slice(2);
  await database.initialize?.();
  const config = await database.getUserConfig(uuid);
  const idx = Number(profileArg);
  const [w, p] = await Promise.all([getWatchedItems(uuid, idx), getWatchProgress(uuid, idx)]);
  const lists = rankV2(await prepareV2(w, p, config, { themeCaps: themeCapsFor(config) }));
  for (const [i, item] of lists.main.slice(0, Number(nArg)).entries()) {
    const d = item.debug;
    const c = d.comps;
    console.log(`\n${i + 1}. ${d.title} (${item.type}) — puntuación ${item.score.toFixed(3)}`);
    console.log(`   colaborativo ${c.cf.toFixed(2)} · contenido ${c.content.toFixed(2)} · tmdb ${c.tmdb.toFixed(2)} · calidad ${c.quality.toFixed(2)} · estreno ${c.fresh} · tendencia ${c.pop.toFixed(2)}`);
    if (d.seedShares?.length) console.log(`   lo empujaron: ${d.seedShares.map(([t, v]: [string, number]) => `${t} (${v.toFixed(2)})`).join(', ')}`);
    if (d.matches?.length) console.log(`   coincide con tu gusto en: ${(await Promise.all(d.matches.map(async ([f]: [string, number]) => featureName(f)))).join(', ')}`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
