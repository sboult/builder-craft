import { CfnOutput, Duration } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import type {
  AdvancedSensitiveWordsConfig,
  MinecraftDifficulty,
  MinecraftGameMode,
  MinecraftOperator,
  MinecraftPlugin,
} from "./user-data.ts";
import { renderMinecraftUserData } from "./user-data.ts";

export interface MinecraftServerProps {
  readonly domainName?: string;
  readonly hostedZoneDomainName?: string;

  readonly isProd?: boolean;

  readonly minecraftVersion: string;
  readonly paperBuild: string;
  readonly paperDownloadUrl?: string;

  readonly instanceType?: ec2.InstanceType;
  readonly volumeSizeGiB?: number;

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
  readonly advancedSensitiveWords?: AdvancedSensitiveWordsConfig;

  readonly vpc?: ec2.IVpc;
  readonly hostedZoneId?: string;
  readonly allowIpv6?: boolean;
}

export class MinecraftServer extends Construct {
  public readonly instance: ec2.Instance;
  public readonly role: iam.Role;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly elasticIp: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props: MinecraftServerProps) {
    super(scope, id);

    validateProps(props);

    const profile = deploymentProfile(props.isProd ?? false);

    const vpc =
      props.vpc ??
      new ec2.Vpc(this, "MinecraftVpc", {
        ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"),
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: "public",
            subnetType: ec2.SubnetType.PUBLIC,
          },
        ],
      });

    this.securityGroup = new ec2.SecurityGroup(this, "MinecraftSecurityGroup", {
      vpc,
      allowAllOutbound: true,
      description: "Allow public Minecraft traffic; no SSH ingress",
      disableInlineRules: true,
    });
    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(25565),
      "Minecraft Java Edition",
    );
    if (props.allowIpv6) {
      this.securityGroup.addIngressRule(
        ec2.Peer.anyIpv6(),
        ec2.Port.tcp(25565),
        "Minecraft Java Edition over IPv6",
      );
    }

    this.role = new iam.Role(this, "MinecraftInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "EC2 role for Minecraft server Session Manager access",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });

    const userData = ec2.UserData.custom(
      renderMinecraftUserData({
        minecraftVersion: props.minecraftVersion,
        paperBuild: props.paperBuild,
        paperDownloadUrl: props.paperDownloadUrl,
        serverName: props.serverName,
        memoryMin: props.memoryMin ?? profile.memoryMin,
        memoryMax: props.memoryMax ?? profile.memoryMax,
        motd: props.motd,
        difficulty: props.difficulty,
        gamemode: props.gamemode,
        maxPlayers: props.maxPlayers,
        viewDistance: props.viewDistance,
        simulationDistance: props.simulationDistance,
        ops: props.ops,
        plugins: props.plugins,
        advancedSensitiveWords: props.advancedSensitiveWords,
      }),
    );

    const instanceType =
      props.instanceType ?? new ec2.InstanceType(profile.instanceType);
    if (instanceType.architecture !== ec2.InstanceArchitecture.ARM_64) {
      throw new Error(
        `MinecraftServer requires an ARM64 instance type to match the ARM64 AMI; received ${instanceType.toString()}`,
      );
    }

    this.instance = new ec2.Instance(this, "MinecraftInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role: this.role,
      securityGroup: this.securityGroup,
      associatePublicIpAddress: true,
      requireImdsv2: true,
      userData,
      userDataCausesReplacement: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(
            props.volumeSizeGiB ?? profile.volumeSizeGiB,
            {
              encrypted: true,
              volumeType: ec2.EbsDeviceVolumeType.GP3,
            },
          ),
        },
      ],
    });

    this.elasticIp = new ec2.CfnEIP(this, "ServerElasticIp", {
      domain: "vpc",
    });
    const eipAssociation = new ec2.CfnEIPAssociation(
      this,
      "ElasticIpAssociation",
      {
        allocationId: this.elasticIp.attrAllocationId,
        instanceId: this.instance.instanceId,
      },
    );

    if (props.domainName && (props.hostedZoneDomainName || props.hostedZoneId)) {
      const dnsRecord = new route53.CfnRecordSet(this, "DnsRecord", {
        name: fqdn(props.domainName),
        type: "A",
        ttl: Duration.minutes(5).toSeconds().toString(),
        resourceRecords: [this.elasticIp.ref],
        ...(props.hostedZoneId
          ? { hostedZoneId: props.hostedZoneId }
          : { hostedZoneName: fqdn(props.hostedZoneDomainName!) }),
      });
      dnsRecord.node.addDependency(eipAssociation);
    }

    new CfnOutput(this, "MinecraftAddressOutput", {
      key: "MinecraftAddress",
      value: props.domainName
        ? `${props.domainName}:25565`
        : `${this.elasticIp.ref}:25565`,
    });
    new CfnOutput(this, "InstanceIdOutput", {
      key: "InstanceId",
      value: this.instance.instanceId,
    });
    new CfnOutput(this, "ElasticIpOutput", {
      key: "ElasticIp",
      value: this.elasticIp.ref,
    });
    new CfnOutput(this, "SSMConnectCommandOutput", {
      key: "SSMConnectCommand",
      value: `aws ssm start-session --target ${this.instance.instanceId}`,
    });
  }
}

function deploymentProfile(isProd: boolean): {
  readonly instanceType: string;
  readonly memoryMin: string;
  readonly memoryMax: string;
  readonly volumeSizeGiB: number;
} {
  return isProd
    ? {
        instanceType: "c7g.8xlarge",
        memoryMin: "16G",
        memoryMax: "32G",
        volumeSizeGiB: 150,
      }
    : {
        instanceType: "t4g.small",
        memoryMin: "512M",
        memoryMax: "1G",
        volumeSizeGiB: 20,
      };
}

function validateProps(props: MinecraftServerProps): void {
  if (props.domainName !== undefined) {
    requireNonEmpty("domainName", props.domainName);
  }
  if (props.hostedZoneDomainName !== undefined) {
    requireNonEmpty("hostedZoneDomainName", props.hostedZoneDomainName);
  }
  if (
    props.hostedZoneId !== undefined &&
    props.hostedZoneDomainName !== undefined
  ) {
    throw new Error("Use either hostedZoneId or hostedZoneDomainName, not both");
  }
  if (!props.domainName && (props.hostedZoneDomainName || props.hostedZoneId)) {
    throw new Error("domainName is required when configuring Route53 DNS");
  }
  requireNonEmpty("minecraftVersion", props.minecraftVersion);
  requireNonEmpty("paperBuild", props.paperBuild);

  for (const operator of props.ops ?? []) {
    requireNonEmpty("ops.name", operator.name);
    requireNonEmpty("ops.uuid", operator.uuid);
  }

  for (const plugin of props.plugins ?? []) {
    validatePlugin(plugin);
  }
  if (props.advancedSensitiveWords !== undefined) {
    validateAdvancedSensitiveWords(props.advancedSensitiveWords);
  }
}

function validateAdvancedSensitiveWords(
  config: AdvancedSensitiveWordsConfig,
): void {
  if (config.onlineWordsUrl !== undefined) {
    requireNonEmpty(
      "advancedSensitiveWords.onlineWordsUrl",
      config.onlineWordsUrl,
    );
  }
  if (config.onlineWordsEncoding !== undefined) {
    requireNonEmpty(
      "advancedSensitiveWords.onlineWordsEncoding",
      config.onlineWordsEncoding,
    );
  }
  if (
    config.chatMethod !== undefined &&
    config.chatMethod !== "replace" &&
    config.chatMethod !== "cancel"
  ) {
    throw new Error(
      'advancedSensitiveWords.chatMethod must be "replace" or "cancel"',
    );
  }

  for (const blockedWord of config.blockedWords ?? []) {
    validateWordListEntry("advancedSensitiveWords.blockedWords", blockedWord);
  }
  for (const allowedWord of config.allowedWords ?? []) {
    validateWordListEntry("advancedSensitiveWords.allowedWords", allowedWord);
  }
}

function validateWordListEntry(fieldName: string, value: string): void {
  requireNonEmpty(fieldName, value);
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${fieldName} entries must be single-line strings`);
  }
}

function validatePlugin(plugin: MinecraftPlugin): void {
  requireNonEmpty("plugins.name", plugin.name);

  if (plugin.fileName !== undefined) {
    requireNonEmpty("plugins.fileName", plugin.fileName);
  }
  if (plugin.sha256 !== undefined) {
    requireNonEmpty("plugins.sha256", plugin.sha256);
  }
  if (plugin.sha512 !== undefined) {
    requireNonEmpty("plugins.sha512", plugin.sha512);
  }

  if (plugin.url !== undefined && plugin.source !== undefined) {
    throw new Error("Use either plugins.url or plugins.source, not both");
  }
  if (plugin.url !== undefined) {
    requireNonEmpty("plugins.url", plugin.url);
    return;
  }

  if (plugin.source !== "modrinth") {
    throw new Error('plugins.source must be "modrinth" when url is not set');
  }
  if (plugin.project === undefined) {
    throw new Error("plugins.project is required for Modrinth plugins");
  }
  requireNonEmpty("plugins.project", plugin.project);

  if (plugin.version !== undefined) {
    requireNonEmpty("plugins.version", plugin.version);
  }
  for (const loader of plugin.loaders ?? []) {
    requireNonEmpty("plugins.loaders", loader);
  }
  for (const gameVersion of plugin.gameVersions ?? []) {
    requireNonEmpty("plugins.gameVersions", gameVersion);
  }
}

function requireNonEmpty(fieldName: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must not be empty`);
  }
}

function fqdn(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}
