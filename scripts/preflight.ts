import { execFileSync, spawnSync } from "node:child_process";
import {
  bootstrapQualifier,
  type PlatformConfig,
} from "../platform-cdk/src/config.js";

/**
 * Read-only AWS checks that run before anything is deployed or published. A dry run prints them;
 * an execution runs them and stops at the first failure. Secret values are never read.
 */
export function preflight(
  platform: PlatformConfig,
  secretNames: string[],
  execute: boolean,
  print: (line: string) => void,
) {
  const aws = (args: string[], failure: string) => {
    const command = ["aws", ...args, "--region", platform.region];
    print(command.join(" "));
    if (!execute) return "";
    try {
      return execFileSync(command[0], command.slice(1), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      throw new Error(`Preflight failed: ${failure}`);
    }
  };
  print(
    "# preflight: tools, caller account, CDK bootstrap, selected secret names",
  );
  if (execute)
    for (const [command, args] of [
      ["aws", ["--version"]],
      ["docker", ["info"]],
    ] as const) {
      const result = spawnSync(command, [...args], { stdio: "ignore" });
      if (result.error || result.status !== 0)
        throw new Error(`Required deployment tool unavailable: ${command}`);
    }
  const caller = aws(
    ["sts", "get-caller-identity", "--output", "json"],
    "no usable AWS credentials; sign in or assume the deployment role",
  );
  if (execute) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(caller);
    } catch {
      parsed = null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("Account" in parsed) ||
      !("Arn" in parsed) ||
      typeof parsed.Arn !== "string"
    )
      throw new Error("Preflight failed: unreadable caller identity");
    if (parsed.Account !== platform.account)
      throw new Error(
        "Preflight failed: AWS credentials are for a different account than PLATFORM_ACCOUNT",
      );
    print(`# preflight: caller ${parsed.Arn}`);
  }
  aws(
    [
      "ssm",
      "get-parameter",
      "--name",
      `/cdk-bootstrap/${bootstrapQualifier}/version`,
      "--query",
      "Parameter.Value",
      "--output",
      "text",
    ],
    "CDK bootstrap not found in this account/region; run cdk bootstrap first",
  );
  for (const name of secretNames)
    aws(
      [
        "secretsmanager",
        "describe-secret",
        "--secret-id",
        name,
        "--query",
        "Name",
        "--output",
        "text",
      ],
      `selected secret ${name} is missing or not describable`,
    );
}
