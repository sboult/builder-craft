import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import type { MinecraftServerProps } from "./minecraft-server-construct.ts";
import type { MinecraftOperator } from "./user-data.ts";
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
    minecraftVersion: contextString(scope, "minecraftVersion", "1.21.4"),
    paperBuild: contextString(scope, "paperBuild", "232"),
    paperDownloadUrl: contextOptionalString(scope, "paperDownloadUrl"),
    instanceType: instanceTypeName
      ? new ec2.InstanceType(instanceTypeName)
      : undefined,
    volumeSizeGiB: contextOptionalNumber(scope, "volumeSizeGiB"),
    serverName: contextOptionalString(scope, "serverName"),
    memoryMin: contextOptionalString(scope, "memoryMin"),
    memoryMax: contextOptionalString(scope, "memoryMax"),
    motd: contextString(scope, "motd", "BuilderCraft"),
    difficulty: contextOneOf(
      scope,
      "difficulty",
      ["peaceful", "easy", "normal", "hard"] as const,
      "normal",
    ),
    gamemode: contextOneOf(
      scope,
      "gamemode",
      ["survival", "creative", "adventure", "spectator"] as const,
      "survival",
    ),
    maxPlayers: contextNumber(scope, "maxPlayers", 150),
    viewDistance: contextNumber(scope, "viewDistance", 6),
    simulationDistance: contextNumber(scope, "simulationDistance", 4),
    ops: contextOperators(scope, "ops"),
    allowIpv6: contextOptionalBoolean(scope, "allowIpv6"),
  };
}

function contextString(
  scope: Construct,
  key: string,
  defaultValue: string,
): string {
  return contextOptionalString(scope, key) ?? defaultValue;
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

function contextNumber(
  scope: Construct,
  key: string,
  defaultValue: number,
): number {
  const value = scope.node.tryGetContext(key);
  if (value === undefined || value === null || value === "") {
    return defaultValue;
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

function contextOneOf<T extends string>(
  scope: Construct,
  key: string,
  allowedValues: readonly T[],
  defaultValue: T,
): T {
  const value = contextString(scope, key, defaultValue);
  if (!allowedValues.includes(value as T)) {
    throw new Error(
      `CDK context value "${key}" must be one of: ${allowedValues.join(", ")}`,
    );
  }

  return value as T;
}

function contextOperators(
  scope: Construct,
  key: string,
): readonly MinecraftOperator[] {
  const rawValue = scope.node.tryGetContext(key);
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return [];
  }

  const parsed =
    typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
  if (!Array.isArray(parsed)) {
    throw new Error(`CDK context value "${key}" must be a JSON array`);
  }

  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`CDK context value "${key}[${index}]" must be an object`);
    }
    if (typeof entry.name !== "string" || typeof entry.uuid !== "string") {
      throw new Error(
        `CDK context value "${key}[${index}]" must include name and uuid strings`,
      );
    }

    return {
      name: entry.name,
      uuid: entry.uuid,
      level: optionalNumber(entry.level, `${key}[${index}].level`),
      bypassesPlayerLimit: optionalBoolean(
        entry.bypassesPlayerLimit,
        `${key}[${index}].bypassesPlayerLimit`,
      ),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new Error(`${fieldName} must be a number when provided`);
  }

  return value;
}

function optionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean when provided`);
  }

  return value;
}
