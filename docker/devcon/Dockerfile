FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    SHELL=/bin/bash

RUN apt-get update \
    && apt-get install -y --no-install-recommends git tini locales ca-certificates ripgrep \
    && echo "en_US.UTF-8 UTF-8" > /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ARG DEVCON_UPDATE_TOKEN=0
RUN npm install -g @openai/codex@latest @anthropic-ai/claude-code@latest \
    && npm cache clean --force \
    && echo "devcon update token: ${DEVCON_UPDATE_TOKEN}" > /dev/null

WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
