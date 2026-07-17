FROM node:22-bookworm AS devcon-base

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    SHELL=/bin/bash

RUN apt-get update \
    && apt-get install -y --no-install-recommends git tini locales ca-certificates ripgrep python3 python3-pip python3-venv bubblewrap \
    && echo "en_US.UTF-8 UTF-8" > /etc/locale.gen \
    && locale-gen \
    && python3 -m pip install --break-system-packages --no-cache-dir numpy scikit-learn pandas pyarrow catboost optuna polars \
    && rm -rf /var/lib/apt/lists/*

FROM devcon-base AS devcon-tools

RUN npm install -g --ignore-scripts @openai/codex@latest @anthropic-ai/claude-code@latest opencode-ai@latest @earendil-works/pi-coding-agent@latest \
    && npm cache clean --force

WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
