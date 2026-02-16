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
    postgresql-client \
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
ENV PG_DUMP_BINARY=/usr/local/pgsql/bin/pg_dump
ENV PG_RESTORE_BINARY=/usr/local/pgsql/bin/pg_restore
ENV PATH="/usr/local/pgsql/bin:$PATH"
ENV PGDATA=/var/lib/postgresql/data

RUN sed -i 's|nobody:/|nobody:/home|' /etc/passwd && chown nobody:nobody /home

ENV POSTGRES_URL=postgresql://postgres@localhost/postgres?host=/tmp

RUN su-exec postgres initdb -D $PGDATA || true && \
    # echo "shared_preload_libraries = 'timescaledb,pg_stat_statements'" >> $PGDATA/postgresql.conf && \
    echo "listen_addresses = ''" >> $PGDATA/postgresql.conf && \
    echo "unix_socket_directories = '/tmp'" >> $PGDATA/postgresql.conf

USER postgres

EXPOSE 2345

CMD ["/bin/bash", "-c", "\
    pg_ctl -D $PGDATA -l $PGDATA/logfile start || (cat $PGDATA/logfile && exit 1) && \
    until pg_isready -h /tmp; do sleep 0.5; done && \
    node /app/dist/main.mjs"]
