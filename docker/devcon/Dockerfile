FROM node:22-bookworm AS devcon-base

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    SHELL=/bin/bash

RUN apt-get update \
    && apt-get install -y --no-install-recommends git tini locales ca-certificates curl ripgrep python3 python3-venv bubblewrap util-linux sysstat \
    && echo "en_US.UTF-8 UTF-8" > /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
