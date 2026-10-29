FROM golang:1.23-alpine AS build
WORKDIR /src
COPY main.go ./
RUN CGO_ENABLED=0 go build -o /origin main.go

FROM scratch
COPY --from=build /origin /origin
COPY payload.html /data/index.html
ENTRYPOINT ["/origin"]
