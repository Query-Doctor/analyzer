#!/bin/sh
# initdb -D "$PGDATA"
echo "listen_addresses = '0.0.0.0'" >> "$PGDATA/postgresql.conf"
echo "host all all 0.0.0.0/0 trust" >> "$PGDATA/pg_hba.conf"
echo "shared_preload_libraries = 'timescaledb,pg_stat_statements'" >> $PGDATA/postgresql.conf

pg_ctl -D "$PGDATA" -l "$PGDATA/logfile" start || (cat "$PGDATA/logfile" && exit 1)

until pg_isready -h /tmp; do sleep 0.5; done

(node /app/dist/main.mjs || cat "$PGDATA/logfile")
