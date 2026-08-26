#!/bin/sh
# Copy built dist to the volume if the volume is empty or older than the image
# This ensures fresh builds populate the volume, while hot deploys persist
if [ ! -f /app/dist/index.cjs ] || [ /app/dist-source/index.cjs -nt /app/dist/index.cjs ]; then
  echo "[entrypoint] Copying fresh dist/ from image to volume..."
  cp -r /app/dist-source/* /app/dist/
fi
exec node /app/dist/index.cjs
