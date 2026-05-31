# BuilderCraft MVP Boot Instructions

This project is set up so `npx cdk deploy` should work after local AWS prerequisites are in place. DNS is optional for the MVP.

## Prerequisites

1. Install Node.js 24 or newer.
   This app uses `node src/app.ts` directly instead of `ts-node`.

2. Install dependencies.

   ```bash
   npm install
   ```

3. Configure AWS credentials for the target account.

   ```bash
   aws sts get-caller-identity
   ```

   `cdk deploy` uses `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` from the CDK CLI environment.

4. Bootstrap CDK in the target account/region if it has not been bootstrapped.

   ```bash
   npx cdk bootstrap
   ```

5. Optional: create or confirm the Route53 public hosted zone.

   You can deploy without a domain or hosted zone. In that mode, connect with the `ElasticIp` stack output.
   When the domain is ready, set `domainName` plus either `hostedZoneDomainName` or `hostedZoneId` in `cdk.json`.

6. Confirm EC2 capacity and quotas.

   The default test instance is `t4g.small`. When `isProd` is `true`, the production default is `c7g.8xlarge`; make sure the selected region supports that instance type and that the account has enough EC2 quota.

## Local Config

Deployment defaults live in `cdk.json` under `context`:

```json
{
  "isProd": false,
  "minecraftVersion": "1.21.4",
  "paperBuild": "232",
  "maxPlayers": 150,
  "viewDistance": 6,
  "simulationDistance": 4,
  "motd": "BuilderCraft",
  "difficulty": "normal",
  "gamemode": "survival",
  "ops": [],
  "plugins": []
}
```

Leave `instanceType`, `volumeSizeGiB`, `memoryMin`, and `memoryMax` unset to use the selected profile defaults. Set `isProd` to `true` for the production profile, or override those fields directly when you need a custom shape.

The stack creates its own small public VPC by default. You do not need a default VPC in the account.

Optional override:

```json
{
  "domainName": "buildercraft.com",
  "hostedZoneDomainName": "buildercraft.com",
  "hostedZoneId": "Z0123456789EXAMPLE",
  "paperDownloadUrl": "https://fill-data.papermc.io/.../paper-1.21.4-232.jar"
}
```

For DNS, set `domainName` and exactly one of `hostedZoneDomainName` or `hostedZoneId`.
Use `paperDownloadUrl` when you want to bypass the PaperMC build lookup and pin the exact jar URL.

## Plugins

Set `plugins` in `cdk.json` to install Paper plugins during EC2 bootstrap. Plugin jars are written to `/opt/minecraft/server/plugins` before `minecraft.service` starts.

The repo currently installs AdvancedSensitiveWords and WorldEdit:

```json
{
  "plugins": [
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
}
```

For Modrinth plugins, set `source` to `modrinth`, set `project` to the project slug, and optionally set `version`, `loaders`, and `gameVersions` to pin the selected release. The bootstrap uses the file hash returned by Modrinth to verify the downloaded jar.

Direct jar URLs are also supported:

```json
{
  "name": "MyPlugin",
  "url": "https://example.com/MyPlugin.jar",
  "sha256": "..."
}
```

Use `sha256` or `sha512` with direct URLs when possible. If you change `minecraftVersion`, review pinned plugin versions too.

## Chat Moderation

AdvancedSensitiveWords is configured during bootstrap with its bundled default dictionary and a remote deny list downloaded into the server's local external deny directory:

```json
{
  "advancedSensitiveWords": {
    "enableDefaultWords": true,
    "enableOnlineWords": false,
    "onlineWordsUrl": "https://raw.githubusercontent.com/censor-text/profanity-list/refs/heads/main/list/en.txt",
    "onlineWordsEncoding": "UTF-8",
    "installOnlineWordsLocally": true,
    "chatMethod": "replace"
  }
}
```

`installOnlineWordsLocally` downloads `onlineWordsUrl` during EC2 bootstrap, normalizes whitespace-separated or newline-separated lists to one word per line, and writes `plugins/AdvancedSensitiveWords/external/deny/buildercraft-online-deny.txt`. `enableOnlineWords` is disabled because the plugin reads that local external deny file at startup instead of fetching the URL itself.

`chatMethod` can be `replace` to censor matching words or `cancel` to block the full message. Add server-specific words through `blockedWords`; each entry is written to `plugins/AdvancedSensitiveWords/external/deny/buildercraft-deny.txt`. Add false positives through `allowedWords`, which writes `plugins/AdvancedSensitiveWords/external/allow/buildercraft-allow.txt`.

## Admins / Ops

Set admins in `cdk.json` with Minecraft UUIDs:

```json
{
  "ops": [
    {
      "name": "us_east_1",
      "uuid": "278b452e-27fe-4ae8-baf0-b3381bb73e99",
      "level": 4,
      "bypassesPlayerLimit": true
    }
  ]
}
```

This writes `/opt/minecraft/server/ops.json` during bootstrap. It does not enable a whitelist; the server remains public.

## Deploy

```bash
npm run build
npx cdk deploy
```

The stack outputs:

```txt
MinecraftAddress
InstanceId
ElasticIp
SSMConnectCommand
```

When DNS is not configured, `MinecraftAddress` uses the Elastic IP.

## Verify Boot

Connect through Session Manager:

```bash
aws ssm start-session --target <instance-id>
```

Follow service logs:

```bash
sudo journalctl -u minecraft -f
```

Check cloud-init logs:

```bash
sudo tail -f /var/log/cloud-init-output.log
```

The bootstrap writes this file after starting the service:

```txt
/opt/minecraft/server/.buildercraft-ready
```

## Manual Backups And World Imports

The MVP intentionally does not automate world seeding or backups. Use Session Manager or S3 manually when needed.

Stop the server before copying a world in or out:

```bash
sudo systemctl stop minecraft
sudo tar -czf /tmp/world-backup.tar.gz -C /opt/minecraft/server world world_nether world_the_end
sudo systemctl start minecraft
```
