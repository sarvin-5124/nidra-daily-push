# Bun, not node: the scripts import .ts directly and rely on Bun's loader.
# The VPS only has node 22, so the runtime ships in the image.
FROM oven/bun:1-alpine

WORKDIR /app

# Dependencies first so a code-only change reuses this layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY config ./config
COPY public ./public
# Seeds an empty volume with the history that used to live in git — see
# ensureDataDir() in src/paths.ts.
COPY schedules ./schedules

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000

# The container IS the scheduler. If it stops, pushes stop, so lean on Docker's
# restart policy rather than exiting quietly on a transient error.
CMD ["bun", "run", "src/index.ts"]
