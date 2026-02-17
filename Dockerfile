ARG ALPINE_VERSION=3.22
ARG PG_IMAGE=pg14-timescale-2.16
FROM alpine:${ALPINE_VERSION} AS pgbadger-builder

RUN apk add --no-cache \
    perl \
    curl \
    make

ARG PGBADGER_VERSION=13.2
WORKDIR /tmp

RUN curl -L https://github.com/darold/pgbadger/archive/v${PGBADGER_VERSION}.tar.gz | \
    tar -xzf - && \
    cd pgbadger-${PGBADGER_VERSION} && \
    perl Makefile.PL && \
    make && \
    make install && \
    rm -rf /tmp/pgbadger*

# Build the application
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm ci --omit=dev

# Final image
ARG PG_IMAGE
ENV LD_LIBRARY_PATH="/usr/local/lib"
FROM node:24-alpine

RUN apk add -uU --no-cache \
    readline \
    zlib \
    bash \
    su-exec \
    openssl \
    krb5 \
    postgresql17-client \
    perl

# Copy pgBadger
COPY --from=pgbadger-builder /usr/local/bin/pgbadger /usr/local/bin/pgbadger

COPY --from=ghcr.io/query-doctor/postgres:pg14-timescale-2.16 /usr/local/pgsql /usr/local/pgsql

# Copy application
COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules

# Setup postgres user and directories
RUN mkdir -p /var/lib/postgresql/data \
    && chown -R postgres:postgres /var/lib/postgresql \
    && chown -R postgres:postgres /usr/local/pgsql \
    && chmod 1777 /tmp

WORKDIR /app
# making sure we use the binaries from the installed postgresql17 client
ENV PG_DUMP_BINARY=/usr/bin/pg_dump
ENV PG_RESTORE_BINARY=/usr/bin/pg_restore
ENV PATH="/usr/local/pgsql/bin:$PATH"
ENV PGDATA=/var/lib/postgresql/data

RUN sed -i 's|nobody:/|nobody:/home|' /etc/passwd && chown nobody:nobody /home

ENV POSTGRES_URL=postgresql://postgres@localhost/postgres?host=/tmp

COPY ./docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh


USER postgres

RUN initdb -D "$PGDATA"

# We don't expose 5432 because
# 1. We use a unix socket
# 2. The external user should never have to interface with the internal postgres service
EXPOSE 2345

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
