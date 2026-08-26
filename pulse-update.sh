#!/bin/sh
# ---------------------------------------------------------------------------
# PULSE update
#   Pulls the latest commit from GitHub, builds client+server (dist/) inside
#   a throwaway Node container (TrueNAS host has no node/npm installed), then
#   redeploys the running app via TrueNAS's own app.redeploy (midclt) rather
#   than raw docker/compose commands \u2014 Pulse is a proper TrueNAS custom app
#   (see /home/node/.openclaw/workspace/TOOLS.md "TrueNAS ... Docker/App
#   deployment rule" for why this matters: TrueNAS owns the compose project
#   once registered as a custom app, so calling `docker compose` directly
#   here would fight it for container ownership).
#
#   Lives on the NAS at $DIR/pulse-update.sh (see DIR below).
#
#   Same GitHub SSH-over-443 workaround as Beacon: outbound port 22 to
#   github.com is blocked from the office network, so GIT_SSH_COMMAND points
#   at ssh.github.com:443 instead. Uses a dedicated READ-ONLY deploy key
#   (pulse_nas_deploy) \u2014 this box only ever needs to pull, never push.
#
#   dist/ is bind-mounted straight into the running container
#   (/mnt/apps/stacks/pulse/dist -> /app/dist), so a fresh build here takes
#   effect on the very next app.redeploy without rebuilding the Docker image
#   itself \u2014 same "hot-deployable dist volume" design as the Dockerfile
#   comments describe. No docker image rebuild needed for a normal code
#   change; only Dockerfile/package.json changes need `midclt call app.update`
#   with a rebuilt custom_compose_config_string (rare \u2014 do that manually
#   if it ever comes up, this script does not attempt it).
# ---------------------------------------------------------------------------
set -e

# PULSE_DIR/PULSE_KEYS let a deploy point at a different mountpoint without
# editing this script. Defaults match the current TrueNAS layout.
DIR=${PULSE_DIR:-/mnt/apps/stacks/pulse}
KEYS=${PULSE_KEYS:-/mnt/apps/.ssh}
SRC="$DIR/src"

mkdir -p "$SRC"
cd "$SRC"

if [ ! -d .git ]; then
  echo "[pulse] first run \u2014 cloning into $SRC"
  docker run --rm \
    -v "$SRC":/w -w /w \
    -v "$KEYS":/keys:ro \
    -e GIT_SSH_COMMAND="ssh -i /keys/pulse_nas_deploy -o StrictHostKeyChecking=no -o HostName=ssh.github.com -o Port=443" \
    alpine/git:v2.36.3 clone git@github.com:soundmediagroup/pulse.git .
fi

before=$(cat .git/refs/heads/main 2>/dev/null || echo none)

docker run --rm \
  -v "$SRC":/w -w /w \
  -v "$KEYS":/keys:ro \
  -e GIT_SSH_COMMAND="ssh -i /keys/pulse_nas_deploy -o StrictHostKeyChecking=no -o HostName=ssh.github.com -o Port=443" \
  alpine/git:v2.36.3 pull

after=$(cat .git/refs/heads/main 2>/dev/null || echo none)

if [ "$before" = "$after" ]; then
  echo "[pulse] already up to date at ${after%${after#???????}}"
else
  echo "[pulse] updated ${before%${before#???????}} -> ${after%${after#???????}}"
fi

echo "[pulse] building (client + server) inside throwaway node:20-slim container..."
docker run --rm \
  -v "$SRC":/w -w /w \
  node:20-slim \
  sh -c "npm ci --include=dev --no-audit --no-fund && npx tsx script/build.ts"

echo "[pulse] copying fresh dist/ into the live bind-mount ($DIR/dist)..."
rm -rf "$DIR/dist.new"
cp -r "$SRC/dist" "$DIR/dist.new"
rm -rf "$DIR/dist.old"
mv "$DIR/dist" "$DIR/dist.old"
mv "$DIR/dist.new" "$DIR/dist"

echo "[pulse] redeploying via TrueNAS app.redeploy (midclt)..."
JOB_ID=$(midclt call app.redeploy '"pulse"')
echo "[pulse] redeploy job id: $JOB_ID"

# Poll until the job finishes (SUCCESS/FAILED), same pattern used manually
# during the 26 Aug 2026 DEPLOY_TOKEN/Cloudflare-token fix session.
for i in $(seq 1 20); do
  STATE=$(midclt call core.get_jobs "[[\"id\",\"=\",$JOB_ID]]" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['state'])")
  echo "[pulse] redeploy job state: $STATE"
  if [ "$STATE" = "SUCCESS" ]; then
    echo "[pulse] redeploy succeeded \u2014 rolling back dist.old is no longer needed, cleaning up"
    rm -rf "$DIR/dist.old"
    break
  fi
  if [ "$STATE" = "FAILED" ]; then
    echo "[pulse] redeploy FAILED \u2014 restoring previous dist/ from dist.old"
    rm -rf "$DIR/dist"
    mv "$DIR/dist.old" "$DIR/dist"
    midclt call app.redeploy '"pulse"' >/dev/null
    echo "[pulse] rolled back and re-triggered redeploy with the previous build. Investigate before retrying."
    exit 1
  fi
  sleep 3
done

echo "[pulse] ---- health check ----"
# The redeploy job reports SUCCESS as soon as the container is recreated,
# not once Express/SQLite have finished booting and bound the port \u2014
# confirmed via a real deploy run (26 Aug 2026) where an immediate curl
# failed but the same curl succeeded 7s later with no other change. Retry
# for up to ~15s instead of a single shot.
ok=0
for i in $(seq 1 8); do
  if curl -sf http://127.0.0.1:3456/api/healthz; then
    echo
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" != "1" ]; then
  echo "[pulse] WARNING: healthz check failed after retries \u2014 check container logs (docker logs pulse)"
fi
