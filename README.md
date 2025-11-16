# devcon

`devcon` is a Linux-only CLI that launches AI coding agents like Codex CLI or Claude Code in fresh Docker containers that already have your working directory wired up. Install globally (`npm install -g devcon`) and run `devcon codex` (or `devcon claude`) from any project to get a locked-down shell within seconds. If no image is configured, Devcon defaults to a local `devcon:latest` image that bundles both Codex CLI and Claude Code; the first time you run a tool the CLI offers to build this image for you.

## What it does

- Spin up a disposable Docker container per invocation.
- Bind-mount the current working directory at `/workspace` and run as your host UID/GID so file permissions stay intact.
- Keep the host home directory private by default. Opt in with `--home` or `DEVCON_SHARE_HOME=1`, or whitelist individual directories via `writablePaths` so credentials like `~/.codex` can still be shared.
- Hide `.env*`, `.git-credentials`, and other critical Git metadata from the container by overlaying empty bind mounts before the container starts.
- Detect when the default `devcon:latest` docker image is missing and (after a `y` confirmation) build it automatically from `docker/devcon/Dockerfile`.
- Provide a simple tool registry (`codex`, `claude` by default) allowing you to define which Docker image and command should run for each agent.

## Installation

```bash
npm install -g devcon
```

You need Docker installed and accessible to your user. Only Linux hosts are supported for now because the CLI relies on Unix-specific APIs such as `getuid`/`getgid`.

## Usage

```bash
devcon <tool> [-- tool arguments]
```

Examples:

```bash
# Show the docker command without running it
devcon codex --dry-run

# Launch Claude Code but keep your home directory out of the container
devcon claude --no-home

# Override the docker image just for this run
devcon codex --image ghcr.io/my/codex:latest -- --trace

# Temporarily share the entire home directory (default is no home mount)
devcon codex --home
```

Useful flags:

- `--dry-run` – Print the assembled `docker run` invocation instead of executing it.
- `--home` / `--no-home` – Force-enable or force-disable home-directory sharing for this run.
- `--image=NAME` – Override the docker image configured for the tool.
- `--help` / `--list` – Show usage plus the registered tools.

## Default image (`devcon:latest`)

The bundled tools (`codex`, `claude`) point to an image named `devcon:latest` that bakes in both CLIs. On the first run Devcon checks whether that tag exists locally; if not, you’ll see a short explanation plus a `Build it now? [y/N]` prompt. Answer `y` and the CLI runs:

```bash
docker build -f docker/devcon/Dockerfile -t devcon:latest docker/devcon
```

The build context lives inside the npm package, so everything works even if you run `devcon codex` from a random project. If you prefer a custom image, pass `--image my/tag` or set `image` in `~/.config/devcon/tools.json`—auto-build only triggers for the default image.

## Tool registry

Devcon merges the built-in tools with an optional JSON file. Create `~/.config/devcon/tools.json` (or point `DEVCON_TOOLS_FILE` somewhere else) to declare images, commands, and optional environment variables per tool:

```json
{
  "codex": {
    "image": "devcon:latest",
    "command": ["codex"],
    "writablePaths": ["~/.codex"]
  },
  "claude": {
    "image": "devcon:latest",
    "command": ["claude"],
    "writablePaths": ["~/.config/claude"]
  },
  "custom-codex": {
    "image": "ghcr.io/my-org/codex-cli:latest",
    "command": ["/bin/bash", "-lc", "codex --full-auto"],
    "shareHome": true,
    "homeReadOnly": true,
    "writablePaths": ["~/.codex"],
    "env": {
      "CODEX_CONFIG": "/home/jannik/.config/codex/config.toml"
    }
  }
}
```

Fields per tool:

- `image` (**required**) – Docker image tag to run.
- `command` – Array describing the command to execute inside the container. Omit it to rely on the image entrypoint.
- `env` – Additional environment variables to inject.
- `workdir` – Alternative container working directory (defaults to `/workspace`).
- `shareHome` – Override the CLI default for sharing the host home directory (default is `false`).
- `homeReadOnly` – When `true`, the home directory mount is forced read-only; pair with `writablePaths` to selectively re-enable write access to specific paths.
- `writablePaths` – Array of directories (absolute or `~/`-prefixed) that should remain mounted read/write even if the home directory is not mounted. The directories must live under your host home directory; missing directories are created automatically.

Environment toggles:

- `DEVCON_SHARE_HOME=1` – Make home-directory sharing the default for all tools (equivalent to passing `--home` every time).
- `DEVCON_HOME_READONLY=1` – When the home directory is shared, mount it read-only by default. Individual tools can override via `homeReadOnly: false` or expose specific `writablePaths`.

## Security defaults

- Every run masks `.env`, `.env.*`, `.git/config`, `.git/index`, `.git/HEAD`, `.git-credentials`, and `.git/credentials` from the container by mounting empty placeholders over those paths after the workspace volume is attached.
- Containers inherit your host UID/GID so they have no more privileges than you already do.
- Each invocation runs with `--rm` and without Docker daemon side-effects, ensuring there is no long-lived state.
- The host home directory is unmounted by default; opt in explicitly and/or keep it read-only (`DEVCON_HOME_READONLY=1`) while allowing write access only to trusted locations via `writablePaths`.
- The default Codex/Claude image builds locally and never ships secrets to a registry.

## Development

- `npm run dev` – Execute the TypeScript entry point directly with `ts-node`.
- `npm run build` – Compile into `dist/`.
- `npm run clean` – Remove build artifacts.

Feel free to open issues or PRs for additional agents or tighter security defaults.
