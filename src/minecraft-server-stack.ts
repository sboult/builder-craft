import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import type { MinecraftServerProps } from "./minecraft-server-construct.ts";
import { MinecraftServer } from "./minecraft-server-construct.ts";

export interface MinecraftServerStackProps extends cdk.StackProps {
  readonly serverConfig?: MinecraftServerProps;
}

export class MinecraftServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MinecraftServerStackProps = {}) {
    super(scope, id, props);

    new MinecraftServer(
      this,
      "BuilderCraftServer",
      props.serverConfig ?? configFromContext(this),
    );
  }
}

function configFromContext(scope: Construct): MinecraftServerProps {
  const domainName = contextOptionalString(scope, "domainName");
  const isProd = contextOptionalBoolean(scope, "isProd") ?? false;
  const instanceTypeName = contextOptionalString(scope, "instanceType");

  return {
    domainName,
    hostedZoneDomainName: contextOptionalString(scope, "hostedZoneDomainName"),
    hostedZoneId: contextOptionalString(scope, "hostedZoneId"),
    isProd,
    instanceType: instanceTypeName
      ? new ec2.InstanceType(instanceTypeName)
      : undefined,
    volumeSizeGiB: contextOptionalNumber(scope, "volumeSizeGiB"),
    allowIpv6: contextOptionalBoolean(scope, "allowIpv6"),
  };
}

function contextOptionalString(scope: Construct, key: string): string | undefined {
  const value = scope.node.tryGetContext(key);
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`CDK context value "${key}" must be a string`);
  }

  return value;
}

function contextOptionalNumber(
  scope: Construct,
  key: string,
): number | undefined {
  const value = scope.node.tryGetContext(key);
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`CDK context value "${key}" must be a number`);
  }

  return parsed;
}

function contextOptionalBoolean(
  scope: Construct,
  key: string,
): boolean | undefined {
  const value = scope.node.tryGetContext(key);
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`CDK context value "${key}" must be true or false`);
}
