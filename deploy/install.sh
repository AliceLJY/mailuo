#!/usr/bin/env bash
set -euo pipefail

LABEL="com.alice.mailuo-server"
NODE_BIN="/opt/homebrew/bin/node"
NPM_BIN="/opt/homebrew/bin/npm"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd -P)
SERVER_DIR="${REPO_ROOT}/server"
SERVER_LINK_PATH="${REPO_ROOT}/server"
TEMPLATE_PLIST="${SCRIPT_DIR}/${LABEL}.plist"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/ops-logs/mailuo"
ENV_FILE="${SERVER_DIR}/.env"
WEB_INDEX_FILE="${SERVER_DIR}/public/index.html"

if [ ! -x "${NODE_BIN}" ]; then
  echo "Missing Node binary: ${NODE_BIN}" >&2
  exit 1
fi

if [ ! -x "${NPM_BIN}" ]; then
  echo "Missing npm binary: ${NPM_BIN}" >&2
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

actual_server_dir=$(cd "${SERVER_LINK_PATH}" && pwd -P)
if [ "${actual_server_dir}" != "${SERVER_DIR}" ]; then
  echo "Refusing to use unexpected server directory: ${actual_server_dir}" >&2
  exit 1
fi

if [ ! -f "${TEMPLATE_PLIST}" ]; then
  echo "Missing plist template: ${TEMPLATE_PLIST}" >&2
  exit 1
fi

node_major=$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]')
if [ "${node_major}" -lt 26 ]; then
  echo "Node 26+ is required, found ${node_major}" >&2
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing server env file: ${ENV_FILE}" >&2
  echo "Required keys: DASHSCOPE_API_KEY DEEPSEEK_API_KEY" >&2
  echo "Optional key: QWEN_MODEL" >&2
  exit 1
fi

if [ ! -f "${WEB_INDEX_FILE}" ]; then
  echo "Missing web build artifact: ${WEB_INDEX_FILE}" >&2
  echo "Run bash scripts/build-web.sh before install." >&2
  exit 1
fi

if ! env_check_output=$(
  env -i PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="${HOME}" \
    "${NODE_BIN}" --env-file="${ENV_FILE}" -e '
const fs = require("node:fs");
const requiredKeys = ["DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY"];
const envFile = process.argv[1];
const rawValues = new Map();

for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  if (/^\s*(#|$)/.test(line)) {
    continue;
  }

  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!match) {
    continue;
  }

  rawValues.set(match[1], match[2].trim());
}

const missingKeys = requiredKeys.filter((key) => {
  const loadedValue = process.env[key];
  const rawValue = rawValues.get(key);
  return (
    typeof loadedValue !== "string" ||
    loadedValue.trim() === "" ||
    typeof rawValue !== "string" ||
    rawValue.trim() === ""
  );
});

if (missingKeys.length > 0) {
  process.stdout.write(missingKeys.join("\n"));
  process.exit(1);
}
' "${ENV_FILE}" 2>/dev/null
); then
  if [ -n "${env_check_output}" ]; then
    printf '%s\n' "${env_check_output}" >&2
  else
    echo "Failed to load env file: ${ENV_FILE}" >&2
  fi
  exit 1
fi

mkdir -p "${LOG_DIR}" "${LAUNCH_AGENTS_DIR}"

cd "${SERVER_DIR}"
"${NPM_BIN}" ci --include=dev

if [ ! -e "${SERVER_DIR}/node_modules/tsx" ]; then
  echo "Missing server dependency after npm ci: ${SERVER_DIR}/node_modules/tsx" >&2
  exit 1
fi

cp "${TEMPLATE_PLIST}" "${TARGET_PLIST}"
/usr/bin/plutil -replace WorkingDirectory -string "${SERVER_DIR}" "${TARGET_PLIST}"
/usr/bin/plutil -replace StandardOutPath -string "${LOG_DIR}/stdout.log" "${TARGET_PLIST}"
/usr/bin/plutil -replace StandardErrorPath -string "${LOG_DIR}/stderr.log" "${TARGET_PLIST}"

/usr/bin/plutil -lint "${TARGET_PLIST}" >/dev/null

launchctl bootout --wait "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
sleep 2
launchctl bootstrap "gui/${UID}" "${TARGET_PLIST}"

health_url="http://127.0.0.1:3300/api/health"
root_url="http://127.0.0.1:3300/"
attempt=1
max_attempts=6

while [ "${attempt}" -le "${max_attempts}" ]; do
  if health_response=$(curl --silent --show-error --fail --max-time 5 "${health_url}" 2>&1); then
    if health_json=$(printf '%s' "${health_response}" | "${NODE_BIN}" -e '
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  body += chunk;
});
process.stdin.on("end", () => {
  let parsed;

  try {
    parsed = JSON.parse(body);
  } catch {
    process.stdout.write(body, () => process.exit(1));
    return;
  }

  const isHealthy = parsed?.ok === true && parsed?.data?.status === "ok";
  process.stdout.write(body, () => process.exit(isHealthy ? 0 : 1));
});
'); then
      if homepage_response=$(curl --silent --show-error --fail --max-time 5 "${root_url}" 2>&1); then
        if printf '%s' "${homepage_response}" | LC_ALL=C grep -E -q '<!DOCTYPE html|<html[[:space:]>]'; then
          echo "Health response: ${health_json}"
          echo "Web entrypoint check passed: / returned HTML"
          exit 0
        fi

        echo "Web entrypoint check failed: / did not return HTML" >&2
      else
        echo "Web entrypoint check failed: ${homepage_response}" >&2
      fi
    fi

    if [ -n "${health_json}" ]; then
      echo "Health response: ${health_json}" >&2
    fi
  else
    echo "Health check ${attempt}/${max_attempts} failed: ${health_response}" >&2
  fi
  if [ "${attempt}" -lt "${max_attempts}" ]; then
    sleep 2
  fi
  attempt=$((attempt + 1))
done

echo "Health check failed after ${max_attempts} attempts: ${health_url}" >&2
exit 1
