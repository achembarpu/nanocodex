FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY broker.mjs server.mjs ./

USER node
EXPOSE 8789
CMD ["node", "server.mjs"]
