// Decide si una ficha para un usuario en espanol quedo sin traducir (sinopsis o episodios en
// ingles, titulos genericos "Episode N", sin descripcion), para cachearla poco tiempo y
// recoger la traduccion en cuanto alguien la suba a TMDB.

const ES = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'un', 'una', 'por', 'con', 'para', 'se', 'su', 'sus', 'al', 'es', 'lo', 'como', 'mas', 'pero', 'sin', 'sobre', 'entre', 'cuando', 'muy', 'ya', 'tambien', 'este', 'esta']);
const EN = new Set(['the', 'of', 'and', 'to', 'in', 'is', 'that', 'for', 'with', 'his', 'her', 'he', 'she', 'it', 'as', 'on', 'at', 'by', 'an', 'are', 'was', 'be', 'from', 'this', 'they', 'their', 'but', 'not', 'or', 'when', 'who', 'what']);

export function textLanguage(text: unknown): 'es' | 'en' | 'unknown' {
  const words = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]+/g) || [];
  let es = 0;
  let en = 0;
  for (const w of words) {
    if (ES.has(w)) es++;
    if (EN.has(w)) en++;
  }
  if (Math.max(es, en) < 2) return 'unknown';
  if (en > es) return 'en';
  if (es > en) return 'es';
  return 'unknown';
}

const GENERIC_EPISODE = /^(episode|ep\.?)\s*\d+$/i;

export function assessMetaLocalization(meta: any, language: string | undefined): { incomplete: boolean; reason: string } {
  if (!meta || !language || !/^es/i.test(language)) return { incomplete: false, reason: '' };
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  if (!description) return { incomplete: true, reason: 'sin sinopsis' };
  if (textLanguage(description) === 'en') return { incomplete: true, reason: 'sinopsis en ingles' };

  const now = Date.now();
  const aired = (Array.isArray(meta.videos) ? meta.videos : []).filter((v: any) => {
    if (!v || !(Number(v.season) > 0) || !v.released) return false;
    const t = new Date(v.released).getTime();
    return Number.isFinite(t) && t <= now;
  });
  if (!aired.length) return { incomplete: false, reason: '' };
  const missing = aired.filter((v: any) => {
    const title = String(v.title || v.name || '').trim();
    const overview = String(v.overview || v.description || '').trim();
    const titleBad = !title || GENERIC_EPISODE.test(title) || textLanguage(title) === 'en';
    const overviewBad = !overview || textLanguage(overview) === 'en';
    return titleBad || overviewBad;
  }).length;
  if (missing / aired.length >= 0.5) return { incomplete: true, reason: `${missing}/${aired.length} episodios sin traducir` };
  return { incomplete: false, reason: '' };
}

// Cuanto vive en cache una ficha incompleta: poco si el anime es reciente (es cuando alguien
// la va a traducir), algo mas si es viejo, para no recalcular cada rato series enormes que
// quiza nunca se traduzcan completas.
export function incompleteMetaTtl(meta: any, baseTtl: number, shortSec: number, oldSec: number): number {
  const recentWindowMs = 120 * 24 * 3600 * 1000;
  const now = Date.now();
  let newest = new Date(meta?.released || 0).getTime() || 0;
  for (const v of Array.isArray(meta?.videos) ? meta.videos : []) {
    const t = v?.released ? new Date(v.released).getTime() : 0;
    if (Number.isFinite(t) && t <= now && t > newest) newest = t;
  }
  const isRecent = newest > 0 && now - newest < recentWindowMs;
  return Math.min(baseTtl, isRecent ? shortSec : oldSec);
}
