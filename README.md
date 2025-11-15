# devcon

`devcon` is a Linux-only CLI that launches AI coding agents like Codex CLI or Claude Code in fresh Docker containers that already have your working directory and user identity wired up. It is meant to be installed globally (`npm install -g devcon`) so you can run `devcon codex` (or `devcon claude`) from any project and get a locked-down shell within seconds. The built-in tool definitions use the Microsoft Dev Containers base image, so either ship an image with the agent pre-installed or rely on the host home-directory mount so the container can reuse your already-installed CLI binaries.

## What it does

- Spin up a disposable Docker container per invocation.
- Bind-mount the current working directory at `/workspace` and run as your host UID/GID so file permissions stay intact.
- Optionally mount your host home directory (enabled by default, disable via `--no-home` or `DEVCON_SHARE_HOME=0`) so tools can see existing config and auth files.
- Hide `.env*`, `.git-credentials`, and other critical Git metadata from the container by overlaying empty bind mounts before the container starts.
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
```

Useful flags:

- `--dry-run` – Print the assembled `docker run` invocation instead of executing it.
- `--no-home` – Skip sharing your host home directory.
- `--image=NAME` – Override the docker image configured for the tool.
- `--help` / `--list` – Show usage plus the registered tools.

## Tool registry

Devcon merges the built-in tools with an optional JSON file. Create `~/.config/devcon/tools.json` (or point `DEVCON_TOOLS_FILE` somewhere else) to declare images, commands, and optional environment variables per tool:

```json
{
  "codex": {
    "image": "ghcr.io/my-org/codex-cli:latest",
    "command": ["/bin/bash", "-lc", "codex"],
    "env": {
      "CODEX_CONFIG": "/home/user/.config/codex/config.json"
    }
  },
  "codex-locked": {
    "image": "devcon-codex",
    "homeReadOnly": true,
    "writablePaths": [
      "~/.codex"
    ]
  }
}
```

Fields per tool:

- `image` (**required**) – Docker image tag to run.
- `command` – Array describing the command to execute inside the container. Omit it to rely on the image entrypoint.
- `env` – Additional environment variables to inject.
- `workdir` – Alternative container working directory (defaults to `/workspace`).
- `shareHome` – Override the CLI default for sharing the host home directory.
- `homeReadOnly` – When `true`, the home directory mount is forced read-only; pair with `writablePaths` to selectively re-enable write access.
- `writablePaths` – Array of paths (absolute or `~/`-prefixed) that should remain writable even if the home directory is read-only. The paths must already exist on the host.

Set `DEVCON_HOME_READONLY=1` if you want every tool that shares your home directory to mount it read-only by default. Individual tools can then opt back into read/write (`homeReadOnly: false`) or specify fine-grained writable directories. This is useful for cases like Codex CLI where you only want to expose `~/.codex` for credential writes while keeping the rest of your home directory immutable.

## Security defaults

- Every run masks `.env`, `.env.*`, `.git/config`, `.git/index`, `.git/HEAD`, `.git-credentials`, and `.git/credentials` from the container by mounting empty placeholders over those paths after the workspace volume is attached.
- Containers inherit your host UID/GID so they have no more privileges than you already do.
- Each invocation runs with `--rm` and without Docker daemon side-effects, ensuring there is no long-lived state.
- You can flip the host home directory into read-only mode via `DEVCON_HOME_READONLY=1` (or per-tool `homeReadOnly: true`) to limit exposure, then opt specific directories back into write access through `writablePaths`.

## Development

- `npm run dev` – Execute the TypeScript entry point directly with `ts-node`.
- `npm run build` – Compile into `dist/`.
- `npm run clean` – Remove build artifacts.

Feel free to open issues or PRs for additional agents or tighter security defaults.
