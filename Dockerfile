FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

# REPORTER_PRIVATE_KEY and the rest of .env.example must be supplied at
# runtime (docker run --env-file .env ...) - never baked into the image.
# --import loads otel-init.js before reporter.js so the OTel SDK (opt-in,
# see src/otel-init.ts) is registered before any span/log could be emitted.
CMD ["node", "--import", "./dist/otel-init.js", "dist/reporter.js"]
