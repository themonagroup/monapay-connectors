FROM node:20-alpine

WORKDIR /app
COPY --chown=node:node sdk/node/dist ./sdk/node/dist
COPY --chown=node:node connectors ./connectors

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=8787

USER node
EXPOSE 8787
CMD ["node", "connectors/core/server.js"]
