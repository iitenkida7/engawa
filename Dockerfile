# Host-agnostic container image for engawa. Builds the Vite client bundle and
# serves it from the Bun signaling server on a single port (static files + /ws
# + /api on the same origin). TLS termination and any host-specific config
# (e.g. fly.toml) are intentionally NOT part of this image — terminate HTTPS at
# your reverse proxy / platform edge and run a single instance (the signaling
# state is in-memory, so it must not be scaled horizontally).

# ---- build the client bundle ----
# The shared wire-protocol types (engawa/shared) sit one level above each
# package, matching the source tree, so the ../shared imports resolve.
FROM oven/bun:1.2-alpine AS client
WORKDIR /repo/client
COPY engawa/client/package.json engawa/client/bun.lockb ./
RUN bun install --frozen-lockfile
COPY engawa/shared/ /repo/shared/
COPY engawa/client/ ./
RUN bun run build

# ---- runtime: Bun server serves the built client + signaling ----
FROM oven/bun:1.2-alpine AS runtime
WORKDIR /app/server
COPY engawa/shared/ /app/shared/
COPY engawa/server/ ./
COPY --from=client /repo/client/dist ./public
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "src/index.ts"]
