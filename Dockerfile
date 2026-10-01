# Veriscope — container image.
#
# Works on Spaceship Hyperlift and any Docker host. Two rules matter:
#   1. The persistent volume is mounted at /home/node, so ALL mutable state
#      (the SQLite database) must live under it. App code goes in /app.
# 8080 is Hyperlift's default application port. Platform-injected PORT wins
# over this value, so setting PORT in the dashboard also works.
# Do not rely on EXPOSE here; Hyperlift routes using the environment variable.
#
# Required environment variables are set in the platform's dashboard:
#   PUBLIC_ORIGIN, QUERY_DIGEST_PEPPER, MAIL_WEBHOOK, DB_PATH, PORT

FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/home/node/data/veriscope.db

WORKDIR /app

# No dependencies to install; copy the app and drop privileges.
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node tools ./tools

# Data lives on the volume, so only the directory is needed here.
RUN mkdir -p /home/node/data && chown -R node:node /home/node

USER node

# The app creates the DB and its parent directory on first boot.
CMD ["node", "server/index.mjs"]