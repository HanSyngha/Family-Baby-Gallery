FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:client && npm run build:server

# ---

FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY 땅땅로고.png 땅땅로고.ico ./dist/public/

EXPOSE 2280
CMD ["node", "dist/server/index.js"]
