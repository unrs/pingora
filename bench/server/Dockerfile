FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /app
COPY bench/server/package.json bench/server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.js index.d.ts pingora.linux-x64-gnu.node ./
RUN mkdir -p node_modules/pingora \
  && cp index.js index.d.ts pingora.linux-x64-gnu.node node_modules/pingora/ \
  && printf '{"name":"pingora","main":"index.js"}\n' > node_modules/pingora/package.json
COPY packages/http-server/lib ./packages/http-server/lib
COPY bench/server/apps ./bench/server/apps
RUN npx tsc --ignoreConfig bench/server/apps/nestjs.ts \
  --outDir build \
  --rootDir bench/server/apps \
  --module NodeNext \
  --moduleResolution NodeNext \
  --target ES2022 \
  --experimentalDecorators \
  --emitDecoratorMetadata \
  --esModuleInterop \
  --skipLibCheck \
  --types node
