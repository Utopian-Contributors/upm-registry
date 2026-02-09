#!/bin/bash

# Exit on error
set -e

# Check required env vars
: "${GITHUB_USERNAME:?Environment variable GITHUB_USERNAME is required}"
: "${GITHUB_TOKEN:?Environment variable GITHUB_TOKEN is required}"
: "${NAMESPACE:?Environment variable NAMESPACE is required}"
: "${SECRET_NAME:=ghcr-secret}"

# Create or replace Docker registry secret
kubectl delete secret "$SECRET_NAME" --namespace "$NAMESPACE" --ignore-not-found

kubectl create secret docker-registry "$SECRET_NAME" \
  --docker-server=ghcr.io \
  --docker-username="$GITHUB_USERNAME" \
  --docker-password="$GITHUB_TOKEN" \
  --namespace "$NAMESPACE"

# Patch the default service account to use this imagePullSecret
kubectl patch serviceaccount default \
  --namespace "$NAMESPACE" \
  --type merge \
  -p "{\"imagePullSecrets\": [{\"name\": \"$SECRET_NAME\"}]}"

echo "✅ Secret '$SECRET_NAME' added to namespace '$NAMESPACE' and attached to the default service account."
