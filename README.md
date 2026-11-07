# Ecosistema MotorRed

Proyecto integrador del complementario *Implementación de soluciones de inteligencia artificial*
(SENA, 21730210). Cuatro grupos construyen cuatro servicios con agentes de IA que trabajan juntos:

| Grupo | Servicio | Papel |
|---|---|---|
| Falla | Taller | Orquestador del servicio: recepción, diagnóstico, cotización y aprobación |
| José | Tienda de repuestos | Proveedor: catálogo, compatibilidad, reservas y despacho |
| Emerson | Concesionario | Proveedor de originales, garantías de fábrica y campañas |
| Zaidy | Ventas y contabilidad | Orquestador comercial: venta, cobro, liquidación y dispersión |

Este kit trae lo que los cuatro comparten:

- `contrato/`: el contrato (esquemas, herramientas MCP, alcances y errores). Las versiones TypeScript para NestJS están en `contrato/ts/`.
- `simuladores/`: una implementación de referencia de cada grupo, más una pasarela de pagos simulada.
- `pruebas/conformidad.mjs`: comprueba que el servicio de un grupo cumple el contrato.
- `pruebas/escenarios.mjs`: seis casos de punta a punta: normal, garantía, pago rechazado, compensación, retención y seguridad.
- `lib/agente.mjs` y `agentes/`: agentes de referencia con barandas (diagnóstico, asesor libre y asesor guiado).
- `pruebas/agentes.mjs`: prueba los agentes con un modelo simulado.
- `pruebas/traza.mjs`: muestra la historia de una orden en todos los servicios.
- `conocimiento/`: bóvedas de Obsidian (taller y garantía del concesionario) para el RAG.
- `lib/rag.mjs` y `rag/`: RAG con PostgreSQL + pgvector (indexar, buscar), con su base en `rag/docker-compose.yml`.
- `pruebas/rag.mjs` y `pruebas/evaluar-rag.mjs`: pruebas y evaluación del RAG.

## Uso rápido

```
npm ci
npm run ecosistema                 # inicia los 5 simuladores (déjelo abierto)
npm run escenarios                 # en otra terminal: pruebas de punta a punta (se pueden repetir)
node pruebas/conformidad.mjs tienda
node pruebas/traza.mjs             # historia de la última orden
node agentes/asesor-guiado.mjs     # asesor del taller: el código lleva el flujo (pensado para modelos pequeños)
node agentes/asesor.mjs            # asesor libre: el modelo elige las herramientas (qwen3:8b o nube)
```

RAG (Instructivo 6):

```
docker compose -f rag/docker-compose.yml up -d     # PostgreSQL 17 + pgvector en localhost:5434
node pruebas/rag.mjs                               # pruebas automáticas (no necesita modelo)
node rag/indexar.mjs                               # indexa conocimiento/taller (requiere EMB_MODELO)
node rag/buscar.mjs "el motor cojea y pierde fuerza"
node pruebas/evaluar-rag.mjs                       # acierto@1, acierto@3 y MRR por modo de búsqueda
node pruebas/evaluar-diagnostico.mjs --rag         # el agente de diagnóstico con RAG
```

Para conectar el servicio real de un grupo:

1. Ponga su dirección en `.env`, por ejemplo `URL_TIENDA=http://localhost:3000`.
2. Inicie el ecosistema sin ese simulador: `node ecosistema.mjs --sin tienda`.
3. Corra `node pruebas/conformidad.mjs tienda` y luego `npm run escenarios`.

Requiere Node.js 20.19 o superior. Las tarifas tributarias del `.env` son valores de práctica.
