# devcon

`devcon` is a Linux-only CLI that launches AI coding agents like Codex CLI, Claude Code, OpenCode, or Pi in fresh Docker containers that already have your working directory wired up. Install globally (`npm install -g devcon`) and run `devcon codex` (or `devcon claude`, `devcon opencode`, or `devcon pi`) from any project to get a locked-down shell within seconds. If no image is configured, Devcon defaults to a local `devcon:latest` image that bundles all four CLIs; the first time you run a tool the CLI offers to build this image for you.

## What it does

- Spin up a disposable Docker container per invocation.
- Bind-mount the current working directory at `/workspace/<current-folder-name>` and run as your host UID/GID so file permissions stay intact.
- Optionally bind-mount extra host directories for a single run via `--mount PATH[:NAME]` (repeatable), mounted under `/workspace/<folder-name>` by default or `/workspace/NAME` when an alias is supplied.
- Optionally expose all host NVIDIA GPUs to a tool container with `--gpu`.
- Keep the host home directory private by default. Opt in with `--home` or `DEVCON_SHARE_HOME=1`, or whitelist individual directories via `writablePaths` so credentials like `~/.codex` can still be shared.
- Share global agent skills across all bundled harnesses through the host's `~/.agents/skills` directory, without requiring the persistent development environment.
- Automatically attach a persistent, non-root development environment to each workspace so agents can retain Python environments, JDKs, user binaries, and build caches without retaining the container root filesystem.
- Hide `.env*`, `.git-credentials`, and private local Git metadata. A standard repository's `.git` is exposed read-only by default for history/status/diff inspection, with local config, hooks, reflogs, submodule metadata, and linked-worktree metadata masked.
- Detect when the default `devcon:latest` docker image is missing and (after a `y` confirmation) build it automatically from `docker/devcon/Dockerfile`.
- Provide a simple tool registry (`codex`, `claude`, `opencode`, `pi` by default) allowing you to define which Docker image and command should run for each agent.
- Built-in `codex` launches with `--sandbox danger-full-access --ask-for-approval never` by default because Devcon already provides the outer container boundary.
- Optional `--conscious` mode that boots a persistent local archive and wires memory tools into Codex, Claude, or OpenCode via MCP.

## Installation

You need Docker installed and running. Only Linux hosts are supported for now because the CLI relies on Unix-specific APIs such as `getuid`/`getgid`.

If you're working from a clone (like this repo), build and install the CLI locally:

```bash
npm install
npm run build
npm install -g .
```

To upgrade an existing Devcon install from the upstream repo and rebuild the bundled containers:

```bash
devcon upgrade
devcon upgrade --branch main
```

`devcon upgrade` defaults to the `main` branch. It runs the same local build/install commands shown above, then runs `devcon rebuild` so the bundled Docker image is rebuilt from the upgraded Dockerfile and package contents. You only need `sudo` if your npm global install location or Devcon package directory is owned by root; a user-writable npm prefix does not require it.

## Usage

```bash
devcon <tool> [flags] [-- tool arguments]
devcon resume             # choose a recent startup command used in this directory

# Rebuild the default tool images (all tools or a specific one)
devcon upgrade
devcon upgrade --branch main
devcon update
devcon update codex
devcon rebuild         # full no-cache rebuild for all auto-build tools
devcon rebuild codex   # full no-cache rebuild of a single tool/image
devcon webhub --allow ~/work/project-a --allow ~/work/project-b
devcon sensitive list          # show effective sensitive patterns and matches
devcon sensitive add secrets/** # add a custom sensitive pattern
devcon sensitive remove secrets/**
devcon skip-scan list          # show skip-scan directories (defaults + custom)
devcon skip-scan add .cache    # add a directory name to skip during scans
devcon skip-scan remove .cache
devcon env list               # list persistent development environments
devcon env create java-21 --size 15G
devcon env use java-21        # make it this workspace's default
devcon --env java-21 pi       # select one environment for a run
devcon --no-env codex         # run without persistent environment state
devcon --mount ../shared codex # add one extra host directory for this run only
devcon --mount ../other/devcon:reference codex # mount a same-named directory as /workspace/reference
devcon run -- git log --oneline # inspect history using the default read-only Git access
devcon --conscious codex       # enable persistent archive memory for this run
```

`devcon resume` shows the latest successful startup commands recorded for the exact current directory. Use the arrow keys to choose one and press Enter; the most recent command is selected by default. Devcon keeps up to 20 distinct startup commands per directory in `~/.config/devcon/startup-history.json`. Administrative commands, help, invalid launches, and dry runs are not recorded.

Examples:

```bash
# Show the docker command without running it
devcon codex --dry-run

# Enable conscious mode (archive memory + MCP tools)
devcon --conscious codex

# Launch Claude Code but keep your home directory out of the container
devcon claude --no-home

# Force IPv4 inside the container (disable IPv6)
devcon -ipv4 codex

# Use host networking (helpful with VPNs that block Docker bridge DNS/NAT)
devcon --network-host codex

# Give the container access to all NVIDIA GPUs
devcon --gpu codex
# Equivalent explicit provider spelling
devcon --gpu=nvidia codex

# Override the docker image just for this run
devcon codex --image ghcr.io/my/codex:latest -- --trace

# Temporarily share the entire home directory (default is no home mount)
devcon codex --home

# Mount another host directory for this run only
devcon --mount ../shared codex
devcon --mount ~/work/notes --mount /tmp/datasets codex

# Choose its name inside /workspace (useful when its folder name collides with the current project)
devcon --mount ../other/devcon:reference codex
```

## Web mode (phone + desktop)

Use `--web` to launch a tool in a tmux-backed session and immediately expose it through the built-in web terminal:

```bash
devcon --web codex
```

You can also set explicit connection settings:

```bash
devcon --web --web-host 0.0.0.0 --web-port 7682 --web-password 'strong-password' codex
```

Notes:

- `--web` requires `tmux` on the host.
- The browser terminal uses `xterm.js` over a websocket-backed PTY attachment to the tmux session, so full-screen TUIs, ANSI colors, cursor movement, and interactive prompts render much closer to a native terminal.
- If no password is provided (`--web-password` or `WEB_PASSWORD`), devcon generates one-time credentials and prints them.
- When binding to `0.0.0.0` or `::`, the printed local-network URLs include `?pwd=...` so opening the link on another device logs in automatically once and then removes the password from the address bar.
- By default devcon auto-generates a tmux session name. Override via `--web-session NAME`.
- The container keeps running in tmux until it exits or you stop it (`tmux kill-session -t <name>`).

Manual mode is still available via `npm run web` if you want to attach the web UI to an existing tmux session (`TMUX_TARGET=...`).

Security note: do not expose the web terminal directly to the public internet without TLS and upstream access control.

## Webhub (multi-session launcher)

`webhub` gives you a single browser UI that can launch and manage multiple tmux-backed devcon web sessions, each in a whitelisted directory.

Launch:

```bash
devcon webhub --allow ~/work/project-a --allow ~/work/project-b
```

Optional host/port/password:

```bash
devcon webhub --allow /workspace --host 0.0.0.0 --port 7690 --password 'strong-password'
```

Behavior:

- Webhub only allows launching sessions inside directories passed with `--allow` (repeatable).
- It launches sessions via internal `devcon --web --web-no-server ...` and streams tmux output directly.
- When webhub exits (`Ctrl+C`), it stops hub-managed tmux sessions.

Environment alternatives:

- `DEVCON_WEBHUB_ALLOWLIST=/path/a:/path/b`
- `DEVCON_WEBHUB_HOST=0.0.0.0`
- `DEVCON_WEBHUB_PORT=7690`
- `DEVCON_WEBHUB_PASSWORD=strong-password`

Useful flags (place before `--` that separates devcon flags from tool args):

- `--dry-run` – Print the assembled `docker run` invocation instead of executing it.
- `--strict` – Use Docker's stricter default seccomp/AppArmor sandbox instead of Devcon's bwrap-friendly default.
- `--home` / `--no-home` – Force-enable or force-disable home-directory sharing for this run.
- `--image=NAME` – Override the docker image configured for the tool.
- `--with-git` – Make the host `.git` writable for staging/committing, including its local configuration; a sandboxed global identity (`devcon-bot <devcon@example.com>`) is injected.
- `--local-git` – Make local Git state writable for staging, committing, and checking out already-fetched branches while masking repository configuration, credentials, hooks, and linked metadata. This prevents normal remote pushes because no remote URL is exposed.
- `--no-git` – Fully mask the host `.git`, including repository history.
- `--temp-git` – Keep host `.git` masked but mount a temporary git repo/worktree in the container (sandboxed identity pre-configured).
- `--env NAME` – Use an existing named persistent development environment for this run instead of the workspace default.
- `--no-env` – Disable persistent development state for this run.
- `--mount PATH[:NAME]` – Add an extra bind mount for the current run only (repeatable). By default it is mounted under `/workspace/<folder-name>`; append `:NAME` to choose another name (e.g. `--mount ../other/devcon:reference` => `/workspace/reference`). Extra mounts are scanned/masked with the same sensitive-path rules as the main project mount.
- `--export-patch[=PATH]` – With `--temp-git`, export patches after the run to PATH (or `.devcon/drafts/<timestamp>.patch`).
- `--network-host` / `-network-host` – Use host networking (often required on VPNs that block Docker bridge DNS/NAT).
- `--ipv4` / `-ipv4` – Force IPv4-only networking by disabling IPv6 inside the container.
- `--gpu` / `--gpu=nvidia` – Give the container access to all NVIDIA GPUs. Requires an NVIDIA driver, Docker 19.03+, and NVIDIA Container Toolkit configured on the host.
- `--web` – Run the tool inside tmux and expose it through the built-in web terminal.
- `--web-host HOST` – Override web server bind host (default: `0.0.0.0`).
- `--web-port PORT` – Override web server port (default: `7682`).
- `--web-password PASS` – Set web terminal login password (auto-generated if omitted).
- `--web-session NAME` – Set tmux session name for web mode.
- `--conscious` / `-conscious` – Enable conscious mode (persistent archive + MCP memory tools).
- `--conscious-path PATH` – Override conscious state directory (defaults to `~/.config/devcon/conscious`).
- `--help` / `--list` – Show usage plus the registered tools.
- Startup preflight: when bridge networking cannot resolve `api.openai.com` but host networking can, Devcon prompts to switch this run to `--network-host`.
- Startup preflight timeout defaults to 2500ms per probe and can be adjusted with `DEVCON_NETWORK_PROBE_TIMEOUT_MS`.

### NVIDIA GPU access

GPU access is opt-in and currently supports NVIDIA GPUs on Linux. Both spellings expose all host NVIDIA GPUs:

```bash
devcon --gpu codex
devcon --gpu=nvidia run -- nvidia-smi
```

Host requirements:

- A working NVIDIA driver (`nvidia-smi -L` should list the GPU).
- Docker 19.03 or newer.
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed and configured for Docker. A typical toolkit configuration is `nvidia-ctk runtime configure --runtime=docker`, followed by restarting Docker.

`--gpu` controls device exposure only. The bundled `devcon:latest` image does not include a CUDA toolkit. Python packages that bundle CUDA userspace libraries may work in the default image; CUDA compilation or other specialized workloads should use a suitable custom image through `--image` or `tools.json`.

GPU access broadens the host kernel-driver interface available to code inside the container and allows that code to consume GPU memory and compute resources. Enable it only for workloads you trust.

Pass tool arguments after `--` so they are not parsed by devcon. Examples:

```bash
devcon codex -- git status
# Opt in only when the agent needs to stage or commit:
devcon codex --with-git -- git add src/index.ts
devcon codex -- --dry-run "my prompt"
```

## Persistent development environments

Devcon automatically creates one persistent environment for each workspace on its first tool launch. The container itself remains disposable; only the dedicated environment directory under `~/.local/share/devcon/environments/` persists. Workspace-to-environment assignments are stored in `~/.config/devcon/environments.json`.

Inside the container, the environment is mounted at `/opt/devcon/env`. Devcon configures `PATH`, `VIRTUAL_ENV`, `JAVA_HOME`, and Python, uv, Maven, Gradle, npm, Cargo, and Rustup cache/install locations to use it. Built-in agents receive explicit system instructions to run `devcon-env info` before installing anything and not to retry `sudo`, `apt`, or system `pip`. `sudo`, `apt`, and `apt-get` are replaced with explanatory shims that point agents back to `devcon-env` instead of returning an ambiguous permission error.

Common flows:

```bash
# Inspect exact paths, current usage, and installation instructions (inside a tool container)
devcon-env info
devcon-env info --json       # machine-readable status for agents/scripts

# Persistent Python using the image's Python version
devcon-env python ensure
python -m pip install pytest

# Persistent Eclipse Temurin JDK (downloaded from the Adoptium API)
devcon-env java ensure 21
java -version

# Manage environments from the host
devcon env list
devcon env create java-21 --size 15G
devcon env use java-21
devcon env clone java-21 java-experiment
devcon env attach java-21 /path/to/another/workspace
devcon env set-size java-21 20G
devcon env inspect java-21
devcon env delete java-experiment
```

Use `--env NAME` to select another environment for one run, `devcon env use NAME` to change the current workspace default, or `--no-env` for a fully disposable run. Sharing an environment with another workspace also shares executable package state; clone it instead when the workspaces do not share the same trust boundary.

The default budget is 10 GiB, configurable for newly auto-created environments with `DEVCON_ENV_MAX_GB`. `--size` controls explicitly created environments. This is currently a **soft limit** because portable Docker bind-mount quotas are not available: Devcon blocks future launches when an environment is over budget and warns after a session that crosses it, but it cannot prevent a running process from temporarily exceeding the limit.

The environment runs as the host UID/GID but has no `sudo` and does not receive the host home or Docker socket. Persistent package state is executable and therefore trusted state: a malicious dependency can affect later sessions using that environment. Authentication mounts and the writable workspace retain their existing security implications.

## Shared agent skills

Devcon uses the host's `~/.agents/skills` as the global skills directory for all bundled agent harnesses. Codex, OpenCode, and Pi discover this location natively. For Claude Code, Devcon mounts the same directory at `~/.claude/skills` inside the container because Claude does not currently provide a separate global skills-path setting. The original host `~/.claude/skills` directory is left unchanged but is hidden for the duration of a Devcon Claude session.

The shared directory is mounted read/write even when the rest of the host home is unavailable or read-only, and is exposed as `DEVCON_SKILLS_DIR` inside supported tool containers. On startup, Devcon also instructs each bundled harness to use this directory rather than a harness-specific legacy directory when creating, installing, updating, or removing global skills. Legacy global skill directories under `~/.codex`, `~/.config/opencode`, and `~/.pi/agent` are masked with empty read-only directories inside their respective tool containers to prevent duplicate-name conflicts; existing host files are not changed, and Devcon warns when they should be migrated. Consequently, every bundled harness discovers global skills from the same store. Treat these skills as trusted executable state: a skill can contain scripts and can instruct an agent to run commands.

This only centralizes global skills. Repository-local discovery remains harness-native: Codex, OpenCode, and Pi use `.agents/skills`, while Claude Code continues to use `.claude/skills`.

## Conscious mode (`--conscious`)

`devcon --conscious <tool>` performs an idempotent bootstrap on startup:

- Creates state under `~/.config/devcon/conscious` (or `--conscious-path`), namespaced per conscious project at `projects/<project-id>/`.
- On first run in a git repo, prompts for project setup if no `.git/devcon/project-id` exists:
  - create new project (asks for project name),
  - link this repo to an existing conscious project,
  - clone an existing conscious project into a new one (fork memory, then diverge).
- Persists the chosen project identifier under `.git/devcon/project-id` (git-internal, not tracked).
- Initializes archive storage (`archive-db.json`) for that project if missing.
- Generates a per-session retrieval snapshot under `sessions/`.
- Starts (or reuses) a persistent per-project memory sidecar container and auto-registers MCP access for supported tools as `devcon-archive`.
- Removes that MCP registration again when the CLI process exits to avoid stale config drift.

Container isolation notes:

- By default, tool containers run with `seccomp=unconfined` and `apparmor=unconfined` so nested tools like `bubblewrap` can create user/mount namespaces.
- `--strict` restores Docker's stricter default seccomp/AppArmor sandbox for a single run.
- Bubblewrap still depends on the Docker host allowing unprivileged user namespaces (for example `kernel.unprivileged_userns_clone=1` on Linux hosts that gate it).
- The tool container does not mount the persistent archive directly in conscious mode.
- Persistent archive storage is mounted into the sidecar only (`~/.config/devcon/conscious` -> `/state`).
- Conscious sidecar mode is not compatible with `--network-host`.
- Override sidecar image via `DEVCON_CONSCIOUS_SIDECAR_IMAGE` (defaults to `devcon:latest`).
- Memory persistence policy knobs:
  - `DEVCON_CONSCIOUS_MEMORY_POLICY=off|encourage|require` (default `encourage`)
  - `DEVCON_CONSCIOUS_MEMORY_POLICY_THRESHOLD=<N>` (default `4` read calls before reminders/gating)

MCP tools exposed in conscious mode:

- `archive_overview` (session bootstrap: fetch taxonomy + labels + `overview_token`; call this before other archive tools)
- `archive_bootstrap` (recommended first call in a fresh chat: overview + concrete initial findings, including user preferences when present)
- `archive_create_path` (create a new folder path when no existing path matches)
- `archive_search` (fast index search; returns summary + previews)
- `archive_get` (fetch full stored details for a finding id; optional `revision_id` for historical versions)
- `archive_versions` (list revision history for a finding)
- `archive_write`
- `archive_update` (append a new revision to an existing finding by id)
- `archive_mark_used`

Write flow constraints:

- `archive_search` expects that `archive_overview` has been called once in the current MCP session.
- `archive_bootstrap` can satisfy that same session bootstrap requirement.
- `archive_write` now requires both `overview_token` and `path_id`.
- `archive_update` requires `overview_token` and `id`.
- Tokens stay valid for the current MCP session until a newer overview replaces them or the taxonomy changes; if stale, call `archive_overview` again.
- For durable user preferences, write entries under `/user/preferences` with label `user-preference`.
- Storage is already scoped to the current conscious project. Avoid redundant folders like `engineering/<project-name>`.
- Internally, `archive-db.json` is a hot index and full per-finding details are stored in `records/*.json`.
- Updates are append-only at the finding level: each update/write appends a revision that can be listed/fetched later.
- With `DEVCON_CONSCIOUS_MEMORY_POLICY=encourage`, archive tool callbacks include a reflection prompt to consider persisting reusable insights (while skipping one-off details).
- With `DEVCON_CONSCIOUS_MEMORY_POLICY=require`, after enough read-only archive exploration (`..._THRESHOLD`) further archive reads are blocked until at least one `archive_write`/`archive_update`.
- `archive_search` can automatically fall back to cross-repo matches when strict repo scope returns none (`repo_fallback`).

Automatic behavior:

- Pre-launch retrieval seed runs automatically from the current task args/repo context.
- On successful runs, if the workspace started clean and now contains git changes, Devcon auto-captures a low-confidence finding into the archive (heuristic learning capture).

Conscious storage management commands:

```bash
devcon conscious list
devcon conscious inspect --current
devcon conscious tree --project <project-name-or-id>
devcon conscious wipe-project --current          # asks for confirmation
devcon conscious wipe-project --project <project-name-or-id> --yes
devcon conscious wipe-all                        # asks for confirmation
devcon conscious wipe-all --yes
```

Notes:

- `wipe-project` clears stored memory data for that project and stops its sidecar container if present.
- `--project` accepts either the human project name or the generated project id.
- `wipe-all` clears the full conscious root and stops all `devcon-conscious-*` sidecar containers.
- Both wipe commands require interactive confirmation unless `--yes` is provided.

## Default image (`devcon:latest`)

The bundled tools (`codex`, `claude`, `opencode`, `pi`) point to an image named `devcon:latest` that bakes in all four CLIs. The image uses Node.js 22 because current Pi releases require it. On the first run Devcon checks whether that tag exists locally; if not, you’ll see a short explanation plus a `Build it now? [y/N]` prompt. Answer `y` and the CLI runs:

```bash
docker build -f docker/devcon/Dockerfile -t devcon:latest docker/devcon
```

The build context lives inside the npm package, so everything works even if you run `devcon codex` from a random project. If you prefer a custom image, pass `--image my/tag` or set `image` in `~/.config/devcon/tools.json`—auto-build only triggers for the default image.

To manually refresh the bundled image (for example to pick up new Codex CLI or OpenCode releases), run:

```bash
devcon upgrade       # upgrade Devcon itself and then rebuild bundled images
devcon update        # rebuilds every tool with an auto-build config
devcon update codex  # limit the rebuild to a single tool/image
```

`devcon upgrade [--branch main]` updates the Devcon package from the GitHub repo, runs `npm install`, `npm run build`, and `npm install -g .`, then runs `devcon rebuild`. In a Git checkout it uses `git pull --ff-only` and refuses to continue over uncommitted changes. In a packaged install without `.git`, it builds a temporary clone first, then replaces the installed package after the build succeeds.

`devcon update` refreshes the Dockerfile stage that installs the bundled CLIs without throwing away the whole Docker cache, so base layers stay hot while Codex CLI, Claude Code, OpenCode, and Pi get refreshed. On older Docker versions without stage-level cache filtering, it falls back to a full no-cache rebuild.

When you need a clean slate (ignore every cached layer), use:

```bash
devcon rebuild         # fully rebuilds every tool with an auto-build config
devcon rebuild codex   # fully rebuild just the bundled Codex/Claude/OpenCode/Pi base image
```

Additional handy invocations:

```bash
devcon run -- git log --oneline # inspect host history (host .git is read-only)
devcon run --with-git           # open a shell with writable host git metadata
devcon run --temp-git           # open a shell with a temp git repo (host .git stays masked)
devcon run --temp-git --export-patch   # auto-export patch to .devcon/drafts on exit
```

Notes on `--temp-git`:

- Host `.git` stays masked; `GIT_DIR`/`GIT_WORK_TREE` are set in the container and a sandboxed identity is pre-configured.
- On first use, Devcon seeds an initial commit inside the temp repo so you can format-patch changes without specifying a range.
- Combine with `--export-patch[=PATH]` to write patches automatically after the run; baseline commit is omitted from the patch. Uncommitted changes are snapshotted into a temp commit before export.

## Tool registry

Devcon merges the built-in tools with an optional JSON file. Create `~/.config/devcon/tools.json` (or point `DEVCON_TOOLS_FILE` somewhere else) to declare images, commands, and optional environment variables per tool:

```json
{
  "codex": {
    "image": "devcon:latest",
    "command": ["codex", "--sandbox", "danger-full-access", "--ask-for-approval", "never"],
    "writablePaths": ["~/.codex"]
  },
  "claude": {
    "image": "devcon:latest",
    "command": ["claude", "--dangerously-skip-permissions"],
    "writablePaths": ["~/.config/claude", "~/.claude", "~/.claude.json"]
  },
  "opencode": {
    "image": "devcon:latest",
    "command": ["opencode"],
    "writablePaths": [
      "~/.config/opencode",
      "~/.local/share/opencode",
      "~/.local/state/opencode",
      "~/.cache/opencode"
    ]
  },
  "pi": {
    "image": "devcon:latest",
    "command": ["pi"],
    "writablePaths": ["~/.pi/agent"]
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
- `workdir` – Alternative container working directory (defaults to `/workspace/<current-folder-name>`).
- `shareHome` – Override the CLI default for sharing the host home directory (default is `false`).
- `homeReadOnly` – When `true`, the home directory mount is forced read-only; pair with `writablePaths` to selectively re-enable write access to specific paths.
- `writablePaths` – Array of paths (absolute or `~/`-prefixed) that should remain mounted read/write even if the home directory is not mounted. The paths must live under your host home directory; missing directories are created automatically, and missing file-looking paths (for example `~/.tool.json`) are created as empty files.
- Built-in Claude passes `--dangerously-skip-permissions` by default because it already runs inside the Devcon container. Override the `claude` command in `tools.json` to restore permission prompts.
- Built-in Claude mounts `~/.config/claude`, `~/.claude`, and `~/.claude.json` by default so it can reuse its host auth/config and writable state without sharing your entire home directory.
- Built-in OpenCode mounts `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, and `~/.cache/opencode` by default so it can reuse your host config, auth, local state, and cache without sharing your entire home directory.
- Built-in Pi mounts `~/.pi/agent` by default so `/login` credentials, settings, sessions, and installed Pi packages persist without sharing your entire home directory.

Environment toggles:

- `DEVCON_SHARE_HOME=1` – Make home-directory sharing the default for all tools (equivalent to passing `--home` every time).
- `DEVCON_HOME_READONLY=1` – When the home directory is shared, mount it read-only by default. Individual tools can override via `homeReadOnly: false` or expose specific `writablePaths`.

## Security defaults

- Every run masks `.env`, `.env.*`, `.git-credentials`, and `.git/credentials` from the container by mounting empty placeholders after the workspace volume is attached.
- For a standard checkout with a `.git` directory, Git metadata is mounted read-only by default so `git status`, `git diff`, `git log`, `git blame`, and similar inspection commands work without allowing changes to the host index, refs, or objects. Local `.git/config`, `config.worktree`, hooks, reflogs, submodule metadata, and linked-worktree metadata remain masked.
- Git receives an isolated global config, no system config, no credential helper, disabled terminal prompting, and the identity `devcon-bot <devcon@example.com>`. The host home remains unmounted unless explicitly shared.
- Use `--no-git` to hide `.git` completely, `--temp-git` for disposable writable metadata, `--local-git` for writable local commits and checkouts without repository remote configuration, or `--with-git` to expose all host Git metadata.
- `--local-git` exposes local refs and objects, so `git checkout branch` works for any branch already fetched into the host repository, including a private repository. It cannot fetch new branches because the remote URL is masked.
- `--local-git` is not a general network or credential boundary: do not share a home directory or pass tokens to an agent that must not be able to authenticate to a remote it already knows.
- Linked worktrees use a `.git` pointer file rather than a self-contained directory; Devcon masks that file by default because safely remapping its external metadata is not currently supported.
- Read-only does not mean non-sensitive: commit objects can expose author names/emails and files (including secrets) deleted from the current tree. Reflogs and local config are masked, but use `--no-git` when repository history itself is outside the agent's allowed data scope.
- Containers inherit your host UID/GID so they have no more privileges than you already do.
- Each invocation runs with `--rm` and without Docker daemon side-effects, ensuring there is no long-lived state.
- The host home directory is unmounted by default; opt in explicitly and/or keep it read-only (`DEVCON_HOME_READONLY=1`) while allowing write access only to trusted locations via `writablePaths`.
- The default bundled agent image builds locally and never ships secrets to a registry.

### Sensitive file patterns

- Default sensitive patterns: `.env`, `.env.*`, `**/.env`, `**/.env.*`, `.git`, selected private `.git/*` metadata, and `.git-credentials`. Devcon selectively exposes the non-private parts of a standard `.git` read-only unless `--no-git` is used.
- Manage additional patterns in `~/.config/devcon/sensitive.json` via `devcon sensitive`:
  - `devcon sensitive list` – show defaults, custom patterns, and what matches in the current workspace.
  - `devcon sensitive add "<pattern>"` – add a glob-style pattern (e.g. `secrets/**`).
  - `devcon sensitive remove "<pattern>"` – remove a custom pattern.
- The pattern scan skips common heavy directories (`node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `tmp`, `temp`, `.venv`, `venv`, `target`, `out`, `.yarn`, `.pnpm-store`, `coverage`) to stay fast. Add or remove skip entries via `~/.config/devcon/skip-scan.json` or `devcon skip-scan` commands.
- Masking is decided at container startup. New sensitive files created after `devcon` launches won’t be auto-masked; create placeholders (e.g., `touch path/.env`) before starting or restart the session after adding secrets.

## Development

- `npm run dev` – Execute the TypeScript entry point directly with `ts-node`.
- `npm run build` – Compile into `dist/`.
- `npm run clean` – Remove build artifacts.

Feel free to open issues or PRs for additional agents or tighter security defaults.
