FROM oven/bun:1.3.13 AS dependencies
WORKDIR /workspace
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
ENV DATABASE_URL=postgres://placeholder:placeholder@localhost:5432/placeholder
ENV E2B_API_KEY=placeholder
ENV E2B_TEMPLATE_ID=placeholder
ENV SANDMAN_DEMO_TOKEN_SHA256=placeholder
ENV SANDMAN_SESSION_SECRET=placeholder
RUN bun run build

FROM oven/bun:1.3.13 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /workspace/build ./build
COPY --from=build /workspace/package.json ./package.json
COPY --from=dependencies /workspace/node_modules ./node_modules
EXPOSE 3000
CMD ["bun", "build/index.js"]
