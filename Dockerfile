FROM denoland/deno:alpine

# Install pgbadger dependencies
RUN apk add --no-cache \
    perl \
    wget \
    make \
    git \
    postgresql-client

# Download, build, and install pgBadger
ARG PGBADGER_VERSION=13.1
WORKDIR /tmp
RUN wget https://github.com/darold/pgbadger/archive/v${PGBADGER_VERSION}.tar.gz && \
    tar -xzf v${PGBADGER_VERSION}.tar.gz && \
    cd pgbadger-${PGBADGER_VERSION} && \
    perl Makefile.PL && \
    make && \
    make install && \
    rm -rf /tmp/pgbadger*

# RUN curl -L https://github.com/supabase-community/postgres-language-server/releases/download/<version>/postgrestools_aarch64-apple-darwin -o postgrestools
# RUN chmod +x postgrestools

WORKDIR /app

# Copy dependency files
COPY deno.json deno.lock* ./
ENV PG_DUMP_BINARY=/usr/bin/pg_dump

RUN deno install --frozen-lockfile

COPY . .

RUN deno compile --allow-run --allow-read --allow-write --allow-env --allow-net -o analyzer src/main.ts
RUN ls -la /app

# Development command
CMD ["/app/analyzer"]

