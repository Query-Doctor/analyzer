# Development stage
FROM denoland/deno:alpine AS development

# Install pgbadger dependencies
RUN apk add --no-cache \
    perl \
    perl-text-csv-xs \
    wget \
    make \
    git

# Download, build, and install pgBadger
ARG PGBADGER_VERSION=12.3
WORKDIR /tmp
RUN wget https://github.com/darold/pgbadger/archive/v${PGBADGER_VERSION}.tar.gz && \
    tar -xzf v${PGBADGER_VERSION}.tar.gz && \
    cd pgbadger-${PGBADGER_VERSION} && \
    perl Makefile.PL && \
    make && \
    make install && \
    rm -rf /tmp/pgbadger*

# Set working directory
WORKDIR /app

# Copy dependency files
COPY deno.json deno.lock* ./

# Cache dependencies
RUN deno cache main.ts

# Copy source code
COPY . .

# Expose port for development server (if needed)
EXPOSE 8000

# Development command with hot reload
CMD ["deno", "task", "dev"]

# Production stage
FROM denoland/deno:alpine AS production

# Install pgbadger dependencies
RUN apk add --no-cache \
    perl \
    wget \
    make \
    git

# Download, build, and install pgBadger
ARG PGBADGER_VERSION=12.3
WORKDIR /tmp
RUN wget https://github.com/darold/pgbadger/archive/v${PGBADGER_VERSION}.tar.gz && \
    tar -xzf v${PGBADGER_VERSION}.tar.gz && \
    cd pgbadger-${PGBADGER_VERSION} && \
    perl Makefile.PL && \
    make && \
    make install && \
    rm -rf /tmp/pgbadger*

RUN  /usr/bin/perl -MCPAN -e'install Text::CSV_XS'
# Set working directory
WORKDIR /app

# Copy dependency files
COPY deno.json deno.lock* ./

# Cache dependencies
RUN deno cache main.ts

# Copy source code
COPY . .

# Compile the application
RUN deno compile --allow-run --allow-read --allow-write --allow-env --allow-net main.ts -o analyzer

# Production command
CMD ["/app/analyzer"]
