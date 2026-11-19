FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd cmd
COPY internal internal
RUN CGO_ENABLED=0 go build -o /operator ./cmd/operator
FROM gcr.io/distroless/static:nonroot
COPY --from=build /operator /operator
ENTRYPOINT ["/operator"]
