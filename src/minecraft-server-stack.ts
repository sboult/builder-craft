import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { MinecraftServer } from "./minecraft-server-construct.ts";

export class MinecraftServerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new MinecraftServer(this, "BuilderCraftServer", {
      domainName: contextOptionalString(this, "domainName"),
      hostedZoneDomainName: contextOptionalString(this, "hostedZoneDomainName"),
      hostedZoneId: contextOptionalString(this, "hostedZoneId"),
      isProd: isProdFromContext(this),
      allowIpv6: false,
    });
  }
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

function isProdFromContext(scope: Construct): boolean {
  const value = scope.node.tryGetContext("isProd");
  if (value === undefined || value === null || value === "") {
    return false;
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

  throw new Error('CDK context value "isProd" must be true or false');
}
