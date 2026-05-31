#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { MinecraftServerStack } from "./minecraft-server-stack.ts";

const app = new App();

new MinecraftServerStack(app, "BuilderCraftStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
