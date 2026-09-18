# Runs `prisma migrate deploy` against DATABASE_URL and exits.
FROM node:24-alpine
WORKDIR /db
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY prisma.config.ts ./
COPY prisma ./prisma
CMD ["npx", "prisma", "migrate", "deploy"]
