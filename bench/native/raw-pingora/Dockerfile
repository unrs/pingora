FROM rust:1.99.1-bookworm AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src/main.rs ./src/main.rs
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/raw-pingora /usr/local/bin/raw-pingora
ENTRYPOINT ["/usr/local/bin/raw-pingora"]
