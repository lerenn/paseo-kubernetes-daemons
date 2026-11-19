FROM node:22-bookworm-slim
ARG PASEO_VERSION=0.16.2
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates python3 make g++ \
    && npm install -g @getpaseo/cli@${PASEO_VERSION} \
    && rm -rf /var/lib/apt/lists/*
# Install your agent providers in a derived image; inject credentials using a Secret.
ENV HOME=/workspace PASEO_HOME=/workspace/.paseo PASEO_LISTEN=0.0.0.0:6767 PASEO_RELAY_ENABLED=false
WORKDIR /workspace
USER 1000:1000
EXPOSE 6767
ENTRYPOINT ["paseo", "daemon", "run"]
