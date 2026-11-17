# syntax=docker/dockerfile:1

FROM node:24-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.build.json
RUN pnpm prune --prod

FROM node:24-slim AS runtime
# The commit the image was built from: /version reports it, and it is the Sentry release.
ARG PIXEL_PHONE_VERSION=dev
ARG PIXEL_PHONE_GIT_SHA=""
ENV NODE_ENV=production \
    PIXEL_PHONE_VERSION=${PIXEL_PHONE_VERSION} \
    PIXEL_PHONE_GIT_SHA=${PIXEL_PHONE_GIT_SHA}
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# No secrets, config or recordings are baked in: secrets come from Key Vault,
# recordings from Blob storage.
USER node
EXPOSE 3000
# No --enable-source-maps: Node would rewrite stack frames to src/*.ts (not in the
# image) before Sentry sees them, so the uploaded maps would never match.
CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
