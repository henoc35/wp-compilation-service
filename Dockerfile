# Image Playwright officielle : Node.js + Chromium et toutes ses dépendances système.
# La version doit rester alignée sur celle de playwright-core dans package.json.
ARG PLAYWRIGHT_VERSION=1.65.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    SITES_FILE=/app/config/sites.yml \
    RULES_DIR=/app/rules

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# Interface d'administration (/admin) et migrations de la base (dans src/store/migrations).
COPY public ./public
COPY rules ./rules
COPY config/sites.example.yml ./config/sites.example.yml

RUN mkdir -p /app/data && chown -R pwuser:pwuser /app/data
USER pwuser

EXPOSE 3000
# Par défaut : l'API. Le worker se lance avec « node src/worker/start.js ».
CMD ["node", "src/api/start.js"]
