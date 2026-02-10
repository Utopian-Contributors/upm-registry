#!/bin/bash

# Exit on error
set -e

# Check required env vars
: "${NAMESPACE:?Environment variable NAMESPACE is required}"
: "${RELEASE_NAME:?Environment variable RELEASE_NAME is required}"
: "${RELEASE_TAG:?Environment variable RELEASE_TAG is required}"
: "${NFS_SERVER:?Environment variable NFS_SERVER is required}"
: "${NFS_PATH:?Environment variable NFS_PATH is required}"

helm upgrade $RELEASE_NAME chart \
  --install \
  --namespace $NAMESPACE \
  --set image.tag=${RELEASE_TAG} \
  --set nfs.server=${DO_NFS_SERVER} \
  --set nfs.path=${DO_NFS_PATH} \
  --values chart/values.yaml