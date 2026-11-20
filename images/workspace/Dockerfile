FROM docker:29.0.0-cli AS docker-cli
FROM node:22-bookworm-slim
ARG PASEO_VERSION=0.16.2
ARG CODEX_VERSION=0.170.0
ARG CLAUDE_CODE_VERSION=2.1.329
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates python3 make g++ \
    && npm install -g @getpaseo/cli@${PASEO_VERSION} @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
COPY bootstrap.py git-askpass.py /usr/local/lib/paseo-workspace/
RUN chmod 755 /usr/local/lib/paseo-workspace/*.py
# Codex and Claude Code are included (Claude authenticates with the synced ANTHROPIC_API_KEY).
# Install other provider/MCP executables in a derived image.
ENV HOME=/workspace PASEO_HOME=/workspace/.paseo CODEX_HOME=/workspace/.codex PASEO_LISTEN=0.0.0.0:6767 PASEO_RELAY_ENABLED=false
WORKDIR /workspace
USER 1000:1000
EXPOSE 6767
ENTRYPOINT ["paseo", "daemon", "run"]
