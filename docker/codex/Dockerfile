FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends git tini ca-certificates bash-completion \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@latest \
  && npm cache clean --force

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["codex"]
