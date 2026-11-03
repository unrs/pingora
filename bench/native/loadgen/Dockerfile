FROM golang:1.24-alpine AS build
WORKDIR /src
COPY main.go .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /loadgen main.go

FROM alpine:3.21
COPY --from=build /loadgen /loadgen
ENTRYPOINT ["/loadgen"]
