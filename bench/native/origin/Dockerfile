FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -o /origin .

FROM scratch
COPY --from=build /origin /origin
COPY payload.html /data/index.html
ENTRYPOINT ["/origin"]
