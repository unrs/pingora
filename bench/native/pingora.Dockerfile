FROM node:24-bookworm-slim
WORKDIR /app
COPY index.js index.d.ts pingora.linux-x64-gnu.node ./
# .mts keeps the entrypoint unambiguously ESM without a `type: module`
# package.json in /app, which would make the CJS index.js loader unloadable.
COPY bench/native/pingora-server.ts ./pingora-server.mts
CMD ["node", "pingora-server.mts"]
