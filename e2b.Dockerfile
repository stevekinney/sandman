# E2B prebuilt template for Sandman.
#
# Bakes in Node.js 20, the Temporal CLI, and the sandbox worker dependencies so
# Sandman's bootstrap step skips the per-boot network installs (~13-50 s saved).
#
# Build and publish with the e2b CLI (requires an authenticated E2B account):
#
#   npx e2b@latest template build --name sandman
#
# Then set the resulting template ID in your .env:
#
#   E2B_TEMPLATE_ID=<id-printed-by-e2b-template-build>
#
# When E2B_TEMPLATE_ID is set, Sandman's provision step calls
# Sandbox.create(templateId, ...) instead of the default base image.
# The bootstrap step still runs ensureRuntimeDependencies (which becomes a
# fast no-op because node and temporal are already on PATH) and npm install
# --prefer-offline (satisfied from the pre-warmed cache below).

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# -- Base tools ---------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# -- Node.js 20 ---------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# -- Temporal CLI -------------------------------------------------------------
# Mirror exactly what client.ts TEMPORAL_INSTALL_CMD does so the bootstrap
# check (`temporal --version`) always exits 0 in this image.
RUN curl -sSf https://temporal.download/cli.sh | sh \
    && ln -sf "$HOME/.temporalio/bin/temporal" /usr/local/bin/temporal

# -- Pre-warm npm cache with sandbox worker dependencies ----------------------
# The bootstrap copies sandbox-template/package.json to /app/package.json at
# runtime, then runs `npm install --prefer-offline`.  Pre-installing here means
# that install step completes from local cache instead of hitting the network.
WORKDIR /app
COPY sandbox-template/package.json ./
RUN npm install
