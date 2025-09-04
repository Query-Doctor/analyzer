# Adapted from https://github.com/dojyorin/deno_docker_image/blob/master/src/alpine.dockerfile
ARG ALPINE_VERSION=3.22
ARG DENO_VERSION=2.4.5
FROM denoland/deno:alpine-${DENO_VERSION} AS deno

RUN apk add --no-cache \
    perl \
    curl \
    make \
    git \
    postgresql-client

# Download, build, and install pgBadger
ARG PGBADGER_VERSION=13.1
WORKDIR /tmp

RUN curl -L https://github.com/darold/pgbadger/archive/v${PGBADGER_VERSION}.tar.gz | tar -xzf - && \
    cd pgbadger-${PGBADGER_VERSION} && \
    perl Makefile.PL && \
    make && \
    make install && \
    rm -rf /tmp/pgbadger*

FROM gcr.io/distroless/cc-debian12:latest AS cc

FROM alpine:${ALPINE_VERSION} AS sym

COPY --from=cc --chmod=755 --chown=root:root /lib/*-linux-gnu/ld-linux-* /usr/local/lib/
RUN mkdir -p -m 755 /tmp/lib
RUN ln -s /usr/local/lib/ld-linux-* /tmp/lib/

FROM denoland/deno:alpine-${DENO_VERSION} AS build

COPY deno.json deno.lock* ./
RUN deno install --frozen-lockfile

COPY . .

RUN deno compile \
  --allow-run \
  --allow-read \
  --allow-write \
  --allow-env \
  --allow-net \
  -o /app/analyzer \
  src/main.ts

FROM alpine:${ALPINE_VERSION}
ENV LD_LIBRARY_PATH="/usr/local/lib"

RUN apk add -uU --no-cache postgresql-client

COPY --from=deno --chmod=755 --chown=root:root /usr/bin/pg_dump /usr/bin/pg_dump
COPY --from=build --chmod=755 --chown=root:root /app/analyzer /app/analyzer
COPY --from=cc --chmod=755 --chown=root:root /lib/*-linux-gnu/* /usr/local/lib/
COPY --from=sym --chmod=755 --chown=root:root /tmp/lib /lib
COPY --from=sym --chmod=755 --chown=root:root /tmp/lib /lib64

WORKDIR /app
ENV PG_DUMP_BINARY=/usr/bin/pg_dump

RUN sed -i 's|nobody:/|nobody:/home|' /etc/passwd && chown nobody:nobody /home
USER nobody

# Development command
CMD ["/app/analyzer"]

