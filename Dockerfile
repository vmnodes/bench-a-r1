# Dockerfile: packs the app into an image the platform can run.
# Build it with:
#   docker build --build-arg BUILD_COMMIT=$(git rev-parse HEAD) -t my-app .
FROM node:22-alpine
WORKDIR /app

# Install only what the app needs to run, exactly as locked in package-lock.json.
# vendor/ holds the platform's sign-in package until it is on npm; npm ci checks it
# against the integrity hash in package-lock.json.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev --no-audit --no-fund

# Take the package managers OUT of what runs. They are only needed to install,
# and they are where this image's known security problems were: every HIGH
# finding on the starter (2026-09-27) was in npm's own bundled packages
# (brace-expansion, pacote, picomatch, ip-address, sigstore), none in the app.
# The app runs with `node server.js` and never calls npm.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

# WHICH VERSION OF YOUR CODE IS THIS? The platform asks /health, and /health
# reports this value. It deliberately has NO default: a made-up value would look
# fine and be wrong forever. Pass the full 40-character git commit id.
ARG BUILD_COMMIT
RUN case "$BUILD_COMMIT" in \
      "") echo "BUILD_COMMIT is empty: add --build-arg BUILD_COMMIT=\$(git rev-parse HEAD)" >&2; exit 1 ;; \
      *[!0-9a-f]*) echo "BUILD_COMMIT must be a lowercase git commit id, got: $BUILD_COMMIT" >&2; exit 1 ;; \
    esac; \
    if [ "${#BUILD_COMMIT}" != 40 ]; then echo "BUILD_COMMIT must be the full 40 characters, got ${#BUILD_COMMIT}" >&2; exit 1; fi
ENV BUILD_COMMIT=$BUILD_COMMIT

# Copy the app itself. Only what runs goes in: no tests, no dev tools.
COPY server.js store.js ./

# A portal launch (no manifest.json) deploys to port 3000, fixed. If you use the
# Advanced path instead, this must match runtime.port in manifest.json.
EXPOSE 3000
USER node
CMD ["node", "server.js"]
