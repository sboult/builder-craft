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
PAPER_USER_AGENT=${shellQuote("buildercraft-cdk/1.0")}

log "Installing operating system packages"
dnf update -y
dnf install -y java-21-amazon-corretto-headless jq

log "Creating minecraft service user and directories"
if ! id minecraft >/dev/null 2>&1; then
  useradd --system --home "$MINECRAFT_HOME" --shell /bin/bash minecraft
fi
install -d -o minecraft -g minecraft "$SERVER_DIR"

log "Downloading pinned PaperMC build"
PAPER_JAR="$SERVER_DIR/paper.jar"
if [ ! -s "$PAPER_JAR" ]; then
  if [ -z "$PAPER_DOWNLOAD_URL" ]; then
    BUILDS_RESPONSE="$(curl -fsSL -H "User-Agent: $PAPER_USER_AGENT" "https://fill.papermc.io/v3/projects/paper/versions/$MINECRAFT_VERSION/builds")"
    PAPER_DOWNLOAD_URL="$(printf '%s' "$BUILDS_RESPONSE" | jq -r --arg build "$PAPER_BUILD" 'first(.[] | select((((.id // .number) | tostring) == $build or (.id | tostring) == $build or (.number | tostring) == $build) and .channel == "STABLE") | .downloads."server:default".url) // empty')"
  fi

  if [ -z "$PAPER_DOWNLOAD_URL" ]; then
    log "No stable PaperMC download URL found for version $MINECRAFT_VERSION build $PAPER_BUILD"
    exit 1
  fi

  curl -fsSL -H "User-Agent: $PAPER_USER_AGENT" -o "$PAPER_JAR" "$PAPER_DOWNLOAD_URL"
fi

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
ExecStart=/usr/bin/java -Xms${memoryMin} -Xmx${memoryMax} -jar paper.jar nogui
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

function escapePropertyValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n");
}
