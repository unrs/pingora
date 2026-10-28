FROM rust:1.89-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock src/main.rs ./src/main.rs
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/raw-pingora /usr/local/bin/raw-pingora
ENTRYPOINT ["/usr/local/bin/raw-pingora"]
