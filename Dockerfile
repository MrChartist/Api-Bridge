# Mr. Chartist API Bridge in a container. Use docker-compose.yml, which publishes the port on 127.0.0.1 only.
#   docker compose up -d && docker compose logs bridge     (the first start prints your admin key once)
# Pinned by digest (the tag alone can be re-pointed); Dependabot proposes updates.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4

ENV NODE_ENV=production \
    MCB_CONFIG=/data/bridge.config.json \
    MCB_MASTER_KEY_FILE=/secrets/master.key \
    MCB_DOCKER=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY bin ./bin
COPY server ./server
COPY src/lib ./src/lib
COPY docs/openapi.yaml ./docs/openapi.yaml
COPY bridge.config.example.json LICENSE ./
COPY docker/entrypoint.sh /usr/local/bin/mcb-entrypoint
RUN printf '#!/bin/sh\nexec node /app/bin/mc-bridge.mjs "$@" --config "${MCB_CONFIG}"\n' > /usr/local/bin/mc-bridge \
 && chmod 755 /usr/local/bin/mc-bridge /usr/local/bin/mcb-entrypoint \
 && rm -rf server/brokers/__fixtures__ \
 && find server -name '*.test.mjs' -delete \
 && mkdir -p /data /secrets && chown -R node:node /data /secrets

USER node
VOLUME ["/data", "/secrets"]
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4300/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["mcb-entrypoint"]
CMD ["start"]
