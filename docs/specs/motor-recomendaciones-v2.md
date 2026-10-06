# Motor de recomendaciones v2

Estado: **en producción (2026-10-06)** · Repo: fork `Mangel-CC/aiometadata`, rama `mangelcc-custom-v3.4.1`
Reemplaza la sección 3.2 de `perfiles-recomendaciones-temporadas.md` (lo demás de ese documento sigue igual).

## 1. Problema

El motor v1 no recomienda: reordena lo que TMDB ya recomienda ("a quien le gustó X le gustó Y"). Consecuencias:

- El criterio es de TMDB, no del gusto del perfil.
- Todo lo visto vale igual: algo abandonado a la mitad cuenta como algo que gustó.
- Las franquicias se refuerzan solas: 15 títulos de Marvel marcados dan 15 votos a Marvel y la lista se
  llena de Marvel.
- No hay forma de saber si recomienda bien: no se mide.

## 2. Objetivos

1. Deducir **qué tanto gustó** cada título a partir de cómo se vio (no hay calificaciones en Nuvio).
2. Recomendar con **varias fuentes** propias: filtrado colaborativo con datos de personas reales, parecido
   de contenido con el gusto del perfil, y TMDB como una fuente más.
3. **Variedad**: ninguna franquicia, tema o tipo acapara la lista, sin importar cuánto se haya visto de ella.
4. **Medir**: cada versión del motor se evalúa con el historial real antes de desplegarse.
5. Explicar cada recomendación ("Porque viste…").

### No objetivos

- **IA de pago** (Gemini/Claude/OpenRouter): descartada por costo; el motor es 100 % algorítmico.
- Escribir en Nuvio o pedir calificaciones al usuario.

## 3. Diseño

### 3.1 Señales: gusto deducido

Cada título visto o empezado recibe un **gusto** entre −1 y +1 y un **peso de tiempo**.

| Situación | Gusto |
|---|---|
| Película terminada (≥ 80 %) en Nuvio | +1.0 |
| Película o serie **marcada como vista** (sin reproducción en Nuvio) | +0.9 |
| Serie: episodios vistos al ≥ 80 % | +0.6 con 1 episodio, sube con log(episodios) hasta +1.0 con ~10 |
| Repetida (vista más de una vez) | +0.2 extra (tope +1.0) |
| Película abandonada: entre 15 % y 80 % y sin tocar en 30 días | −0.6 |
| Serie abandonada: 1–2 episodios y sin tocar en 45 días | −0.4 |
| Empezada hace poco (todavía en curso) | 0 (no es señal, solo se excluye) |
| Menos de 15 % y nunca retomada | 0 (probó y no le enganchó; demasiado débil para castigar) |

**Peso de tiempo** (lo reciente dice más del gusto de hoy, sin borrar lo viejo):

- Reproducido en Nuvio: vida media de 12 meses sobre la fecha real, con piso de 0.35.
- **Marcado a mano: peso fijo de 0.7.** No se sabe cuándo se vio; la fecha en que se marcó no dice nada
  y no se usa. (Corrige al v1, que lo bajaba a 0.3 y a la vez lo trataba como "reciente" por la fecha del
  marcado.)

### 3.2 Saturación por franquicia

Los títulos se agrupan por **franquicia**: la colección de TMDB (`belongs_to_collection`) y, para universos
que cruzan colecciones, palabras clave de universo (MCU 180547, DCEU 229266, y las que se agreguen en una
lista). Dentro de un grupo de *n* títulos con gusto positivo, cada uno aporta su peso dividido entre √n: 15
de Marvel valen ≈ 3.9 títulos, no 15. Los gustos negativos no se saturan.

### 3.3 Fuentes de candidatos

| Fuente | Qué aporta | Cubre |
|---|---|---|
| **Colaborativo (MovieLens 32M)** | "A personas con tus gustos también les gustó": vecinos ítem-ítem calculados con 32 millones de calificaciones reales | Películas hasta 2023 |
| **Contenido** | Títulos cuyo "ADN" (géneros, palabras clave, director, actores principales, estudio, idioma, época) se parece al perfil de gusto | Películas y series, incluidos estrenos |
| **TMDB recomendaciones/similares** | Lo que usaba el v1, ahora como una fuente más | Películas y series |
| **Estrenos** | Películas de los últimos 5 meses ya en digital en MX, anime de temporada (estrenos y temporadas nuevas al aire) y series nuevas; los decide el perfil de contenido | Frescura, anime de temporada |

Cada fuente entrega hasta ~300 candidatos con su puntuación normalizada a 0–1.

**Colaborativo**: se descarga `ml-32m` una vez (≈ 900 MB descomprimido; solo se conserva el resultado).
Se convierten las calificaciones en similitud coseno ítem-ítem sobre películas con ≥ 50 calificaciones
(normalizando por usuario), y se guardan los 100 vecinos de cada película en la tabla `ml_neighbors
(tmdb_id, neighbor_tmdb_id, score)` (≈ 2–3 M filas). Para un perfil, la puntuación de un candidato es la
suma de similitud × gusto × peso de sus semillas. Se recalcula solo si se actualiza el dataset.

**Etiquetas de AniList** (anime): en TMDB los estrenos de anime casi no tienen palabras clave; se buscan
en AniList por título original (aceptando solo si el año coincide ±1) y sus etiquetas con relevancia ≥ 40
entran al ADN. Un lote de 10 cada 2.5 s, respetando `Retry-After`, cacheado 30 días.

**Contenido**: el ADN de cada título se arma con datos de TMDB (detalles, palabras clave, créditos),
cacheado 30 días. El perfil de gusto es la suma de los ADN de lo visto, multiplicada por gusto × peso
(con saturación), con TF-IDF para que rasgos comunes como "drama" no dominen sobre rasgos distintivos como
"viajes en el tiempo". Los gustos negativos restan. La puntuación es el coseno entre candidato y perfil.

### 3.4 Ranking

```
puntuación = a·colaborativo + b·contenido + c·tmdb + d·calidad + e·frescura
```

- **Calidad**: calificación bayesiana `(v·R + m·C)/(v + m)` (no deja que 8 votos de 9.5 le ganen a
  20,000 de 8.1).
- **Frescura**: bono pequeño a lo de los últimos 2 años.
- Los pesos `a…e` **no se eligen a ojo**: se ajustan con la evaluación (3.6).
- Se excluye todo lo visto o empezado, con cualquier porcentaje.

### 3.5 Variedad (sobre la lista ya puntuada)

Se conserva la del v1 y se añade un tope por franquicia, tanto para lo recomendado como para lo visto:

- En cada bloque de 10: máximo **1 por franquicia**, 2 superhéroes, 3 animación, 2 familiar/infantil,
  2 anime, 2 venidos de la misma semilla principal.
- Penalización por parecido de géneros con los 5 anteriores (MMR).
- Topes por perfil (`config.nuvio.themeCaps`), como Sebastián.

### 3.6 Evaluación

Por perfil, con el historial real:

1. Se esconden los **últimos 20 títulos reproducidos** (lo marcado a mano no, porque no tiene fecha real).
2. El motor recomienda usando solo lo anterior.
3. Métricas: **acierto@20** (cuántos de los escondidos aparecen en el top 20), **NDCG@20** (premia
   acertarlos arriba) y **variedad@20** (franquicias distintas y temas distintos en el top 20).

El v1 se mide igual como línea base. Un cambio se despliega solo si mejora el acierto sin bajar la
variedad. El reporte queda en `docs/specs/motor-recomendaciones-v2-evaluacion.md`.

### 3.7 Explicaciones

Cada recomendación guarda sus 1–2 semillas que más aportaron; la descripción del título en el catálogo
empieza con "Porque viste X y Y" (o "Porque te gustan las historias de viajes en el tiempo" si vino del
perfil de contenido).

### 3.7.1 Validez (2026-10-06)

Una recomendación solo entra si tiene relación real con lo visto:

- **Parecido**: comparte ≥ 2 rasgos concretos (temas, personas, estudio, etiquetas de AniList) con un
  título visto, **del mismo público** (infantil con infantil; adultos y anime entre sí) y con **al menos
  un género en común** (géneros de series traducidos a los de cine). Se explica "Porque viste X".
- **O colaborativo de varios**: la eligen los fans de ≥ 2 títulos vistos compatibles. Se explica "A
  quienes vieron X y Y también les gustó".
- Si no cumple ninguna, se descarta aunque puntúe alto. El segundo título citado solo aparece si se
  parece al menos la mitad que el primero.
- Palabras clave que no dicen nada del gusto (créditos con escena extra, "basada en libro/manga",
  "secuela", "anime"…) no cuentan.
- Las fuentes se comparan por percentil (si no, el colaborativo, de escala mayor, decidía solo).
- Se descartó castigar lo archiconocido: de 8 clásicos recomendados, el usuario había visto 2.
- **Anime y lo demás son mundos separados**: dos perfiles de contenido (uno por cada catálogo), y el
  colaborativo/TMDB de una semilla solo cuenta para candidatos de su mismo mundo. Antes Danmachi o Black
  Clover empujaban Harry Potter y El Señor de los Anillos a "Recomendado para ti".
- **Temas, no solo géneros**: las palabras clave de TMDB se clasifican al construir el ADN (con el nombre
  que ya trae la respuesta, sin peticiones extra) en tema de la historia, tono ("amused"), lugar/época
  ("washington dc", "1980s") o dato de producción ("sequel"). En el perfil pesan 1 / 0.2 / 0.3 / 0, y para
  citar "Porque viste X" hace falta al menos un tema en común (o etiqueta de AniList), o el mismo
  director/creador. Evaluación: acierto@20 5.6 % → 6.7 %, ndcg del perfil 1 0.098 → 0.141.
- En series se cita el nombre que más se repite entre los episodios (Nuvio a veces guarda "Episodio 12").
- Público estricto (anime con anime, infantil con infantil, lo demás entre sí) y géneros en común de al
  menos un cuarto (Jaccard ≥ 0.25 tras traducir géneros de series), o el mismo director/creador.

### 3.8 Rendimiento y cuotas

- Nada de MDBList. TMDB con caché (ADN 30 días, recomendaciones 24 h) y concurrencia limitada.
- La lista se recalcula cada 30 minutos por perfil, como hoy; el primer cálculo después de desplegar puede
  tardar más mientras se llena la caché de ADN.
- El cálculo pesado (MovieLens) se hace una vez, fuera de las peticiones.

## 4. Entregas

| # | Entrega | Cambia producción |
|---|---|---|
| 1 | Señales (3.1, 3.2) + evaluador (3.6) + línea base del v1 | No |
| 2 | Perfil de contenido (3.3 contenido) + evaluación | No |
| 3 | MovieLens colaborativo (3.3) + evaluación | No |
| 4 | Ranking híbrido con pesos ajustados (3.4), variedad (3.5), explicaciones (3.7) | **Sí** |
| 5 | ~~Capa de IA~~ | Descartada (costo) |

## 5. Decisiones tomadas

1. Lo marcado a mano cuenta casi como lo reproducido (+0.9) y con peso de tiempo fijo; lo que se corrige
   es el exceso de una misma franquicia, no lo marcado.
2. Variedad por encima de "más de lo mismo": tope de 1 por franquicia por bloque de 10.
3. Se descarga MovieLens 32M para el colaborativo.
4. Sin IA de pago.
5. Con APIs de terceros: caché, ritmo bajo y respetar sus límites (MDBList no se usa).
