FROM node:24-bookworm-slim
WORKDIR /app
COPY bench/server/package.json ./package.json
COPY bench/server/tsconfig.json ./tsconfig.json
RUN npm install --no-audit --no-fund
COPY index.js index.d.ts pingora.linux-x64-gnu.node ./
RUN mkdir -p node_modules/pingora \
  && cp index.js index.d.ts pingora.linux-x64-gnu.node node_modules/pingora/ \
  && printf '{"name":"pingora","main":"index.js"}\n' > node_modules/pingora/package.json
COPY packages/http-server/lib ./packages/http-server/lib
COPY bench/server/apps ./bench/server/apps
