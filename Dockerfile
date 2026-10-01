# Veriscope — container image.
#
# Works on Spaceship Hyperlift and any Docker host. Three rules matter:
#   1. The persistent volume is mounted at /home/node, so all mutable state
#      (the SQLite database) must live under it. App code goes in /app.
#   2. Hyperlift's default application port is 8080, configured through the
#      environment rather than EXPOSE. Platform-injected PORT wins over this.
#   3. Keep the layer count low. The builder snapshots the whole filesystem per
#      instruction, so every extra COPY/RUN costs real time on each build.
#
# No dependencies to install, so there is nothing to cache between layers and a
# single COPY of the tree is the fastest option.
#
# Required environment variables, set in the platform dashboard:
#   PUBLIC_ORIGIN, QUERY_DIGEST_PEPPER, MAIL_WEBHOOK, DB_PATH, PORT

FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/home/node/data/veriscope.db

WORKDIR /app

# One layer instead of five. .dockerignore keeps data/, node_modules and
# deploy/ out of the image.
COPY --chown=node:node . .

# The app creates the database and its parent directory on first boot.
USER node

CMD ["node", "server/index.mjs"]