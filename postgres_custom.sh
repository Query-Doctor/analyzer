postgres \
  -c shared_preload_libraries=auto_explain \
  -c auto_explain.log_min_duration=0 \
  -c auto_explain.log_analyze=true \
  -c auto_explain.log_verbose=true \
  -c auto_explain.log_buffers=true \
  -c auto_explain.log_format=json \
  -c logging_collector=on \
  -c log_directory='/var/log/postgresql' \
  -c log_filename='postgres.log'
