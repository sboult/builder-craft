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

Infrastructure defaults live in `cdk.json` under `context`:

```json
{
  "isProd": false
}
```

Leave `instanceType` and `volumeSizeGiB` unset to use the selected profile defaults. Set `isProd` to `true` for the production infrastructure profile, or override those fields directly when you need a custom shape.

The stack creates its own small public VPC by default. You do not need a default VPC in the account.

Optional override:

```json
{
  "domainName": "buildercraft.com",
  "hostedZoneDomainName": "buildercraft.com",
  "hostedZoneId": "Z0123456789EXAMPLE"
}
```

For DNS, set `domainName` and exactly one of `hostedZoneDomainName` or `hostedZoneId`.

## Minecraft Bootstrap

Minecraft setup lives in `src/user-data.sh`, not CDK context. Edit that shell script to change the Paper version/build, JVM memory, plugin manifest, AdvancedSensitiveWords config, word-list URL, server properties, or `ops.json`.

The bootstrap currently installs AdvancedSensitiveWords and WorldEdit from Modrinth. Plugin jars are written to `/opt/minecraft/server/plugins` before `minecraft.service` starts.

AdvancedSensitiveWords is configured with bundled default words enabled and plugin online words disabled. The script downloads the configured remote deny list, normalizes whitespace-separated or newline-separated entries to one word per line, and writes:

```txt
/opt/minecraft/server/plugins/AdvancedSensitiveWords/external/deny/buildercraft-online-deny.txt
```

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
