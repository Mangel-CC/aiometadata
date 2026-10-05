# Perfiles heredados, recomendaciones personales y catálogos de temporada

Estado: **borrador para aprobar** · Fecha: 2026-10-05 · Repo: fork `Mangel-CC/aiometadata`, rama `mangelcc-custom-v3.4.1`

## 1. Problema

Hay 4 perfiles de Nuvio en una sola cuenta. Hoy, dar a cada perfil catálogos distintos obliga a crear
4 configuraciones completas de AIOMetadata y a mantenerlas a mano: cualquier ajuste (idioma, arte,
orden de catálogos) hay que repetirlo 4 veces. Además:

- Las recomendaciones personales dependían de Trakt, que ya no es una opción (de paga) y exigiría
  una cuenta por persona más iniciar sesión dos veces (Nuvio y AIOMetadata).
- No hay catálogos que cambien solos según la fecha (Halloween, Navidad, etc.).

## 2. Objetivos

1. **Herencia**: configuraciones hijas que siguen a una principal; un cambio en la principal se ve
   en las hijas sin tocarlas.
2. **Recomendaciones por perfil**: un catálogo "Recomendado para ti" que sale del historial real de
   ese perfil de Nuvio, sin Trakt ni cuentas extra.
3. **Catálogos de temporada**: catálogos que aparecen y desaparecen solos según la fecha.

### No objetivos

- No se toca la interfaz de configuración de AIOMetadata en esta primera entrega: las hijas se
  crean y administran con un script.
- No se construye un recomendador propio con aprendizaje automático: se usan las recomendaciones
  de TMDB sobre lo que el perfil ya vio.
- No se sincroniza nada hacia Nuvio: AIOMetadata solo lee.

## 3. Decisiones de diseño

### 3.1 Herencia de configuración

Hoy cada configuración es una fila en `user_configs` (`user_uuid`, `config_data` JSON) y casi todo
el código la lee por `database.getUserConfig(uuid)` / `configApi.loadConfigFromDatabase(uuid)`.

Una configuración hija guarda **solo** su diferencia:

```json
{ "inheritsFrom": "<uuid-principal>", "overrides": { "catalogs": [...], "profileName": "Ana" } }
```

- Al leerla, se carga la principal y se le aplican los `overrides` (mezcla superficial por clave de
  primer nivel).
- **`catalogs` nunca se reemplaza.** El orden de los catálogos se edita una sola vez en la
  principal y lo heredan las 4. Lo único que una hija puede cambiar de la lista es activar o
  desactivar catálogos puntuales, con un mapa aparte:

  ```json
  { "catalogToggles": { "nuvio.recommended.anime": false } }
  ```

  Así, arrastrar un catálogo en la interfaz de la principal reordena los 4 perfiles, y quien no ve
  anime simplemente lo apaga en su hija.
- La herencia es de **un solo nivel**: una hija no puede heredar de otra hija. Si la principal
  tiene `inheritsFrom`, se ignora y se registra un aviso.
- Si la principal no existe, la hija responde con su `overrides` tal cual y deja un error en el log;
  nunca se cae el addon.
- La contraseña, el UUID y las credenciales de Nuvio **no se heredan**: son de cada hija.

**Caché**: la clave de caché de meta/catálogo ya se deriva del contenido de la configuración, así
que la hija resuelta produce las mismas claves que una configuración normal equivalente. Para que
un cambio en la principal invalide a las hijas, la configuración resuelta incluye un campo
`_inheritedFrom: { uuid, updatedAt }`, de modo que al cambiar la principal cambia el hash.

### 3.2 Recomendaciones desde el historial de Nuvio

Nuvio expone por perfil (API `api.nuvio.tv`, mismo camino que usa AIOManager):

- `sync_pull_profiles` → lista de perfiles con su `profile_index`.
- `sync_pull_watched_items` → lo ya visto.
- `sync_pull_watch_progress` → lo empezado.

Dos catálogos nuevos, los dos mezclan películas y series:

- `nuvio.recommended` — "Recomendado para ti".
- `nuvio.recommended.anime` — "Anime recomendado para ti". Se puede apagar por perfil con
  `catalogToggles` para quien no ve anime. Un título cuenta como anime con la misma detección que
  ya usa el addon (`addon/utils/isAnime`).

Cómo se arma la lista:

1. Lee el historial del perfil (caché de 30 min).
2. Se queda solo con lo que cuenta como **visto de verdad** (ver umbrales abajo), toma hasta 40
   títulos recientes y los convierte a id de TMDB con el mapeador de ids que ya existe.
3. Para cada uno pide `/movie/{id}/recommendations` o `/tv/{id}/recommendations` a TMDB.
4. Junta los resultados, suma puntos cuando un título aparece recomendado por varias semillas,
   **descarta lo ya visto y lo que está en progreso**, y ordena por esa puntuación.
5. Separa anime del resto y devuelve cada lista paginada en su catálogo.

**Qué cuenta como visto** (una vista a medias dice poco del gusto, y una abandonada dice lo
contrario):

- **Película**: vista al **80 %** o más.
- **Serie**: un episodio cuenta al 80 %; la serie entra como semilla cuando hay **al menos un
  episodio** así. Las series abandonadas antes de ese punto no se toman en cuenta.

El 80 % para películas es el mismo criterio que usan Trakt y la mayoría de rastreadores, y deja
fuera los créditos finales. Queda configurable por si lo quieres mover.

Configuración por hija:

```json
{ "nuvio": { "profileIndex": 2, "refreshToken": "<token>" } }
```

El token se guarda cifrado con el mecanismo que ya usa la configuración para credenciales. Se usa
un **refresh token** para no guardar contraseñas y poder revocar desde Nuvio.

**Degradación**: sin token, con historial vacío o si Nuvio falla, el catálogo devuelve lista vacía
y el resto del addon sigue igual.

### 3.3 Catálogos de temporada

Catálogos `seasonal.<id>` definidos en un archivo de datos (`addon/static/seasonal.json`), cada uno
con su ventana de fechas y su consulta a TMDB:

```json
{
  "id": "halloween",
  "name": { "es-MX": "Especial de Halloween", "en-US": "Halloween Picks" },
  "window": { "from": "10-01", "to": "11-02" },
  "query": { "with_genres": "27,9648", "sort_by": "popularity.desc", "vote_count.gte": 200 }
}
```

- La ventana se evalúa con la **zona horaria de la configuración** (por defecto
  `America/Mexico_City`), no en UTC, para que no se adelante ni se atrase un día.
- Ventanas que cruzan el año (por ejemplo 12-15 a 01-06) se soportan.
- Fuera de ventana el catálogo **no aparece en el manifest**. Para que Stremio/Nuvio noten el
  cambio, el manifest de una configuración con catálogos de temporada se cachea como máximo hasta
  el próximo cambio de ventana (y nunca más de 6 h).
- Catálogos iniciales: Halloween, Navidad, San Valentín, Día de Muertos, Verano. Se pueden agregar
  más editando solo el JSON.

## 4. Plan de entrega

| # | Entrega | Alcance | Riesgo |
|---|---------|---------|--------|
| 1 | Herencia | Resolución en `getUserConfig`, script para crear/editar hijas | Bajo |
| 2 | Temporada | `seasonal.json`, filtro por fecha en el manifest, handler de catálogo | Bajo |
| 3 | Recomendaciones | Cliente de Nuvio, catálogo `nuvio.recommended` | Medio |

Cada entrega se prueba y se despliega por separado, con la imagen anterior guardada para revertir.

## 5. Pruebas

- **Herencia**: hija sin overrides es idéntica a la principal; un cambio en la principal se refleja
  en la hija; `catalogs` en overrides reemplaza; principal inexistente no rompe; herencia anidada se
  ignora.
- **Temporada**: dentro de ventana aparece y fuera no; ventana que cruza el año; zona horaria
  correcta en el borde del día; el manifest expira al cambiar la ventana.
- **Recomendaciones**: perfil sin historial da lista vacía; lo ya visto nunca aparece; un título
  recomendado por varias semillas queda por encima; Nuvio caído no rompe el catálogo.

## 6. Decisiones ya tomadas

1. Las 3 hijas comparten idioma y arte con la principal. Lo único propio son las recomendaciones.
2. El orden de los catálogos se edita en la principal y lo heredan las 4 (ver 3.1).
3. Recomendaciones: un catálogo mezclando películas y series, más uno de anime apagable por perfil.
4. Los catálogos de temporada van en los 4 perfiles.
5. Umbral de "visto": 80 % en películas y en episodios de serie.
