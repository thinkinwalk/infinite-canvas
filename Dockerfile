FROM node:22-alpine AS web-build

WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm install --legacy-peer-deps && npm install --legacy-peer-deps --save=false @rollup/rollup-linux-x64-musl@4.62.2 lightningcss-linux-x64-musl@1.32.0 @tailwindcss/oxide-linux-x64-musl@4.2.4
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN npm run build

FROM golang:1.25-alpine AS api-build

WORKDIR /app
COPY go.mod go.sum ./
COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY main.go ./
RUN go build -o /server .

FROM alpine:3.22

WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=api-build /server /app/server
COPY --from=web-build /app/web/dist /app/web/dist
RUN apk add --no-cache ca-certificates && mkdir -p /app/data/prompts

ENV PORT=3000
ENV STATIC_DIR=/app/web/dist
ENV PROMPT_DATA_DIR=/app/data/prompts

EXPOSE 3000
CMD ["/app/server"]
