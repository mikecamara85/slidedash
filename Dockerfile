# --- deps stage ---
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- build stage ---
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY . .
RUN npm run build

# --- runtime stage ---
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist /app/dist
EXPOSE 8080
CMD ["node", "dist/server.js"]