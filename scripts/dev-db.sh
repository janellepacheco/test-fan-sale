#!/usr/bin/env bash
# scripts/dev-db.sh
# Spins up a local Postgres container and runs migrations.
# Requires: Docker, .env (copy from .env.example)
#
# Usage:
#   ./scripts/dev-db.sh          # start DB + migrate
#   ./scripts/dev-db.sh reset    # drop + recreate + migrate

set -euo pipefail

CONTAINER_NAME="fan-sale-db"
DB_NAME="fan_sale_dev"
DB_USER="postgres"
DB_PASSWORD="postgres"
DB_PORT="5432"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:${DB_PORT}/${DB_NAME}"

start_db() {
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "✓ DB container already running"
  else
    echo "→ Starting Postgres container..."
    docker run -d \
      --name "${CONTAINER_NAME}" \
      -e POSTGRES_USER="${DB_USER}" \
      -e POSTGRES_PASSWORD="${DB_PASSWORD}" \
      -e POSTGRES_DB="${DB_NAME}" \
      -p "${DB_PORT}:5432" \
      postgres:16-alpine

    echo "→ Waiting for Postgres to be ready..."
    until docker exec "${CONTAINER_NAME}" pg_isready -U "${DB_USER}" > /dev/null 2>&1; do
      sleep 0.5
    done
    echo "✓ Postgres ready"
  fi
}

run_migrations() {
  echo "→ Running migrations..."
  DATABASE_URL="${DATABASE_URL}" npx prisma migrate deploy
  echo "✓ Migrations applied"
}

reset_db() {
  echo "→ Stopping and removing existing container..."
  docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
  start_db
  run_migrations
}

if [[ "${1:-}" == "reset" ]]; then
  reset_db
else
  start_db
  run_migrations
fi

echo ""
echo "DATABASE_URL=${DATABASE_URL}"
echo "Add this to your .env if it differs from your current value."
