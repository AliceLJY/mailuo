#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd -P)
APP_DIR="${REPO_ROOT}/app"
DIST_DIR="${APP_DIR}/dist"
APP_ENV_FILE="${APP_DIR}/.env"
SERVER_LINK_PATH="${REPO_ROOT}/server"
SERVER_DIR_EXPECTED="${REPO_ROOT}/server"

if [ ! -d "${APP_DIR}" ]; then
  echo "Missing app directory: ${APP_DIR}" >&2
  exit 1
fi

if [ ! -d "${SERVER_LINK_PATH}" ]; then
  echo "Missing server directory: ${SERVER_LINK_PATH}" >&2
  exit 1
fi

if [ -L "${SERVER_LINK_PATH}" ]; then
  echo "Refusing to use symlinked server directory: ${SERVER_LINK_PATH}" >&2
  exit 1
fi

SERVER_DIR=$(cd "${SERVER_LINK_PATH}" && pwd -P)
if [ "${SERVER_DIR}" != "${SERVER_DIR_EXPECTED}" ]; then
  echo "Refusing to use unexpected server directory: ${SERVER_DIR}" >&2
  exit 1
fi

PUBLIC_DIR="${SERVER_DIR}/public"
PUBLIC_LINK_PATH="${SERVER_LINK_PATH}/public"

if [ -L "${PUBLIC_LINK_PATH}" ]; then
  echo "Refusing to sync to symlinked public directory: ${PUBLIC_LINK_PATH}" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required but not available in PATH" >&2
  exit 1
fi

read_env_key_value() {
  local env_file="$1"
  local key="$2"

  node - "${env_file}" "${key}" <<'NODE'
const fs = require("node:fs");
const envFile = process.argv[2];
const key = process.argv[3];
let value = "";

function parseAssignedValue(rawValue, lineNumber) {
  const trimmedStart = rawValue.replace(/^\s+/, "");

  if (trimmedStart === "") {
    return "";
  }

  const firstChar = trimmedStart[0];
  if (firstChar === '"' || firstChar === "'") {
    let parsed = "";
    let index = 1;

    while (index < trimmedStart.length) {
      const currentChar = trimmedStart[index];
      if (currentChar === firstChar) {
        const remainder = trimmedStart.slice(index + 1).trimStart();
        if (remainder !== "" && !remainder.startsWith("#")) {
          throw new Error(`Invalid trailing content on line ${lineNumber}`);
        }
        return parsed;
      }

      parsed += currentChar;
      index += 1;
    }

    throw new Error(`Unterminated quoted value on line ${lineNumber}`);
  }

  return trimmedStart.replace(/\s+#.*$/, "").trim();
}

for (const [index, line] of fs.readFileSync(envFile, "utf8").split(/\r?\n/).entries()) {
  if (/^\s*(#|$)/.test(line)) {
    continue;
  }

  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match || match[1] !== key) {
    continue;
  }

  value = parseAssignedValue(match[2], index + 1);
}

process.stdout.write(value);
NODE
}

cd "${APP_DIR}"
EXPO_NO_DOTENV=1 EXPO_PUBLIC_API_URL= npx expo export --platform web --clear

if [ ! -d "${DIST_DIR}" ]; then
  echo "Web export did not produce ${DIST_DIR}" >&2
  exit 1
fi

app_api_url=""
if [ -f "${APP_ENV_FILE}" ]; then
  if ! app_api_url=$(read_env_key_value "${APP_ENV_FILE}" "EXPO_PUBLIC_API_URL"); then
    echo "Failed to parse ${APP_ENV_FILE}" >&2
    exit 1
  fi
fi

if [ -n "${app_api_url}" ] && grep -R -F -q -I -- "${app_api_url}" "${DIST_DIR}"; then
  echo "Web export still contains app/.env EXPO_PUBLIC_API_URL; refusing to sync dist" >&2
  exit 1
fi

if grep -R -E -q -I 'https?://[^[:space:]]+/api' "${DIST_DIR}"; then
  echo "Web export contains an absolute API URL; refusing to sync dist" >&2
  exit 1
fi

mkdir -p "${PUBLIC_DIR}"
actual_public_dir=$(cd "${PUBLIC_DIR}" && pwd -P)

if [ "${actual_public_dir}" != "${PUBLIC_DIR}" ]; then
  echo "Refusing to sync to unexpected public directory: ${actual_public_dir}" >&2
  exit 1
fi

rsync -a --delete "${DIST_DIR}/" "${PUBLIC_DIR}/"

echo "Web assets synced to ${PUBLIC_DIR}"
find "${PUBLIC_DIR}" -maxdepth 2 -type f | LC_ALL=C sort | sed "s|^${REPO_ROOT}/||"
