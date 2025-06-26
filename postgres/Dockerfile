FROM postgres:18beta1-alpine

RUN echo "shared_preload_libraries = 'auto_explain'" >> /var/lib/postgresql/data/postgresql.conf
RUN echo "auto_explain.log_min_duration = 0" >> /var/lib/postgresql/data/postgresql.conf
RUN echo "auto_explain.log_analyze = true" >> /var/lib/postgresql/data/postgresql.conf
RUN echo "auto_explain.log_verbose = true" >> /var/lib/postgresql/data/postgresql.conf
RUN echo "auto_explain.log_buffers = true" >> /var/lib/postgresql/data/postgresql.conf
RUN echo "auto_explain.log_format = 'json'" >> /var/lib/postgresql/data/postgresql.conf
RUN echo "log_destination = 'stderr'" >> /var/lib/postgresql/data/postgresql.conf
