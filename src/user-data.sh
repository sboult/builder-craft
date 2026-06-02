#!/bin/bash
set -euxo pipefail

log() {
  printf '[buildercraft] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

curl_retry() {
  curl \
    -fsSL \
    --retry 8 \
    --retry-delay 5 \
    --retry-max-time 300 \
    --retry-connrefused \
    --retry-all-errors \
    --connect-timeout 20 \
    "$@"
}

MINECRAFT_HOME=/opt/minecraft
SERVER_DIR=/opt/minecraft/server
MINECRAFT_VERSION='26.1.2'
PAPER_BUILD='66'
PAPER_DOWNLOAD_URL=''
BUILDERCRAFT_USER_AGENT='buildercraft-cdk/1.0'
JAVA_MEMORY_MIN='512M'
JAVA_MEMORY_MAX='1G'
JAVA_HOME="/usr/lib/jvm/java-25-amazon-corretto.$(uname -m)"
JAVA_BIN="$JAVA_HOME/bin/java"

log "Installing operating system packages"
dnf update -y
dnf install -y java-25-amazon-corretto-headless jq
"$JAVA_BIN" -version

log "Creating minecraft service user and directories"
if ! id minecraft >/dev/null 2>&1; then
  useradd --system --home "$MINECRAFT_HOME" --shell /bin/bash minecraft
fi
install -d -o minecraft -g minecraft "$SERVER_DIR"

log "Downloading pinned PaperMC build"
PAPER_JAR="$SERVER_DIR/paper.jar"
if [ ! -s "$PAPER_JAR" ]; then
  if [ -z "$PAPER_DOWNLOAD_URL" ]; then
    BUILDS_RESPONSE="$(curl_retry -H "User-Agent: $BUILDERCRAFT_USER_AGENT" "https://fill.papermc.io/v3/projects/paper/versions/$MINECRAFT_VERSION/builds")"
    PAPER_DOWNLOAD_URL="$(printf '%s' "$BUILDS_RESPONSE" | jq -r --arg build "$PAPER_BUILD" 'first(.[] | select((((.id // .number) | tostring) == $build or (.id | tostring) == $build or (.number | tostring) == $build) and .channel == "STABLE") | .downloads."server:default".url) // empty')"
  fi

  if [ -z "$PAPER_DOWNLOAD_URL" ]; then
    log "No stable PaperMC download URL found for version $MINECRAFT_VERSION build $PAPER_BUILD"
    exit 1
  fi

  curl_retry -H "User-Agent: $BUILDERCRAFT_USER_AGENT" -o "$PAPER_JAR" "$PAPER_DOWNLOAD_URL"
fi

log "Installing Minecraft plugins"
PLUGINS_DIR="$SERVER_DIR/plugins"
PLUGIN_MANIFEST="$SERVER_DIR/buildercraft-plugins.json"
install -d -o minecraft -g minecraft "$PLUGINS_DIR"

cat > "$PLUGIN_MANIFEST" <<'PLUGIN_MANIFEST_JSON'
[
  {
    "name": "AdvancedSensitiveWords",
    "source": "modrinth",
    "project": "advancedsensitivewords",
    "version": "Eh9FhiuS",
    "loaders": ["paper", "bukkit", "spigot"]
  },
  {
    "name": "WorldEdit",
    "source": "modrinth",
    "project": "worldedit",
    "version": "yDUBafTJ",
    "loaders": ["paper", "bukkit", "spigot"],
    "gameVersions": ["26.1.2"]
  }
]
PLUGIN_MANIFEST_JSON

select_modrinth_version() {
  local versions_response="$1"
  local requested_version="$2"
  local loaders_json="$3"
  local game_versions_json="$4"

  printf '%s' "$versions_response" | jq -c --arg requestedVersion "$requested_version" --argjson loaders "$loaders_json" --argjson gameVersions "$game_versions_json" '
    def intersects($wanted): any(.[]; $wanted | index(.));
    [
      .[]
      | select(.version_type == "release")
      | select($requestedVersion == "" or .id == $requestedVersion or .version_number == $requestedVersion)
      | select(($loaders | length) == 0 or (.loaders | intersects($loaders)))
      | select(($gameVersions | length) == 0 or (.game_versions | intersects($gameVersions)))
    ]
    | first // empty
  '
}

download_plugin() {
  local plugin_json="$1"
  local plugin_name source project requested_version loaders_json game_versions_json
  local download_url plugin_file_name expected_sha256 expected_sha512 source_file_name

  plugin_name="$(printf '%s' "$plugin_json" | jq -r '.name')"
  source="$(printf '%s' "$plugin_json" | jq -r '.source // empty')"
  download_url="$(printf '%s' "$plugin_json" | jq -r '.url // empty')"
  expected_sha256="$(printf '%s' "$plugin_json" | jq -r '.sha256 // empty')"
  expected_sha512="$(printf '%s' "$plugin_json" | jq -r '.sha512 // empty')"
  source_file_name=''

  if [ "$source" = "modrinth" ]; then
    local encoded_project versions_response version_json file_json modrinth_sha512

    project="$(printf '%s' "$plugin_json" | jq -r '.project')"
    requested_version="$(printf '%s' "$plugin_json" | jq -r '.version // empty')"
    loaders_json="$(printf '%s' "$plugin_json" | jq -c '.loaders // []')"
    game_versions_json="$(printf '%s' "$plugin_json" | jq -c '.gameVersions // []')"
    encoded_project="$(jq -nr --arg value "$project" '$value | @uri')"

    versions_response="$(curl_retry -H "User-Agent: $BUILDERCRAFT_USER_AGENT" "https://api.modrinth.com/v2/project/$encoded_project/version")"
    version_json="$(select_modrinth_version "$versions_response" "$requested_version" "$loaders_json" "$game_versions_json")"

    if [ -z "$version_json" ]; then
      log "No Modrinth release matched plugin $plugin_name"
      exit 1
    fi

    file_json="$(printf '%s' "$version_json" | jq -c '(.files | map(select(.primary))[0]) // .files[0] // empty')"
    if [ -z "$file_json" ]; then
      log "No downloadable file found for plugin $plugin_name"
      exit 1
    fi

    download_url="$(printf '%s' "$file_json" | jq -r '.url')"
    source_file_name="$(printf '%s' "$file_json" | jq -r '.filename')"
    modrinth_sha512="$(printf '%s' "$file_json" | jq -r '.hashes.sha512 // empty')"
    if [ -z "$expected_sha512" ]; then
      expected_sha512="$modrinth_sha512"
    fi
  fi

  if [ -z "$download_url" ]; then
    log "No download URL resolved for plugin $plugin_name"
    exit 1
  fi

  plugin_file_name="$(printf '%s' "$plugin_json" | jq -r '.fileName // empty')"
  if [ -z "$plugin_file_name" ]; then
    if [ -n "$source_file_name" ]; then
      plugin_file_name="$source_file_name"
    else
      plugin_file_name="$(basename -- "$download_url")"
      plugin_file_name="$(printf '%s' "$plugin_file_name" | sed 's/[?#].*$//')"
    fi
  fi
  plugin_file_name="$(basename -- "$plugin_file_name")"

  case "$plugin_file_name" in
    *.jar) ;;
    *)
      log "Refusing plugin $plugin_name because $plugin_file_name is not a .jar file"
      exit 1
      ;;
  esac

  local tmp_file
  tmp_file="$(mktemp /tmp/buildercraft-plugin.XXXXXX.jar)"
  log "Downloading plugin $plugin_name"
  curl_retry -H "User-Agent: $BUILDERCRAFT_USER_AGENT" -o "$tmp_file" "$download_url"

  if [ -n "$expected_sha512" ]; then
    printf '%s  %s\n' "$expected_sha512" "$tmp_file" | sha512sum -c -
  fi
  if [ -n "$expected_sha256" ]; then
    printf '%s  %s\n' "$expected_sha256" "$tmp_file" | sha256sum -c -
  fi

  install -o minecraft -g minecraft -m 0644 "$tmp_file" "$PLUGINS_DIR/$plugin_file_name"
  rm -f "$tmp_file"
}

while IFS= read -r plugin_json; do
  download_plugin "$plugin_json"
done < <(jq -c '.[]' "$PLUGIN_MANIFEST")

log "Configuring AdvancedSensitiveWords"
ASW_DIR="$PLUGINS_DIR/AdvancedSensitiveWords"
ASW_EXTERNAL_DENY_DIR="$ASW_DIR/external/deny"
ASW_EXTERNAL_ALLOW_DIR="$ASW_DIR/external/allow"
ASW_ONLINE_WORDS_URL='https://raw.githubusercontent.com/censor-text/profanity-list/refs/heads/main/list/en.txt'
install -d -o minecraft -g minecraft "$ASW_DIR" "$ASW_EXTERNAL_DENY_DIR" "$ASW_EXTERNAL_ALLOW_DIR"

cat > "$ASW_DIR/config.yml" <<'ASW_CONFIG'
Plugin:
  language: en
  enableDefaultWords: true
  enableOnlineWords: false
  onlineWordsUrl: "https://raw.githubusercontent.com/censor-text/profanity-list/refs/heads/main/list/en.txt"
  onlineWordsEncoding: "UTF-8"
  cacheOnlineWords: true
  logViolation: true
  noticeOperator: true
  replacement: "*"
  punishment: []
Chat:
  method: "replace"
  sendMessage: true
  punish: false
ASW_CONFIG

log "Downloading AdvancedSensitiveWords deny list into local external deny file"
ASW_ONLINE_WORDS_FILE="$ASW_EXTERNAL_DENY_DIR/buildercraft-online-deny.txt"
ASW_ONLINE_WORDS_TMP="$(mktemp /tmp/buildercraft-asw-words.XXXXXX)"
curl_retry -H "User-Agent: $BUILDERCRAFT_USER_AGENT" --max-time 30 -o "$ASW_ONLINE_WORDS_TMP" "$ASW_ONLINE_WORDS_URL"
tr -s '[:space:]' '\n' < "$ASW_ONLINE_WORDS_TMP" | sed '/^$/d' > "$ASW_ONLINE_WORDS_FILE"
rm -f "$ASW_ONLINE_WORDS_TMP"

if [ ! -s "$ASW_ONLINE_WORDS_FILE" ]; then
  log "AdvancedSensitiveWords deny list was empty after normalization"
  exit 1
fi

log "Writing Minecraft configuration files"
cat > "$SERVER_DIR/eula.txt" <<'EULA'
eula=true
EULA

cat > "$SERVER_DIR/server.properties" <<'PROPERTIES'
server-port=25565
max-players=150
enable-rcon=false
enable-query=false
white-list=false
enforce-whitelist=false
motd=BuilderCraft
difficulty=normal
gamemode=survival
level-name=world
view-distance=6
simulation-distance=4
network-compression-threshold=256
sync-chunk-writes=false
online-mode=true
PROPERTIES

cat > "$SERVER_DIR/ops.json" <<'OPS'
[
  {
    "uuid": "278b452e-27fe-4ae8-baf0-b3381bb73e99",
    "name": "us_east_1",
    "level": 4,
    "bypassesPlayerLimit": true
  }
]
OPS

chown -R minecraft:minecraft "$MINECRAFT_HOME"

log "Creating systemd service"
cat > /etc/systemd/system/minecraft.service <<SERVICE
[Unit]
Description=Minecraft Paper Server
Wants=network-online.target
After=network-online.target

[Service]
User=minecraft
Group=minecraft
WorkingDirectory=$SERVER_DIR
Environment=JAVA_HOME=$JAVA_HOME
ExecStart=$JAVA_BIN -Xms$JAVA_MEMORY_MIN -Xmx$JAVA_MEMORY_MAX -jar paper.jar nogui
Restart=on-failure
RestartSec=10
SuccessExitStatus=0 143

[Install]
WantedBy=multi-user.target
SERVICE

log "Starting Minecraft service"
systemctl daemon-reload
systemctl enable minecraft
systemctl restart minecraft

echo "ready $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SERVER_DIR/.buildercraft-ready"
chown minecraft:minecraft "$SERVER_DIR/.buildercraft-ready"

log "Minecraft bootstrap complete"
