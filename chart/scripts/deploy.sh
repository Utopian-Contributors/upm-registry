#!/bin/bash

# Exit on error
set -e

# Check required env vars
: "${NAMESPACE:?Environment variable NAMESPACE is required}"
: "${RELEASE_NAME:=?Release name is required}"
: "${RELEASE_TAG:=?Release tag is required}"

# Or manually
helm upgrade $RELEASE_NAME chart \
  --install \
  --namespace $NAMESPACE \
  --set api.image.tag=${RELEASE_TAG} \
  --values chart/values.yaml \