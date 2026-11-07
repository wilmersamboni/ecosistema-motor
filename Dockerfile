# Imagen de los simuladores del ecosistema MotorRed. Cada contenedor corre un servicio distinto.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY contrato ./contrato
COPY lib ./lib
COPY simuladores ./simuladores
COPY datos ./datos
USER node
