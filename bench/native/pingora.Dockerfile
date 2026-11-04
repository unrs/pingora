FROM node:24-bookworm-slim
WORKDIR /app
COPY index.js index.d.ts pingora.linux-x64-gnu.node ./
COPY bench/native/pingora-server.ts ./
CMD ["node", "pingora-server.ts"]
