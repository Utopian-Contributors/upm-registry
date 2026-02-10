#!/bin/bash

# Exit on error
set -e

# Check required env vars
: "${NAMESPACE:?Environment variable NAMESPACE is required}"
: "${TREASURY_WALLET_ADDRESS:?Environment variable TREASURY_WALLET_ADDRESS is required}"
: "${DO_NFS_SERVER:?Environment variable DO_NFS_SERVER is required}"
: "${DO_NFS_PATH:?Environment variable DO_NFS_PATH is required}"

# Create namespace if it doesn't exist
kubectl get namespace $NAMESPACE || kubectl create namespace $NAMESPACE

echo "Creating DigitalOcean secret..."
kubectl create secret generic digitalocean-credentials \
  --namespace $NAMESPACE \
  --from-literal=DO_NFS_SERVER="${DO_NFS_SERVER}" \
  --from-literal=DO_NFS_PATH="${DO_NFS_PATH}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Creating Solana secret..."
kubectl create secret generic solana-credentials \
  --namespace $NAMESPACE \
  --from-literal=TREASURY_WALLET_ADDRESS="${TREASURY_WALLET_ADDRESS}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "✅ All secrets created successfully!"