`analyzer` is capable of giving index recommendations after going through your postgres logs. It works with all languages, ORMs and query builders!

There are a couple assumptions about your CI pipeline we make for this to work.

1. There are database queries that hit up a real postgres database in your pipeline. The source is not important, it could be e2e, load or integration tests. The queries can be run in a rolled-back transaction and it will still work fine.
2. The final schema (after migrations run) is available for analyzer to introspect. And that every table has at least 1 row in it as part of your db seed. We use the database to do extra work by testing your query against different index configurations with your production stats, but all of that work is done in a transaction that’s always rolled back. Data is never modified
3. Your `postgres.conf` is configured with at least the following options.

```bash
shared_preload_libraries='auto_explain'
auto_explain.log_min_duration=0
auto_explain.log_analyze=true
auto_explain.log_verbose=true
auto_explain.log_buffers=true
auto_explain.log_format='json'
logging_collector=on
log_directory='/var/log/postgresql' # or any path you like
log_filename='postgres.log' # or any name you like
```

### Optional

You have a production database you can pull statistics from (using a query given by us)

---

# Steps for setup

Currently we only support GitHub actions but it would not be difficult to add support for other CI platforms like azure pipelines.

## Github Actions

`ubuntu` runners in github already ships with postgres as part of the default image, so we try to leverage that. Because github workflows does not support specifying arguments to services https://github.com/actions/runner/pull/1152, we can’t run postgres as a container. And trying to run postgres in docker directly causes network problems because it seems `--network=host` is also not supported in dind (docker-in-docker). So we instead copy an explicit setup to the existing postgres, which boots up 10x faster than docker anyway.

1. Copy the setup script

```yaml
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Postgres
        run: |
          sudo tee -a /etc/postgresql/16/main/postgresql.conf <<EOF
            shared_preload_libraries = 'auto_explain'
            auto_explain.log_min_duration = 0
            auto_explain.log_analyze = true
            auto_explain.log_verbose = true
            auto_explain.log_buffers = true
            auto_explain.log_format = 'json'
            logging_collector = on
            log_directory = '/var/log/postgresql'
            log_filename = 'postgres.log'
          EOF
          sudo tee /etc/postgresql/16/main/pg_hba.conf > /dev/null <<EOF
            host all all 127.0.0.1/32 trust
            host all all ::1/128 trust
            local all all peer
          EOF
          sudo systemctl start postgresql.service
          sudo -u postgres createuser -s -d -r -w me
          sudo -u postgres createdb testing
          sudo chmod 666 /var/log/postgresql/postgres.log
```

you can change `sudo -u postgres createuser -s -d -r -w me` to create a new user with a name of your choosing and `sudo -u postgres createdb testing` to create a db with a different name.

1. Run your migrations and seed scripts. This is just an example showing that the migrations should target the postgres instance that was set up with the previous command

```yaml
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      # ... previous steps ...
      - name: Migrate
        run: pnpm run migrate && pnpm run seed
        env:
          POSTGRES_URL: postgres://me@localhost/testing
```

1. Run your test suite against the same database. You can do this with any tool and use any query builder or ORM you like.
2. Run the analyzer. `GITHUB_TOKEN` is needed to post a comment to your PR reviewing the indexes found in your database.

```yaml
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      # ... previous steps ...
      - name: Migrate
        run: pnpm run migrate && pnpm run seed
        env:
          POSTGRES_URL: postgres://me@localhost/testing
      - name: Run integration tests
        run: pnpm run test:integration
        env:
          POSTGRES_URL: postgres://me@localhost/testing
      - name: Run query-doctor/analyzer
        uses: query-doctor/analyzer@v1
        env:
          GITHUB_TOKEN: ${{ github.token }}
          POSTGRES_URL: postgres://me@localhost/testing
```

1. Add `pull-request: write` permissions to your job to allow

```yaml
jobs:
  run:
    permissions:
      contents: read
      pull-requests: write
    runs-on: ubuntu-latest
    ...
```
