// Vecinos ítem-ítem de MovieLens 32M (docs/specs/motor-recomendaciones-v2.md, 3.3): "a las personas a
// las que les gustó esta película también les gustaron estas". Se calculan fuera de línea con
// scripts/movielens/build_neighbors.py y se leen de addon/data/movielens.sqlite (solo lectura).
// Sin el archivo, el motor sigue con las demás fuentes.

import consola from 'consola';
import path from 'path';
import fs from 'fs';

const logger = consola.withTag('MovieLens');
const DB_PATH = process.env.MOVIELENS_DB || path.join(process.cwd(), 'addon', 'data', 'movielens.sqlite');

let db: any = null;
let stmt: any = null;
let tried = false;

function open(): boolean {
  if (stmt) return true;
  if (tried) return false;
  tried = true;
  try {
    if (!fs.existsSync(DB_PATH)) {
      logger.warn(`No existe ${DB_PATH}; el motor funciona sin filtrado colaborativo`);
      return false;
    }
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    stmt = db.prepare('SELECT neighbor, score FROM neighbors WHERE tmdb_id = ? ORDER BY score DESC');
    return true;
  } catch (error: any) {
    logger.warn(`No se pudo abrir ${DB_PATH}: ${error.message}`);
    return false;
  }
}

export function movieNeighbors(tmdbId: number): Array<{ tmdbId: number; score: number }> {
  if (!open()) return [];
  try {
    return stmt.all(tmdbId).map((r: any) => ({ tmdbId: Number(r.neighbor), score: Number(r.score) }));
  } catch {
    return [];
  }
}

export function hasMovieLens(): boolean {
  return open();
}
