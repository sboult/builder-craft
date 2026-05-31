# BuilderCraft

AWS CDK v2 TypeScript app for a public PaperMC Minecraft server on EC2.

Current MVP behavior:

* Fresh Paper world on first boot.
* Public server, no whitelist.
* Optional UUID-based admins through `ops` in `cdk.json`.
* Dedicated public VPC created by the stack; no default VPC required.
* No SSH key or port 22 ingress.
* Admin shell access through AWS Systems Manager Session Manager.
* Optional Route53 `A` record backed by an Elastic IP when DNS config is set.
* Configurable plugin install list downloaded during instance bootstrap.
* Defaults to a small Graviton test profile: `t4g.small`, 20 GiB gp3 root volume, `-Xms512M`, `-Xmx1G`.
* Set `isProd` to `true` for the larger Graviton production profile: `c7g.8xlarge`, 150 GiB gp3 root volume, `-Xms16G`, `-Xmx32G`.

Read [INSTRUCTIONS.md](./INSTRUCTIONS.md) before deploying.

## Commands

```bash
npm run build
npx cdk diff
npx cdk deploy
```

After deploy:

```bash
aws ssm start-session --target <instance-id>
sudo journalctl -u minecraft -f
```
