# Plantilla del servicio de un grupo (NestJS)

Trae resuelta la "plomería" común del ecosistema:

- `POST /oauth/token`: credenciales de servicio con alcances.
- `/mcp`: servidor MCP que publica solo las herramientas que permiten los alcances del token.
- `GET /salud`.
- `src/mcp/firma.ts`: verificación de la firma de los eventos.
- `src/contrato/`: el contrato en TypeScript.

El trabajo del grupo empieza en `src/negocio/herramientas.service.ts`.

```
npm ci
GRUPO=tienda PUERTO=3000 npm start        (en PowerShell: $env:GRUPO="tienda"; $env:PUERTO="3000"; npm start)
```

Desde la carpeta del kit, con el ecosistema corriendo:

```
node pruebas/conformidad.mjs tienda --url http://localhost:3000
```

Sin implementar nada, ya pasan las secciones `general` y `herramientas`. La sección `reglas` es su trabajo.

Agregue PostgreSQL con TypeORM y migraciones como en el proyecto espiga-pro (Instructivo 4).

## RAG (Instructivo 6)

`src/rag/rag.service.ts` busca en la base de conocimiento del grupo (PostgreSQL + pgvector) con la misma
consulta híbrida del kit. La bóveda de Obsidian se indexa con el kit (`node rag/indexar.mjs
--boveda=... --coleccion=...`); el servicio solo consulta. Configure `RAG_DB_URL`, `EMB_URL` y
`EMB_MODELO` en `.env` (el mismo modelo con que se indexó).
