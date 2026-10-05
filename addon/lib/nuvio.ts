// Cliente de solo lectura de la API de Nuvio (Supabase en api.nuvio.tv), el mismo camino que usa
// AIOManager. Ver docs/specs/perfiles-recomendaciones-temporadas.md, 3.2.1.
//
// La sesion es una por cuenta de Nuvio y se guarda en nuvio_sessions bajo el uuid de la
// configuracion principal; las hijas la usan a traves de la principal. Supabase ROTA el refresh
// token en cada renovacion (el viejo deja de servir), asi que la renovacion pasa por un solo
// camino por cuenta y el token nuevo se guarda antes de devolver nada: dos renovaciones en
// paralelo con el mismo token dejarian a una de ellas, y a la sesion, invalida.

import consola from 'consola';

const database = require('./database.js');

const logger = consola.withTag('Nuvio');

const BASE_URL = (process.env.NUVIO_API_URL || 'https://api.nuvio.tv').replace(/\/+$/, '');
// Clave publica (rol anon) que trae la app; no es un secreto.
const PUBLISHABLE_KEY = process.env.NUVIO_PUBLISHABLE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';
const TIMEOUT_MS = 30000;
/** Margen para no usar un access token que vence a media peticion. */
const EXPIRY_MARGIN_S = 300;
/** Lo maximo que devuelve sync_pull_watched_items por pagina. */
const WATCHED_PAGE_SIZE = 1000;
const MAX_WATCHED_PAGES = 20;

export interface NuvioWatchedItem {
  content_id: string;
  content_type: string;
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  watched_at?: number | string | null;
}

export interface NuvioProgressItem {
  content_id: string;
  content_type: string;
  position?: number | null;
  duration?: number | null;
  last_watched?: number | string | null;
  season?: number | null;
  episode?: number | null;
}

class NuvioError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function headers(accessToken?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: PUBLISHABLE_KEY,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function postJson(path: string, body: unknown, accessToken?: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* sin cuerpo */ }
    throw new NuvioError(`Nuvio ${path} devolvio ${res.status} ${detail}`, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

const refreshInFlight = new Map<string, Promise<string>>();

async function refreshSession(accountUUID: string): Promise<string> {
  const session = await database.getNuvioSession(accountUUID);
  if (!session?.refresh_token) throw new NuvioError('No hay sesion de Nuvio para esta cuenta');
  const data = await postJson('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
  if (!data?.access_token || !data?.refresh_token) throw new NuvioError('Nuvio no devolvio tokens al renovar');
  const expiresAt = Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600);
  await database.saveNuvioSession(accountUUID, data.refresh_token, data.access_token, expiresAt);
  logger.info(`Sesion de Nuvio renovada para ${accountUUID.substring(0, 8)}...`);
  return data.access_token;
}

/** Access token vigente; renueva (una sola vez a la vez por cuenta) si hace falta o si se pide. */
async function getAccessToken(accountUUID: string, force = false): Promise<string> {
  if (!force) {
    const session = await database.getNuvioSession(accountUUID);
    if (!session) throw new NuvioError('No hay sesion de Nuvio para esta cuenta');
    const now = Math.floor(Date.now() / 1000);
    if (session.access_token && Number(session.expires_at) > now + EXPIRY_MARGIN_S) return session.access_token;
  }
  let flight = refreshInFlight.get(accountUUID);
  if (!flight) {
    flight = refreshSession(accountUUID).finally(() => refreshInFlight.delete(accountUUID));
    refreshInFlight.set(accountUUID, flight);
  }
  return flight;
}

async function rpc(accountUUID: string, fn: string, body: unknown): Promise<any> {
  const token = await getAccessToken(accountUUID);
  try {
    return await postJson(`/rest/v1/rpc/${fn}`, body, token);
  } catch (error: any) {
    // Un access token revocado antes de su vencimiento: se renueva una vez y se reintenta.
    if (error?.status !== 401) throw error;
    const fresh = await getAccessToken(accountUUID, true);
    return postJson(`/rest/v1/rpc/${fn}`, body, fresh);
  }
}

/**
 * Inicia sesion con correo y contrasena y guarda SOLO los tokens: la contrasena no se guarda en
 * ningun lado. Para cambiar de cuenta basta con volver a conectar.
 */
export async function connectNuvio(accountUUID: string, email: string, password: string): Promise<void> {
  let data: any;
  try {
    data = await postJson('/auth/v1/token?grant_type=password', { email, password });
  } catch (error: any) {
    if (error?.status === 400 || error?.status === 401) throw new NuvioError('Correo o contrasena de Nuvio incorrectos', 401);
    throw error;
  }
  if (!data?.access_token || !data?.refresh_token) throw new NuvioError('Nuvio no devolvio tokens');
  const expiresAt = Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600);
  await database.saveNuvioSession(accountUUID, data.refresh_token, data.access_token, expiresAt);
  logger.info(`Cuenta de Nuvio conectada para ${accountUUID.substring(0, 8)}...`);
}

export async function disconnectNuvio(accountUUID: string): Promise<void> {
  await database.deleteNuvioSession(accountUUID);
  logger.info(`Cuenta de Nuvio desconectada de ${accountUUID.substring(0, 8)}...`);
}

export async function hasNuvioSession(accountUUID: string): Promise<boolean> {
  try {
    const session = await database.getNuvioSession(accountUUID);
    return Boolean(session?.refresh_token);
  } catch {
    return false;
  }
}

export async function getProfiles(accountUUID: string): Promise<any[]> {
  const rows = await rpc(accountUUID, 'sync_pull_profiles', {});
  return Array.isArray(rows) ? rows : [];
}

export async function getWatchedItems(accountUUID: string, profileIndex: number): Promise<NuvioWatchedItem[]> {
  const all: NuvioWatchedItem[] = [];
  for (let page = 1; page <= MAX_WATCHED_PAGES; page++) {
    const rows = await rpc(accountUUID, 'sync_pull_watched_items', {
      p_profile_id: profileIndex, p_page: page, p_page_size: WATCHED_PAGE_SIZE,
    });
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    if (rows.length < WATCHED_PAGE_SIZE) break;
  }
  return all;
}

export async function getWatchProgress(accountUUID: string, profileIndex: number): Promise<NuvioProgressItem[]> {
  const rows = await rpc(accountUUID, 'sync_pull_watch_progress', {
    p_profile_id: profileIndex, p_since_last_watched: 0, p_limit: 100000,
  });
  return Array.isArray(rows) ? rows : [];
}

export default { connectNuvio, disconnectNuvio, hasNuvioSession, getProfiles, getWatchedItems, getWatchProgress };
