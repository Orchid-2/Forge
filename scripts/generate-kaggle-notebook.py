"""Generates the Kaggle notebook as a valid .ipynb."""
import json, pathlib

def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").split("\n")}

def code(text):
    return {"cell_type": "code", "execution_count": None, "metadata": {},
            "outputs": [], "source": text.strip("\n").split("\n")}

cells = []

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md(r"""
# Forge on Kaggle

Runs [Forge](https://github.com/Orchid-2/Forge) — a local-first personal AI workspace —
on a Kaggle GPU, reachable from your browser through a Cloudflare tunnel.

**Run the cells top to bottom.** Setup takes 6–10 minutes on first run, most of it
downloading the model.

---

### Before you start

**1. Turn on the internet.** Right sidebar → *Session options* → *Internet* → **On**.
Kaggle requires a phone-verified account for this. Nothing below works without it.

**2. Turn on the GPU.** Right sidebar → *Session options* → *Accelerator* → **GPU T4 x2**.
Optional, but a 8B model on CPU generates roughly one token per second, which is
unusable. With a T4 you get 30–50 tok/s.

**3. Give it access to the repo.** Forge's repo is private, so you need one of:

- **A GitHub token** (recommended). Create a fine-grained PAT with *Contents: Read*
  at [github.com/settings/tokens](https://github.com/settings/tokens?type=beta), then
  add it here: *Add-ons → Secrets → Add secret*, labelled exactly `GITHUB_TOKEN`.
- **Or make the repo public**, and skip the token entirely.

---

### What you should know

Forge is designed to be *local-first* — the whole point is your conversations living
on your own machine. Running it here is a good way to try it without local hardware,
or to run a model bigger than your laptop can hold. It is not where you should keep
anything you care about:

- **Sessions end.** 9 hours with a GPU, 12 without, and Kaggle stops idle sessions
  sooner. The final cell keeps the kernel busy so this does not happen while you use it.
- **Your database survives**, because it is written to `/kaggle/working`. Models are not
  cached there by default — they would eat the 20 GB output quota — so each new session
  re-downloads the model.
- **The tunnel URL is public.** Anyone with the link can use your Forge instance while
  it runs. It changes every session and dies with it, but do not share it.
"""))

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("## 1 · Preflight"))

cells.append(code(r'''
"""Checks the things that actually cause failures, before spending time on setup."""
import os, shutil, subprocess, urllib.request

def sh(cmd, **kw):
    """Run a shell command, capture everything, never raise."""
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)

print("Forge on Kaggle — preflight")
print("─" * 52)

# Internet is off by default on Kaggle and is the single most common failure.
try:
    urllib.request.urlopen("https://registry.npmjs.org", timeout=10)
    print("internet   on")
except Exception:
    print("internet   OFF")
    raise SystemExit(
        "\n  Nothing can install without it.\n"
        "  Right sidebar → Session options → Internet → On.\n"
        "  (Kaggle requires a phone-verified account to enable this.)"
    )

gpu = sh("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader")
HAS_GPU = gpu.returncode == 0 and bool(gpu.stdout.strip())
if HAS_GPU:
    print("gpu       ", gpu.stdout.strip().replace("\n", " + "))
else:
    print("gpu        none — will use a small model; expect it to be slow")

print("cpu       ", sh("nproc").stdout.strip(), "cores")
print("ram       ", sh("free -g | awk '/^Mem:/{print $2}'").stdout.strip(), "GB")
print("disk      ", shutil.disk_usage("/kaggle/working").free // 2**30, "GB free in /kaggle/working")

# Everything Forge writes — the SQLite database above all — goes here so it
# survives the session ending.
PERSIST = "/kaggle/working/forge-data"
os.makedirs(PERSIST, exist_ok=True)
print("persist   ", PERSIST)
''' ))

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("""
## 2 · Node.js

Kaggle ships an older Node than Forge needs. This drops an official Node 22 build into
`/opt` — about 30 seconds, and far more predictable than trying to upgrade in place.
"""))

cells.append(code(r'''
import os, subprocess

NODE_VERSION = "22.14.0"
NODE_HOME = f"/opt/node-v{NODE_VERSION}-linux-x64"

if not os.path.exists(f"{NODE_HOME}/bin/node"):
    print(f"installing node {NODE_VERSION}…")
    url = f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz"
    subprocess.run(f"curl -fsSL {url} | tar -xJ -C /opt", shell=True, check=True)

# Prepend to PATH for this kernel *and* for every subprocess it spawns.
os.environ["PATH"] = f"{NODE_HOME}/bin:" + os.environ["PATH"]

# Corepack ships with Node and installs the exact pnpm the repo pins.
subprocess.run("corepack enable", shell=True, check=False)
subprocess.run("corepack prepare pnpm@9.15.4 --activate", shell=True, check=False)

for tool in ("node", "pnpm"):
    version = subprocess.run(f"{tool} --version", shell=True, capture_output=True, text=True)
    print(f"{tool:6} {version.stdout.strip() or 'NOT FOUND'}")
''' ))

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("""
## 3 · Get the code

Reads a GitHub token from Kaggle Secrets if one is set. If the repo is public, no token
is needed and this falls through to an anonymous clone.
"""))

cells.append(code(r'''
import os, shutil, subprocess

REPO   = "Orchid-2/Forge"
BRANCH = "claude/forge-personal-ai-app-x5c1zb"
APP    = "/kaggle/working/forge"

# A token in Kaggle Secrets is the supported path for a private repo. Absent one,
# try anonymously — which works if the repo is public.
token = ""
try:
    from kaggle_secrets import UserSecretsClient
    token = UserSecretsClient().get_secret("GITHUB_TOKEN").strip()
    print("using GITHUB_TOKEN from Kaggle Secrets")
except Exception:
    print("no GITHUB_TOKEN secret found — trying an anonymous clone")

remote = f"https://{token}@github.com/{REPO}.git" if token else f"https://github.com/{REPO}.git"

if os.path.exists(APP):
    print("repo already present, pulling latest…")
    subprocess.run(f"cd {APP} && git fetch origin {BRANCH} && git reset --hard origin/{BRANCH}",
                   shell=True, check=True)
else:
    result = subprocess.run(
        f"git clone --depth 1 --branch {BRANCH} {remote} {APP}",
        shell=True, capture_output=True, text=True,
    )
    if result.returncode != 0:
        # Scrub the token before printing anything git said.
        message = result.stderr.replace(token, "***") if token else result.stderr
        print(message)
        raise SystemExit(
            "\n  Clone failed. Almost always one of:\n"
            "    • The repo is private and no GITHUB_TOKEN secret is set.\n"
            "      Add-ons → Secrets → Add secret, labelled exactly GITHUB_TOKEN.\n"
            "    • The token lacks 'Contents: Read' on this repository.\n"
            f"    • The branch '{BRANCH}' does not exist."
        )

os.chdir(APP)
head = subprocess.run("git log --oneline -1", shell=True, capture_output=True, text=True)
print("\nhead:", head.stdout.strip())
print("files:", subprocess.run("git ls-files | wc -l", shell=True, capture_output=True, text=True).stdout.strip())
''' ))

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("""
## 4 · Install and build

`pnpm install` pulls a native SQLite binding, so this is the slowest non-model step —
roughly 60–90 seconds. Building for production rather than running the dev server makes
every request afterwards noticeably faster.
"""))

cells.append(code(r'''
import os, subprocess

os.chdir(APP)

# Point Forge's data directory at persistent storage, so the SQLite database
# survives this session ending. Forge reads this on boot.
os.environ["FORGE_DATA_DIR"] = PERSIST
os.environ["FORGE_DB_PATH"] = f"{PERSIST}/forge.db"

print("installing dependencies…")
install = subprocess.run("pnpm install --frozen-lockfile 2>&1 | tail -5",
                         shell=True, capture_output=True, text=True)
print(install.stdout)

print("building…")
build = subprocess.run("pnpm build 2>&1 | tail -25", shell=True, capture_output=True, text=True)
print(build.stdout)

if "Compiled successfully" not in build.stdout:
    raise SystemExit("  Build failed — see the output above.")

# Cheap confidence check that the native module actually loaded.
check = subprocess.run(
    """node -e "const D=require('better-sqlite3'); new D(':memory:').exec('create table t(a)'); console.log('sqlite ok')" """,
    shell=True, capture_output=True, text=True, cwd=APP,
)
print(check.stdout.strip() or check.stderr.strip())
''' ))

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("""
## 5 · Ollama and the model

Installs Ollama, starts it, and pulls a chat model sized to whatever hardware this
session got. This is the long step — a few minutes on a T4.

Change `CHAT_MODEL` if you want something else. Forge is built for uncensored and
abliterated fine-tunes, so those are worth trying here:
`huihui_ai/llama3.2-abliterate`, `dolphin3`, `hermes3`.
"""))

cells.append(code(r'''
import os, subprocess, time, urllib.request

# A T4 holds a quantised 8B comfortably. Without one, only a small model is bearable.
CHAT_MODEL = "llama3.1:8b" if HAS_GPU else "llama3.2:1b"
EMBED_MODEL = "nomic-embed-text"   # 274 MB — turns memory semantic rather than lexical

if subprocess.run("which ollama", shell=True, capture_output=True).returncode != 0:
    print("installing ollama…")
    subprocess.run("curl -fsSL https://ollama.com/install.sh | sh", shell=True, check=True)

# Start the server detached, logging to a file we can tail later.
ollama_log = open("/kaggle/working/ollama.log", "w")
ollama = subprocess.Popen(
    ["ollama", "serve"],
    stdout=ollama_log, stderr=subprocess.STDOUT,
    env={**os.environ, "OLLAMA_HOST": "127.0.0.1:11434"},
)

# Wait for it rather than guessing at a sleep duration.
for attempt in range(60):
    try:
        urllib.request.urlopen("http://127.0.0.1:11434/api/version", timeout=2)
        print("ollama up")
        break
    except Exception:
        time.sleep(1)
else:
    raise SystemExit("  Ollama did not come up. Check /kaggle/working/ollama.log")

for model in (CHAT_MODEL, EMBED_MODEL):
    print(f"\npulling {model} — this is the slow part…")
    # Stream progress so a multi-gigabyte download does not look like a hang.
    pull = subprocess.Popen(["ollama", "pull", model],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    last = ""
    for line in pull.stdout:
        line = line.strip()
        if line and line != last and "%" in line:
            print(f"  {line[:90]}", end="\r")
            last = line
    pull.wait()
    print(f"\n  {model} ready" if pull.returncode == 0 else f"\n  {model} FAILED")

print("\ninstalled:")
print(subprocess.run("ollama list", shell=True, capture_output=True, text=True).stdout)
''' ))

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("""
## 6 · Start Forge

Boots the server and points it at Ollama through Forge's own settings API, so the app
opens with a model already selected rather than an empty switcher.
"""))

cells.append(code(r'''
import json, os, subprocess, time, urllib.request

PORT = 3000

forge_log = open("/kaggle/working/forge.log", "w")
forge = subprocess.Popen(
    ["node", "node_modules/next/dist/bin/next", "start", "-p", str(PORT)],
    cwd=APP, stdout=forge_log, stderr=subprocess.STDOUT,
    env={**os.environ,
         "FORGE_DATA_DIR": PERSIST,
         "FORGE_DB_PATH": f"{PERSIST}/forge.db",
         "NODE_ENV": "production"},
)

for attempt in range(60):
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/settings", timeout=2)
        print("forge up")
        break
    except Exception:
        time.sleep(1)
else:
    raise SystemExit("  Forge did not start. Check /kaggle/working/forge.log")


def api(path, payload=None, method="GET"):
    """Small helper for talking to Forge's own API."""
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}", data=body, method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read())


# Discover what Ollama has, then set the default so the app is usable on open.
api("/api/models", method="POST")
api("/api/settings", {"defaultProvider": "ollama", "defaultModel": CHAT_MODEL,
                      "embeddingModel": EMBED_MODEL}, method="PATCH")

settings = api("/api/settings")["settings"]
profiles = api("/api/profiles")["profiles"]
models = api("/api/models")["models"]

print(f"\nmodel      {settings['defaultModel']}")
print(f"embedding  {settings['embeddingModel']}")
print(f"available  {', '.join(m['name'] for m in models)}")
print(f"personas   {', '.join(p['name'] for p in profiles)}")
''' ))

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("""
## 7 · Open it

Kaggle exposes no inbound ports, so a Cloudflare quick tunnel gives the local server a
public HTTPS address. It needs no account and no token.

**The URL this prints is public** — anyone holding it can use your Forge instance for as
long as this session runs. It dies with the session.
"""))

cells.append(code(r'''
import os, re, subprocess, time

CLOUDFLARED = "/usr/local/bin/cloudflared"

if not os.path.exists(CLOUDFLARED):
    print("installing cloudflared…")
    subprocess.run(
        "curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/"
        f"cloudflared-linux-amd64 -o {CLOUDFLARED} && chmod +x {CLOUDFLARED}",
        shell=True, check=True,
    )

tunnel_log = "/kaggle/working/tunnel.log"
tunnel = subprocess.Popen(
    [CLOUDFLARED, "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate"],
    stdout=open(tunnel_log, "w"), stderr=subprocess.STDOUT,
)

# cloudflared prints the assigned hostname a second or two after starting.
public_url = None
for attempt in range(45):
    time.sleep(1)
    try:
        with open(tunnel_log) as handle:
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", handle.read())
        if match:
            public_url = match.group(0)
            break
    except FileNotFoundError:
        pass

if not public_url:
    raise SystemExit(f"  Tunnel did not come up. Check {tunnel_log}")

print("\n" + "═" * 62)
print("  Forge is live at:\n")
print(f"      {public_url}")
print("\n  Give it a few seconds to become reachable, then open it.")
print("═" * 62)
''' ))

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("""
## 8 · Keep it alive

Kaggle stops sessions it thinks are idle, and traffic through the tunnel does not count
as activity. This cell blocks so the kernel stays busy.

**Leave it running while you use Forge.** Interrupt it when you are done.
"""))

cells.append(code(r'''
import time
from datetime import datetime, timedelta

started = datetime.now()
limit = timedelta(hours=8, minutes=45) if HAS_GPU else timedelta(hours=11, minutes=45)

print(f"Forge:  {public_url}")
print(f"Session ends in about {limit}. Interrupt this cell when you are done.\n")

try:
    while True:
        time.sleep(60)
        elapsed = datetime.now() - started
        if elapsed > limit:
            print("\nApproaching Kaggle's session limit — save anything you need.")
            break
        # A heartbeat, and confirmation the server has not fallen over.
        alive = "up"
        try:
            import urllib.request
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/settings", timeout=5)
        except Exception:
            alive = "DOWN — check /kaggle/working/forge.log"
        print(f"  {str(elapsed).split('.')[0]}  forge {alive}", end="\r")
except KeyboardInterrupt:
    print("\n\nStopping…")
finally:
    # Forge runs SQLite in WAL mode, so the newest writes sit in forge.db-wal
    # rather than in forge.db. Checkpointing folds them in, which makes the .db
    # file self-contained — otherwise downloading it alone silently loses your
    # most recent conversations.
    try:
        import sqlite3
        connection = sqlite3.connect(f"{PERSIST}/forge.db")
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        connection.close()
        print(f"Database checkpointed. {PERSIST}/forge.db is complete on its own.")
    except Exception as error:
        print(f"Could not checkpoint ({error}) — download forge.db AND forge.db-wal.")
''' ))

# ─────────────────────────────────────────────────────────────────────────────
cells.append(md("""
---

## Troubleshooting

**Clone fails** — the repo is private. Add a fine-grained PAT with *Contents: Read* as a
Kaggle secret labelled exactly `GITHUB_TOKEN`, then re-run cell 3.

**Build fails on `better-sqlite3`** — the prebuilt binary did not match. Force a source
build: `!cd /kaggle/working/forge && pnpm rebuild better-sqlite3`.

**Model replies at a crawl** — no GPU. Check cell 1; if it says `gpu none`, enable
*GPU T4 x2* in Session options and re-run from the top.

**Tunnel URL 502s** — Forge is still booting, or fell over. `!tail -30 /kaggle/working/forge.log`.

**Everything vanished after a restart** — expected for models and `node_modules`. Your
conversations and memories are in `/kaggle/working/forge-data` and survive; re-run cells
2 through 7 to rebuild the rest.

## Keeping your data

The SQLite database in `/kaggle/working/forge-data` persists across sessions of this
notebook. Interrupting cell 8 checkpoints it, so `forge.db` is complete on its own — you
can download it from the *Output* tab and drop it straight into a local install's `data/`
folder. If a session dies without that, take `forge.db-wal` alongside it.

The more durable route is Forge's Hugging Face backup: add a write token in
*Settings → Integrations*, name a private dataset repo, and push. That path is the one
worth using if you intend to move to a local install later.
"""))

notebook = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.11"},
        "kaggle": {"accelerator": "nvidiaTeslaT4", "dataSources": [],
                   "isInternetEnabled": True, "language": "python",
                   "sourceType": "notebook"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

out = pathlib.Path("notebooks/forge-on-kaggle.ipynb")
out.write_text(json.dumps(notebook, indent=1) + "\n")
print(f"wrote {out} — {len(cells)} cells")
