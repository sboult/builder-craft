import { CfnOutput, Duration } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import type {
  MinecraftDifficulty,
  MinecraftGameMode,
  MinecraftOperator,
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
      }),
    );

    this.instance = new ec2.Instance(this, "MinecraftInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType:
        props.instanceType ?? new ec2.InstanceType(profile.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
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
        instanceType: "c7i.8xlarge",
        memoryMin: "16G",
        memoryMax: "32G",
        volumeSizeGiB: 150,
      }
    : {
        instanceType: "t3.small",
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
}

function requireNonEmpty(fieldName: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must not be empty`);
  }
}

function fqdn(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}
