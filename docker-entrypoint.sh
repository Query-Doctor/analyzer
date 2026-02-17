#!/bin/sh
pg_ctl -D "$PGDATA" -l "$PGDATA/logfile" start || (cat "$PGDATA/logfile" && exit 1)

until pg_isready -h /tmp; do sleep 0.5; done

node /app/dist/main.mjs
