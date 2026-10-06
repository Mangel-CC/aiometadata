# Evaluación del motor de recomendaciones v2 — 2026-10-06

Método (ver `motor-recomendaciones-v2.md`, 3.6): por perfil, 3 cortes hacia atrás; en cada uno se
esconden los 10 títulos más recientes que gustaron y se vieron en Nuvio, el motor recomienda con el
historial anterior al corte (y "viviendo" en la fecha del corte), y se cuenta cuántos escondidos aparecen
en el top 20 de "Recomendado para ti" + el top 20 de "Anime recomendado para ti".

Perfil 3 (Axel) no tiene historial suficiente para 3 cortes y no se evalúa.

## Resultados

| Perfil | Motor | Acierto@20 | Acierto@50 | Acierto@200 |
|---|---|---|---|---|
| 1 Miguel Angel | v1 | 13 % | 13 % | 23 % |
| 1 Miguel Angel | **v2** | **17 %** | **20 %** | **40 %** |
| 2 Faby | v1 | 0 % | 3 % | 3 % |
| 2 Faby | **v2** | **3 %** | **3 %** | **13 %** |
| 4 Sebastián | v1 | 0 % | 0 % | 7 % |
| 4 Sebastián | **v2** | **10 %** | **10 %** | **23 %** |

Promedio acierto@20: v1 4.4 % → v2 10.0 %. Variedad del top 20 sin cambios (≈ 19 franquicias distintas
de 20; superhéroes dentro de los topes).

## Qué movió la aguja

1. **Estrenos como fuente propia** y sin exigir votos a lo de menos de un año: los escondidos del perfil 1
   eran casi todos anime de temporada con 0–4 votos en TMDB, que el v1 y la primera versión del v2
   descartaban.
2. **Etiquetas de AniList** en el ADN del anime: en TMDB los estrenos no tienen palabras clave; con
   AniList (Isekai, Reincarnation…) el perfil de contenido los distingue.
3. **Pesos ajustados** con 96 combinaciones: ganó `cf 0.2, contenido 0.4, tmdb 0.1, calidad 0.15,
   frescura 0.2, tendencia 0.15`. El contenido pesa más que el colaborativo porque gran parte de lo que se
   ve es anime y series, que MovieLens no cubre.

## Límites conocidos

- Las métricas absolutas son bajas porque el ejercicio es duro (adivinar exactamente lo que se vio entre
  miles de opciones, incluidas caricaturas cortas y lo que ve la familia en el mismo perfil).
- MovieLens llega hasta 2023 y solo tiene películas.
- Faby tiene poco historial: su lista mejora sola a medida que vea más.

## Segunda ronda: personalización (mismo día)

Con los pesos de arriba (frescura y tendencia **sumando** por su cuenta) los 4 perfiles en producción
empezaban casi igual (los mismos estrenos populares). La métrica de acierto no lo castigaba porque mucho de
lo que se ve son estrenos. Se añadió al evaluador "títulos compartidos entre los top 20 de dos perfiles" y
se cambió la fórmula: calidad, frescura y tendencia ahora **multiplican** la relevancia (colaborativo +
contenido + TMDB) en vez de sumarse.

| Fórmula | Acierto@20 | Compartidos entre perfiles |
|---|---|---|
| v1 | 4.4 % | — |
| v2 suma | 10.0 % | 7.7 / 20 |
| **v2 multiplicativa (en producción)** | **8.9 %** | **3.7 / 20** |

Pesos en producción: `cf 0.2, contenido 0.8, tmdb 0.1, calidad 0.6, frescura 1.5, tendencia 0.4`.
En producción, después del cambio, los pares de perfiles comparten entre 0 y 6 de 20 títulos.
