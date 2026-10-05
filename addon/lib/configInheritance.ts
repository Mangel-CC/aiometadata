// Configuraciones hijas que heredan de una principal (ver docs/specs/
// perfiles-recomendaciones-temporadas.md).
//
// Una hija guarda SOLO su diferencia:
//   { inheritsFrom: "<uuid principal>", overrides: {...}, catalogToggles: { "<id>": false } }
//
// Al leerla se carga la principal y se le aplican esos cambios, asi que editar la principal
// (idioma, arte, ORDEN de los catalogos) se refleja en las 4 sin tocarlas. La lista de catalogos
// nunca se reemplaza: solo se encienden o apagan catalogos puntuales con catalogToggles, que es
// lo que permite compartir el orden y a la vez dejar que un perfil apague, por ejemplo, el
// catalogo de anime.

import consola from 'consola';

const logger = consola.withTag('ConfigInherit');

export interface ChildConfigShape {
  inheritsFrom?: string;
  overrides?: Record<string, any>;
  catalogToggles?: Record<string, boolean>;
  [key: string]: any;
}

/** Campos que son de la hija y nunca se heredan de la principal. */
const NEVER_INHERITED = ['inheritsFrom', 'overrides', 'catalogToggles', 'configHash', 'nuvio'];

export function isChildConfig(raw: any): boolean {
  return Boolean(raw && typeof raw === 'object' && typeof raw.inheritsFrom === 'string' && raw.inheritsFrom.trim());
}

function applyCatalogToggles(catalogs: any, toggles: Record<string, boolean> | undefined): any {
  if (!Array.isArray(catalogs) || !toggles || !Object.keys(toggles).length) return catalogs;
  return catalogs.map((catalog: any) => {
    if (!catalog || typeof catalog !== 'object') return catalog;
    // Una clave puede ser "<id>" (todos los tipos) o "<id>:<type>" (uno solo).
    const byIdAndType = toggles[`${catalog.id}:${catalog.type}`];
    const byId = toggles[catalog.id];
    const next = byIdAndType !== undefined ? byIdAndType : byId;
    return next === undefined ? catalog : { ...catalog, enabled: Boolean(next) };
  });
}

/**
 * Devuelve la configuracion que ve el resto del addon. Si no es hija, la misma que entro.
 *
 * loadParentRaw recibe el uuid de la principal y devuelve su fila SIN resolver (la herencia es de
 * un solo nivel a proposito: una cadena de hijas seria imposible de razonar y abre ciclos).
 */
export async function resolveInheritedConfig(
  raw: any,
  loadParentRaw: (uuid: string) => Promise<any>,
): Promise<any> {
  if (!isChildConfig(raw)) return raw;

  const parentUUID = String(raw.inheritsFrom).trim();
  let parent: any = null;
  try {
    parent = await loadParentRaw(parentUUID);
  } catch (error: any) {
    logger.error(`No se pudo leer la configuracion principal ${parentUUID.substring(0, 8)}...: ${error?.message}`);
  }

  if (!parent || typeof parent !== 'object') {
    // Sin principal la hija sigue sirviendo con lo suyo: es mejor un addon con menos catalogos
    // que un addon caido.
    logger.warn(`La principal ${parentUUID.substring(0, 8)}... no existe; la hija responde solo con sus overrides`);
    return { ...(raw.overrides || {}), ...stripChildOnlyKeys(raw) };
  }

  if (isChildConfig(parent)) {
    logger.warn(`Herencia anidada ignorada: ${parentUUID.substring(0, 8)}... tambien es hija`);
  }

  const base = { ...parent };
  delete base.inheritsFrom;
  delete base.overrides;
  delete base.catalogToggles;

  const merged: Record<string, any> = { ...base, ...(raw.overrides || {}) };

  // El orden de los catalogos siempre es el de la principal; la hija solo prende y apaga.
  merged.catalogs = applyCatalogToggles(parent.catalogs, raw.catalogToggles);

  // Lo propio de la hija (credenciales de Nuvio, etc.) pisa a todo lo demas.
  Object.assign(merged, stripChildOnlyKeys(raw));

  // Hace que el hash de la configuracion resuelta cambie cuando cambia la principal, para que la
  // cache de meta/catalogo de las hijas no se quede con datos viejos.
  merged._inheritedFrom = { uuid: parentUUID, hash: parent.configHash || null };

  return merged;
}

/** Los campos propios de la hija, sin la maquinaria de la herencia. */
function stripChildOnlyKeys(raw: any): Record<string, any> {
  const own: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (NEVER_INHERITED.includes(key)) continue;
    own[key] = value;
  }
  if (raw?.nuvio) own.nuvio = raw.nuvio;
  return own;
}

export default { isChildConfig, resolveInheritedConfig };
