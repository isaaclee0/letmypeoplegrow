#!/bin/sh
# Ensure node_modules has Linux-native binaries from the image build
if [ ! -f node_modules/.package-lock.json ]; then
  echo "Populating node_modules from image..."
  cp -a /tmp/_node_modules/. node_modules/
fi
exec "$@"
