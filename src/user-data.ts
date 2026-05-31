export type MinecraftDifficulty = "peaceful" | "easy" | "normal" | "hard";
export type MinecraftGameMode =
  | "survival"
  | "creative"
  | "adventure"
  | "spectator";

export interface MinecraftOperator {
  readonly name: string;
  readonly uuid: string;
  readonly level?: number;
  readonly bypassesPlayerLimit?: boolean;
}

export type MinecraftPluginSource = "modrinth";

export interface MinecraftPlugin {
  readonly name: string;
  readonly fileName?: string;
  readonly sha256?: string;
  readonly sha512?: string;
  readonly url?: string;
  readonly source?: MinecraftPluginSource;
  readonly project?: string;
  readonly version?: string;
  readonly loaders?: readonly string[];
  readonly gameVersions?: readonly string[];
}

export interface MinecraftUserDataProps {
  readonly minecraftVersion: string;
  readonly paperBuild: string;
  readonly paperDownloadUrl?: string;

  readonly serverName?: string;
  readonly memoryMin?: string;
  readonly memoryMax?: string;

  readonly motd?: string;
  readonly difficulty?: MinecraftDifficulty;
  readonly gamemode?: MinecraftGameMode;
  readonly maxPlayers?: number;
  readonly viewDistance?: number;
  readonly simulationDistance?: number;
  readonly ops?: readonly MinecraftOperator[];
  readonly plugins?: readonly MinecraftPlugin[];
}

export function renderMinecraftUserData(props: MinecraftUserDataProps): string {
  const memoryMin = props.memoryMin ?? "16G";
  const memoryMax = props.memoryMax ?? "32G";
  const motd = props.motd ?? props.serverName ?? "BuilderCraft";
  const serverProperties = renderServerProperties({
    difficulty: props.difficulty ?? "normal",
    gamemode: props.gamemode ?? "survival",
    maxPlayers: props.maxPlayers ?? 150,
    motd,
    simulationDistance: props.simulationDistance ?? 4,
    viewDistance: props.viewDistance ?? 6,
  });
  const opsJson = JSON.stringify(
    (props.ops ?? []).map((operator) => ({
      uuid: operator.uuid,
      name: operator.name,
      level: operator.level ?? 4,
      bypassesPlayerLimit: operator.bypassesPlayerLimit ?? true,
    })),
    null,
    2,
  );
  const pluginInstallScript = renderPluginInstallScript(props.plugins ?? []);

  return `#!/bin/bash
set -euxo pipefail

log() {
  printf '[buildercraft] %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

MINECRAFT_HOME=/opt/minecraft
SERVER_DIR=/opt/minecraft/server
MINECRAFT_VERSION=${shellQuote(props.minecraftVersion)}
PAPER_BUILD=${shellQuote(props.paperBuild)}
PAPER_DOWNLOAD_URL=${shellQuote(props.paperDownloadUrl ?? "")}
BUILDERCRAFT_USER_AGENT=${shellQuote("buildercraft-cdk/1.0")}
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
    BUILDS_RESPONSE="$(curl -fsSL -H "User-Agent: $BUILDERCRAFT_USER_AGENT" "https://fill.papermc.io/v3/projects/paper/versions/$MINECRAFT_VERSION/builds")"
    PAPER_DOWNLOAD_URL="$(printf '%s' "$BUILDS_RESPONSE" | jq -r --arg build "$PAPER_BUILD" 'first(.[] | select((((.id // .number) | tostring) == $build or (.id | tostring) == $build or (.number | tostring) == $build) and .channel == "STABLE") | .downloads."server:default".url) // empty')"
  fi

  if [ -z "$PAPER_DOWNLOAD_URL" ]; then
    log "No stable PaperMC download URL found for version $MINECRAFT_VERSION build $PAPER_BUILD"
    exit 1
  fi

  curl -fsSL -H "User-Agent: $BUILDERCRAFT_USER_AGENT" -o "$PAPER_JAR" "$PAPER_DOWNLOAD_URL"
fi

${pluginInstallScript}

log "Writing Minecraft configuration files"
cat > "$SERVER_DIR/eula.txt" <<'EULA'
eula=true
EULA

cat > "$SERVER_DIR/server.properties" <<'PROPERTIES'
${serverProperties}
PROPERTIES

cat > "$SERVER_DIR/ops.json" <<'OPS'
${opsJson}
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
ExecStart=$JAVA_BIN -Xms${memoryMin} -Xmx${memoryMax} -jar paper.jar nogui
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
`;
}

function renderServerProperties(props: {
  readonly difficulty: MinecraftDifficulty;
  readonly gamemode: MinecraftGameMode;
  readonly maxPlayers: number;
  readonly motd: string;
  readonly simulationDistance: number;
  readonly viewDistance: number;
}): string {
  const entries: Array<readonly [string, string | number | boolean]> = [
    ["server-port", 25565],
    ["max-players", props.maxPlayers],
    ["enable-rcon", false],
    ["enable-query", false],
    ["white-list", false],
    ["enforce-whitelist", false],
    ["motd", props.motd],
    ["difficulty", props.difficulty],
    ["gamemode", props.gamemode],
    ["level-name", "world"],
    ["view-distance", props.viewDistance],
    ["simulation-distance", props.simulationDistance],
    ["network-compression-threshold", 256],
    ["sync-chunk-writes", false],
    ["online-mode", true],
  ];

  return entries
    .map(([key, value]) => `${key}=${escapePropertyValue(String(value))}`)
    .join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderPluginInstallScript(plugins: readonly MinecraftPlugin[]): string {
  if (plugins.length === 0) {
    return "";
  }

  const pluginManifestBase64 = Buffer.from(
    JSON.stringify(plugins, null, 2),
    "utf8",
  ).toString("base64");

  return `log "Installing Minecraft plugins"
PLUGINS_DIR="$SERVER_DIR/plugins"
PLUGIN_MANIFEST="$SERVER_DIR/buildercraft-plugins.json"
install -d -o minecraft -g minecraft "$PLUGINS_DIR"
printf %s ${shellQuote(pluginManifestBase64)} | base64 -d > "$PLUGIN_MANIFEST"

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

  if [ "$source" = "modrinth" ]; then
    local encoded_project versions_response version_json file_json modrinth_sha512

    project="$(printf '%s' "$plugin_json" | jq -r '.project')"
    requested_version="$(printf '%s' "$plugin_json" | jq -r '.version // empty')"
    loaders_json="$(printf '%s' "$plugin_json" | jq -c '.loaders // []')"
    game_versions_json="$(printf '%s' "$plugin_json" | jq -c '.gameVersions // []')"
    encoded_project="$(jq -nr --arg value "$project" '$value | @uri')"

    versions_response="$(curl -fsSL -H "User-Agent: $BUILDERCRAFT_USER_AGENT" "https://api.modrinth.com/v2/project/$encoded_project/version")"
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

  plugin_file_name="$(printf '%s' "$plugin_json" | jq -r --arg fallback "\${source_file_name:-}" '.fileName // $fallback')"
  if [ -z "$plugin_file_name" ]; then
    plugin_file_name="$(basename -- "$download_url")"
    plugin_file_name="\${plugin_file_name%%\\?*}"
    plugin_file_name="\${plugin_file_name%%#*}"
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
  curl -fsSL -H "User-Agent: $BUILDERCRAFT_USER_AGENT" -o "$tmp_file" "$download_url"

  if [ -n "$expected_sha512" ]; then
    printf '%s  %s\\n' "$expected_sha512" "$tmp_file" | sha512sum -c -
  fi
  if [ -n "$expected_sha256" ]; then
    printf '%s  %s\\n' "$expected_sha256" "$tmp_file" | sha256sum -c -
  fi

  install -o minecraft -g minecraft -m 0644 "$tmp_file" "$PLUGINS_DIR/$plugin_file_name"
  rm -f "$tmp_file"
}

while IFS= read -r plugin_json; do
  download_plugin "$plugin_json"
done < <(jq -c '.[]' "$PLUGIN_MANIFEST")
`;
}

function escapePropertyValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n");
}
