ARG ALPINE_VERSION=3.22
ARG DENO_VERSION=2.4.5
FROM alpine:${ALPINE_VERSION} AS pg-builder

# Install build dependencies
RUN apk add --no-cache \
    build-base \
    git \
    openssh-client \
    readline-dev \
    zlib-dev \
    flex \
    bison \
    perl \
    bash \
    cmake \
    openssl-dev \
    krb5-dev \
    linux-headers

# Clone PostgreSQL 17 from official source
RUN git clone --depth 1 --branch REL_17_STABLE https://github.com/postgres/postgres.git /postgres

WORKDIR /postgres

# Copy and apply the patch
COPY patches/pg17/zero_cost_plan.patch /tmp
RUN git apply /tmp/*.patch

# Build PostgreSQL with debug flags
RUN ./configure \
    --without-icu \
    --with-openssl \
  --prefix=/usr/local/pgsql

RUN make -j$(nproc) all
RUN make install

RUN cd contrib && make -j$(nproc) && make install

# Clone and build TimescaleDB
ARG TIMESCALEDB_VERSION=2.24.0
WORKDIR /timescaledb
RUN git clone --depth 1 --branch ${TIMESCALEDB_VERSION} https://github.com/timescale/timescaledb.git .

# Bootstrap and build TimescaleDB
RUN ./bootstrap -DREGRESS_CHECKS=OFF -DPG_CONFIG=/usr/local/pgsql/bin/pg_config
RUN cd build && make -j$(nproc)
RUN cd build && make install

# Adapted from https://github.com/dojyorin/deno_docker_image/blob/master/src/alpine.dockerfile
FROM denoland/deno:alpine-${DENO_VERSION} AS deno

RUN apk add --no-cache \
    perl \
    curl \
    make \
    git \
    postgresql-client

# Download, build, and install pgBadger
ARG PGBADGER_VERSION=13.2
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
  --allow-sys \
  -o /app/analyzer \
  src/main.ts

FROM alpine:${ALPINE_VERSION}
ENV LD_LIBRARY_PATH="/usr/local/lib"

RUN apk add -uU --no-cache \
    postgresql-client \
    readline \
    zlib \
    bash \
    su-exec \
    openssl \
    krb5

COPY --from=deno --chmod=755 --chown=root:root /usr/bin/pg_dump /usr/bin/pg_dump
COPY --from=build --chmod=755 --chown=root:root /app/analyzer /app/analyzer
COPY --from=cc --chmod=755 --chown=root:root /lib/*-linux-gnu/* /usr/local/lib/
COPY --from=sym --chmod=755 --chown=root:root /tmp/lib /lib
COPY --from=sym --chmod=755 --chown=root:root /tmp/lib /lib64

# Copy PostgreSQL installation from builder
COPY --from=pg-builder /usr/local/pgsql /usr/local/pgsql

# Setup postgres user and directories
RUN mkdir -p /var/lib/postgresql/data \
    && chown -R postgres:postgres /var/lib/postgresql \
    && chown -R postgres:postgres /usr/local/pgsql \
    && chmod 1777 /tmp

WORKDIR /app
ENV PG_DUMP_BINARY=/usr/bin/pg_dump
ENV PG_RESTORE_BINARY=/usr/bin/pg_restore
ENV PATH="/usr/local/pgsql/bin:$PATH"
ENV PGDATA=/var/lib/postgresql/data

RUN sed -i 's|nobody:/|nobody:/home|' /etc/passwd && chown nobody:nobody /home

ENV POSTGRES_URL=postgresql://postgres@localhost/postgres?host=/tmp

EXPOSE 5432

# Development command - starts both PostgreSQL and the analyzer
CMD ["/bin/bash", "-c", "\
    su-exec postgres initdb -D $PGDATA || true && \
    echo \"shared_preload_libraries = 'timescaledb,pg_stat_statements'\" >> $PGDATA/postgresql.conf && \
    echo \"max_locks_per_transaction = 256\" >> $PGDATA/postgresql.conf && \
    echo \"listen_addresses = ''\" >> $PGDATA/postgresql.conf && \
    echo \"unix_socket_directories = '/tmp'\" >> $PGDATA/postgresql.conf && \
    su-exec postgres pg_ctl -D $PGDATA -l $PGDATA/logfile start || (cat $PGDATA/logfile && exit 1) && \
    until su-exec postgres pg_isready -h /tmp; do sleep 0.5; done && \
    /app/analyzer"]
