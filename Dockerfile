FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ src/

RUN mkdir -p cache cache/raw data

EXPOSE 4873 4000
