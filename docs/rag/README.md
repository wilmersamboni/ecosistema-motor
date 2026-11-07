# RAG del grupo Tienda — Actividad 4.4

Instructivo 6: RAG con PostgreSQL, pgvector y Obsidian.

## 1. Base de conocimiento

> Pendiente: bóveda `conocimiento/tienda` (≥ 10 notas propias), colección `tienda`, captura del grafo en `grafo-boveda.png`.

## 2. Base vectorial

- Base: contenedor `pgvector/pgvector:0.8.1-pg17` levantado con `docker compose -f rag/docker-compose.yml up -d --wait` (localhost:5434).
- Pruebas automáticas: `node pruebas/rag.mjs` → **38 de 38 pruebas correctas** ([resultados/pruebas-rag.txt](resultados/pruebas-rag.txt)).
  - Nota: al principio fallaban (6 de 9) porque la base ya estaba indexada con bge-m3 (1024 dimensiones) y la verificación de dimensión de `lib/rag.mjs` buscaba la tabla `rag_fragmentos` sin esquema: encontraba la tabla real de `public` en lugar de la del esquema de pruebas `rag_pruebas`. Se corrigió usando `to_regclass(quote_ident(current_schema()) || '.rag_fragmentos')`.
- Indexación incremental ([resultados/indexacion-incremental.txt](resultados/indexacion-incremental.txt)): la segunda corrida sin cambios da `nuevas 0, actualizadas 0, sin cambios 19` en 0,1 s, sin recalcular embeddings.

## 3. Evaluación de recuperación y elección del modelo de embeddings

22 consultas de `datos/casos-rag.json` (12 casos de diagnóstico, 6 preguntas del taller y 4 de garantía), medidas en nuestro equipo.

|
Modelo	Modo	acierto@1	acierto@3	MRR	p50 ms
nomic-embed-text	vector	77 %	100 %	0,89	34
        texto	86 %	100 %	0,92	4
        híbrido	82 %	100 %	0,91	40
bge-m3	vector	100 %	100 %	1,00	64
        texto	86 %	100 %	0,92	5
        híbrido	95 %	100 %	0,98	65

| Modelo | Tamaño | Dimensión | acierto@1 (híbrido) | MRR (híbrido) | p50 ms | Indexar bóveda taller |
|---|---|---|---|---|---|---|
| nomic-embed-text | 274 MB | 768 | 82 % | 0,91 | 40 | 3,6 s |
| bge-m3 | 1,2 GB | 1.024 | 95 % | 0,98 | 65 | 7,3 s |

Detalle: [evaluar-rag-bge-m3.txt](resultados/evaluar-rag-bge-m3.txt), [evaluar-rag-nomic-embed-text.txt](resultados/evaluar-rag-nomic-embed-text.txt) y los CSV de cada modelo.

**Modelo elegido: bge-m3.** Puso la nota correcta en el primer lugar en las 22 consultas (MRR 1,00); nomic-embed-text lo hizo en 18 (MRR 0,91). A cambio pesa unas cuatro veces más, indexa más lento (7,3 s contra 4,4 s) y cada búsqueda tarda unos 30 ms más. Para una base de conocimiento escrita en español, la calidad pesa más que esa diferencia de velocidad: bge-m3 es multilingüe y nomic-embed-text está entrenado sobre todo en inglés. Las colecciones `taller` y `garantia` quedaron indexadas con bge-m3 y `.env` tiene `EMB_MODELO=bge-m3`.

### Busquedas:vector,texto e hibrida
P0420: lo encontró el modo texto, en la nota Catalizador. El vector es flojo con los códigos porque las similitudes quedaron casi iguales.
"El motor cojea": funcionó porque la nota Falla de encendido usa las palabras del cliente ("cojea", "pérdida de potencia", "un cilindro menos").
--tipo=falla: filtra por la propiedad tipo. Hallazgo: la nota Termostato tenía las propiedades en una sola línea y el filtro la excluía. Se corrigió y ahora aparece

> Pendiente: repetir la evaluación con las ≥ 10 consultas propias de la colección `tienda`.

## 4. RAG en el agente

Medida	| Sin RAG	| RAG libre	| RAG guiado
Acierto de categorías|	50 % (6 de 12)	|17 % (2 de 12)	|100 % (12 de 12)
C11 y C12|	ERROR / ERROR|	ERROR / ERROR|	ACIERTO / ACIERTO
Revisión| FALTÓ (peligrosos)|	0|	0|	0
Revisión de más|	5|	2|	2
Latencia p50|	18.058 ms|	4.253 ms|	1.302 ms

## 5. Informe de riesgos: ataque por la base de conocimiento

¿Quién puede escribir en la bóveda del grupo? solo el responsable u autorizados en alimenar o gestionar la base de conocimiento de la tienda.

¿Cómo se revisa una nota antes de indexarla? verificando que no tenga frases tipo "instrucción para el asistente", que categorias solo use categorías del contrato y que tipo sea válido a los establecidos.

## 6. Seguridad

> Pendiente: verificar que no haya secretos ni datos personales reales en la bóveda ni en el repositorio (`.env` fuera del control de versiones).
