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

- ~~No se toca la interfaz de configuración~~: desde la entrega 4 los perfiles se administran en
  la sección **Perfiles** de la configuración principal (ver 3.4).
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

### 3.2.1 Lo que mostró el historial real (2026-10-05)

| Perfil | Vistos | En progreso | Usa addons del principal |
|---|---|---|---|
| 1 Miguel Angel | 2,000+ (427 títulos) | 817 | — |
| 2 Faby | 118 | 105 | sí |
| 3 Axel | 26 | 15 | sí |
| 4 Sebastián | 492 | 560 | sí |

Consecuencias para el diseño:

- **Requisito en Nuvio**: un perfil con "usar addons del perfil principal" activado nunca ve su
  propia configuración. Hay que desactivarlo en los perfiles 2-4.
- **Una sesión para los 4**: es la misma cuenta, así que la sesión de Nuvio se guarda una vez
  (tabla `nuvio_sessions`, por la configuración principal) y las hijas la usan a través de la
  principal. Supabase **rota el refresh token** en cada renovación: la renovación pasa por un
  solo camino (single-flight) y se guarda el token nuevo al instante, o un perfil invalidaría la
  sesión de los otros.
- **Paginación**: `sync_pull_watched_items` devuelve como máximo 1,000 filas por página.
- **Ids**: casi todo es IMDb (`tt…`); pocos `kitsu:` y `tmdb:`. En la v1 los `kitsu:` no son
  semilla (13 de 1,000 en el perfil más grande).
- **Semillas**: lo marcado como visto cuenta siempre; lo que está en progreso cuenta solo desde el
  80 % (película) o con al menos un episodio al 80 % (serie). Todo lo visto o empezado, con
  cualquier porcentaje, se excluye de las recomendaciones.

### 3.2.2 Posición

Los dos catálogos de recomendaciones van **arriba de todo** en el manifest, por encima de los de
temporada. Usan ids fijos (`nuvio.recommended` / `nuvio.recommended.anime`, tipo `all`) porque
Nuvio pone al final los catálogos nuevos que no estén en el orden guardado del perfil: así se
suben una sola vez y se quedan.

### 3.2.3 Semillas reales y variedad

- **Reproducido vs. marcado a mano**: un título con registro en `sync_pull_watch_progress` se vio
  en Nuvio. Lo demás se marcó a mano, a menudo de memoria y en ráfagas (10 películas de Marvel en
  el mismo minuto), y por ser "lo más reciente" acaparaba las semillas. Las semillas reproducidas
  van primero; las marcadas a mano solo completan, con peso 0.3. Ambas se siguen excluyendo.
- **Variedad**: la lista por puntos se reordena para que, en cada bloque de 10, haya como mucho
  2 de superhéroes (palabras clave de TMDB 9715, 9717, 180547, 229266), 3 de animación,
  2 familiares/infantiles, 2 de anime y 2 empujados por una misma semilla, castigando además lo
  que se parece en géneros a lo recién elegido. Lo que se recorre no se pierde: baja. En el
  catálogo de anime no se aplican los topes de animación ni de infantil.

### 3.4 Sección "Perfiles" en la interfaz

En la configuración principal (`#profiles`). Pide la contraseña de la principal (o una sesión de
cuenta dueña de ella), igual que cargarla; una hija recibe un aviso y no administra nada.

- **Cuenta de Nuvio**: conectar con correo y contraseña (solo se guardan los tokens en
  `nuvio_sessions`) o desconectar. Muestra los perfiles de la cuenta.
- **Esta configuración**: perfil de Nuvio, anime y variedad de la principal; van en `config.nuvio`
  y se aplican con el botón de guardar, como el resto de la configuración.
- **Cada perfil**: nombre, perfil de Nuvio, anime, variedad (Normal / Más flojo / Sin límites),
  catálogos ocultos (`catalogToggles` por `<id>:<type>`), URL del addon, borrar. Se guardan al
  momento porque cada perfil es su propia fila.
- **Agregar perfil**: nombre y perfil de Nuvio; entra con la misma contraseña que la principal.

API (`addon/lib/profilesApi.js`, todas POST con `password`): `/api/profiles/:uuid/list`,
`create`, `update/:child`, `delete/:child`, `nuvio/connect`, `nuvio/disconnect`. Límite propio de
60 peticiones por minuto por configuración.

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
| 4 | Interfaz | Sección Perfiles en la configuración principal | Bajo |

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
