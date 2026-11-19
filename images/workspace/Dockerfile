FROM node:22-bookworm-slim
ARG PASEO_VERSION=0.15.3
ARG CODEX_VERSION=0.170.0
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates python3 make g++ \
    && npm install -g @getpaseo/cli@${PASEO_VERSION} @openai/codex@${CODEX_VERSION} \
    && rm -rf /var/lib/apt/lists/*
COPY bootstrap.py git-askpass.py /usr/local/lib/paseo-workspace/
RUN chmod 755 /usr/local/lib/paseo-workspace/*.py
# Codex is included. Install other provider/MCP executables in a derived image.
ENV HOME=/workspace PASEO_HOME=/workspace/.paseo CODEX_HOME=/workspace/.codex PASEO_LISTEN=0.0.0.0:6767 PASEO_RELAY_ENABLED=false
WORKDIR /workspace
USER 1000:1000
EXPOSE 6767
ENTRYPOINT ["paseo", "daemon", "run"]
