FROM node:24-bookworm-slim
WORKDIR /app
ARG BINDING=pingora-full.node
COPY index.js index.d.ts bench/native/${BINDING} ./
RUN mv ${BINDING} pingora.linux-x64-gnu.node
COPY bench/native/pingora-server.mjs ./
CMD ["node", "pingora-server.mjs"]
