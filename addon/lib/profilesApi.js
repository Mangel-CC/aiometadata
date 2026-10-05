// Perfiles (configuraciones hijas) administrados desde la configuracion principal. Ver
// docs/specs/perfiles-recomendaciones-temporadas.md, seccion 3.4.
//
// Todas las rutas piden lo mismo que cargar la principal: la contrasena de la principal o una
// sesion de cuenta duena de ella. Una hija nunca administra perfiles.

const crypto = require('crypto');
const consola = require('consola');
const database = require('./database');
const configCache = require('./configCache');
const { buildInstallUrl } = require('./installUrl');
const { getAliasForUuid, isAliasFeatureEnabled } = require('./aliasResolver');
const { isChildConfig } = require('./configInheritance');
const nuvio = require('./nuvio');

const logger = consola.withTag('Profiles');

const MAX_CHILDREN = 10;
const THEME_KEYS = ['superhero', 'animation', 'kids', 'anime'];

function manifestIdentifier(userUUID) {
  if (!isAliasFeatureEnabled()) return userUUID;
  return getAliasForUuid(userUUID) || userUUID;
}

/** Devuelve la fila de la principal si quien llama puede administrarla; si no, responde y da null. */
async function authorizeParent(req, res) {
  const { userUUID } = req.params;
  const password = req.body?.password;
  if (!userUUID) {
    res.status(400).json({ error: 'User UUID is required' });
    return null;
  }
  const accountId = req.session?.accountId;
  const owns = Boolean(accountId) && await database.ownsConfig(accountId, userUUID);
  if (!owns) {
    if (!password) {
      res.status(400).json({ error: 'Password is required' });
      return null;
    }
    const ok = await database.verifyPassword(userUUID, password);
    if (!ok) {
      res.status(401).json({ error: 'Invalid UUID or password' });
      return null;
    }
  }
  const raw = await database.getRawUserConfig(userUUID);
  if (!raw) {
    res.status(404).json({ error: 'Configuration not found' });
    return null;
  }
  if (isChildConfig(raw)) {
    res.status(400).json({ error: 'Esta configuracion es un perfil; los perfiles se administran desde la principal.' });
    return null;
  }
  return { userUUID, raw };
}

function cleanName(value) {
  return String(value || '').trim().slice(0, 40);
}

function cleanProfileIndex(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}

function cleanThemeCaps(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const key of THEME_KEYS) {
    if (value[key] === undefined || value[key] === null || value[key] === '') continue;
    const n = Number(value[key]);
    if (Number.isInteger(n) && n >= 0 && n <= 10) out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

function cleanToggles(value) {
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof key === 'string' && key.length <= 200 && typeof enabled === 'boolean') out[key] = enabled;
  }
  return out;
}

async function childView(req, uuid, raw) {
  const n = raw.nuvio || {};
  return {
    uuid,
    name: n.profileName || '',
    profileIndex: n.profileIndex ?? null,
    anime: n.anime !== false && raw.catalogToggles?.['nuvio.recommended.anime'] !== false,
    themeCaps: n.themeCaps || null,
    catalogToggles: raw.catalogToggles || {},
    manifestUrl: buildInstallUrl(process.env.HOST_NAME, req.get('host'), manifestIdentifier(uuid)),
  };
}

async function listChildren(req, parentUUID) {
  const uuids = await database.findChildConfigUUIDs(parentUUID);
  const children = [];
  for (const uuid of uuids) {
    const raw = await database.getRawUserConfig(uuid);
    // findChildConfigUUIDs busca por texto; se confirma que de verdad hereda de esta.
    if (!isChildConfig(raw) || String(raw.inheritsFrom).trim() !== parentUUID) continue;
    children.push(await childView(req, uuid, raw));
  }
  return children.sort((a, b) => (a.profileIndex || 99) - (b.profileIndex || 99) || a.name.localeCompare(b.name));
}

async function writeChild(uuid, passwordHash, raw) {
  await database.saveUserConfig(uuid, passwordHash, raw);
  await configCache.del(uuid).catch(() => undefined);
}

function fail(res, error, fallback) {
  logger.error(`${fallback}: ${error?.message}`);
  const status = error?.status && error.status >= 400 && error.status < 500 ? error.status : 500;
  res.status(status).json({ error: status === 500 ? fallback : error.message });
}

module.exports = {
  async list(req, res) {
    try {
      const auth = await authorizeParent(req, res);
      if (!auth) return;
      const connected = await nuvio.hasNuvioSession(auth.userUUID);
      let profiles = [];
      let nuvioError = null;
      if (connected) {
        try {
          profiles = (await nuvio.getProfiles(auth.userUUID)).map((p) => ({
            index: Number(p.profile_index ?? p.profileIndex),
            name: p.name || p.profile_name || `Perfil ${p.profile_index}`,
          })).filter((p) => Number.isInteger(p.index)).sort((a, b) => a.index - b.index);
        } catch (error) {
          nuvioError = 'No se pudo leer la lista de perfiles de Nuvio';
          logger.warn(`${nuvioError}: ${error.message}`);
        }
      }
      res.json({
        success: true,
        nuvio: { connected, profiles, error: nuvioError },
        main: {
          profileIndex: auth.raw.nuvio?.profileIndex ?? 1,
          anime: auth.raw.nuvio?.anime !== false,
          themeCaps: auth.raw.nuvio?.themeCaps || null,
        },
        children: await listChildren(req, auth.userUUID),
      });
    } catch (error) {
      fail(res, error, 'Failed to list profiles');
    }
  },

  async create(req, res) {
    try {
      const auth = await authorizeParent(req, res);
      if (!auth) return;
      const name = cleanName(req.body?.name);
      const profileIndex = cleanProfileIndex(req.body?.profileIndex);
      if (!name) return res.status(400).json({ error: 'El perfil necesita un nombre' });
      const existing = await listChildren(req, auth.userUUID);
      if (existing.length >= MAX_CHILDREN) return res.status(400).json({ error: `Maximo ${MAX_CHILDREN} perfiles` });
      const owner = await database.getUser(auth.userUUID);
      const uuid = crypto.randomUUID();
      const raw = {
        inheritsFrom: auth.userUUID,
        overrides: {},
        catalogToggles: {},
        nuvio: { profileName: name, ...(profileIndex ? { profileIndex } : {}) },
      };
      // La hija entra con la misma contrasena que la principal.
      await writeChild(uuid, owner.password_hash, raw);
      await database.trustUUID(uuid).catch(() => undefined);
      logger.info(`Perfil "${name}" creado (${uuid.substring(0, 8)}...) bajo ${auth.userUUID.substring(0, 8)}...`);
      res.json({ success: true, child: await childView(req, uuid, raw) });
    } catch (error) {
      fail(res, error, 'Failed to create profile');
    }
  },

  async update(req, res) {
    try {
      const auth = await authorizeParent(req, res);
      if (!auth) return;
      const { childUUID } = req.params;
      const raw = await database.getRawUserConfig(childUUID);
      if (!isChildConfig(raw) || String(raw.inheritsFrom).trim() !== auth.userUUID) {
        return res.status(404).json({ error: 'Perfil no encontrado' });
      }
      const patch = req.body?.patch || {};
      const next = { ...raw, nuvio: { ...(raw.nuvio || {}) } };
      if (patch.name !== undefined) {
        const name = cleanName(patch.name);
        if (!name) return res.status(400).json({ error: 'El perfil necesita un nombre' });
        next.nuvio.profileName = name;
      }
      if (patch.profileIndex !== undefined) {
        const idx = cleanProfileIndex(patch.profileIndex);
        if (idx) next.nuvio.profileIndex = idx; else delete next.nuvio.profileIndex;
      }
      if (patch.anime !== undefined) {
        if (patch.anime === false) next.nuvio.anime = false; else delete next.nuvio.anime;
        // Antes el anime se apagaba con catalogToggles; el interruptor manda sobre eso.
        if (next.catalogToggles && 'nuvio.recommended.anime' in next.catalogToggles) {
          next.catalogToggles = { ...next.catalogToggles };
          delete next.catalogToggles['nuvio.recommended.anime'];
        }
      }
      if (patch.themeCaps !== undefined) {
        const caps = cleanThemeCaps(patch.themeCaps);
        if (caps) next.nuvio.themeCaps = caps; else delete next.nuvio.themeCaps;
      }
      if (patch.catalogToggles !== undefined) {
        const toggles = cleanToggles(patch.catalogToggles);
        if (toggles === undefined) return res.status(400).json({ error: 'catalogToggles invalido' });
        next.catalogToggles = toggles;
      }
      delete next.configHash;
      const owner = await database.getUser(childUUID);
      await writeChild(childUUID, owner.password_hash, next);
      res.json({ success: true, child: await childView(req, childUUID, next) });
    } catch (error) {
      fail(res, error, 'Failed to update profile');
    }
  },

  async remove(req, res) {
    try {
      const auth = await authorizeParent(req, res);
      if (!auth) return;
      const { childUUID } = req.params;
      const raw = await database.getRawUserConfig(childUUID);
      if (!isChildConfig(raw) || String(raw.inheritsFrom).trim() !== auth.userUUID) {
        return res.status(404).json({ error: 'Perfil no encontrado' });
      }
      await database.deleteUserConfig(childUUID);
      logger.info(`Perfil ${childUUID.substring(0, 8)}... borrado de ${auth.userUUID.substring(0, 8)}...`);
      res.json({ success: true });
    } catch (error) {
      fail(res, error, 'Failed to delete profile');
    }
  },

  async connectNuvio(req, res) {
    try {
      const auth = await authorizeParent(req, res);
      if (!auth) return;
      const email = String(req.body?.email || '').trim();
      const nuvioPassword = String(req.body?.nuvioPassword || '');
      if (!email || !nuvioPassword) return res.status(400).json({ error: 'Correo y contrasena de Nuvio son obligatorios' });
      await nuvio.connectNuvio(auth.userUUID, email, nuvioPassword);
      res.json({ success: true });
    } catch (error) {
      fail(res, error, 'No se pudo conectar con Nuvio');
    }
  },

  async disconnectNuvio(req, res) {
    try {
      const auth = await authorizeParent(req, res);
      if (!auth) return;
      await nuvio.disconnectNuvio(auth.userUUID);
      res.json({ success: true });
    } catch (error) {
      fail(res, error, 'No se pudo desconectar Nuvio');
    }
  },
};
