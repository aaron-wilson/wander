import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { archiveStatic } from "./archive-static.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { deploymentSummary, resolveDeployment } from "./deployment-config.js";
import { preflight } from "./preflight.js";

const print = (line: string) => process.stdout.write(line + "\n");
const root = fileURLToPath(new URL("..", import.meta.url));
const target = process.argv[2];
const execute = process.argv[3] === "--execute";
if (
  !target ||
  (process.env.PLATFORM_ENV && process.env.PLATFORM_ENV !== target)
)
  throw new Error("Environment argument must match PLATFORM_ENV");
const input: Record<string, string | undefined> = {
  ...process.env,
  PLATFORM_ENV: target,
};
const repos = {
  rest: resolve(root, "../rest-api"),
  graph: resolve(root, "../graph-api"),
  ui: resolve(root, "../react-ui"),
};
const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const revisions = {
  rest: git(repos.rest, ["rev-parse", "HEAD"]),
  graph: git(repos.graph, ["rev-parse", "HEAD"]),
  ui: git(repos.ui, ["rev-parse", "HEAD"]),
};
const deployment = resolveDeployment(input, revisions.graph);
const { platform, graphOrigin } = deployment;
const prefix = `/wander/${target}/v1`;
print(
  `# ${execute ? "EXECUTE" : "DRY RUN"}: ${target}; foundation, REST, graph, static UI; no secret values printed`,
);
print(
  `# immutable revisions REST=${revisions.rest} graph=${revisions.graph} UI=${revisions.ui}`,
);
for (const line of deploymentSummary(deployment)) print(`# ${line}`);
// Before the checkout checks too, so a wrong account fails first whatever the working tree holds.
preflight(
  platform,
  deployment.secrets.map((vendor) => `${prefix}/secrets/${vendor}`),
  execute,
  print,
);
for (const dir of Object.values(repos))
  if (git(dir, ["status", "--porcelain"]))
    throw new Error(
      "Service/UI checkout must be clean before planning deployment",
    );
if (execute && git(root, ["status", "--porcelain"]))
  throw new Error("Hub checkout must be clean before execution");
const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
const run = (
  dir: string,
  command: string,
  args: string[],
  env: Record<string, string> = {},
) => {
  print(
    `(cd ${quote(dir)} && ${Object.entries(env)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(" ")} ${[command, ...args].map(quote).join(" ")})`,
  );
  if (execute) {
    const result = spawnSync(command, args, {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    if (result.error || result.status !== 0)
      throw new Error(`Deployment command failed: ${command}`, {
        cause: result.error,
      });
  }
};
const parameter = (key: string) => {
  const name = `${prefix}/${key}`;
  const args = [
    "ssm",
    "get-parameter",
    "--region",
    platform.region,
    "--name",
    name,
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ];
  if (!execute) {
    print(`# resolve non-secret SSM parameter ${name} during execution`);
    return `<SSM:${name}>`;
  }
  return execFileSync("aws", args, { encoding: "utf8" }).trim();
};
const deploymentDir = resolve(root, ".deployment", target);
if (execute) mkdirSync(deploymentDir, { recursive: true });
const cli = resolve(root, "platform-cdk/node_modules/.bin/cdk");
const loader = resolve(root, "platform-cdk/node_modules/tsx/dist/loader.mjs");
const deploy = (
  dir: string,
  stack: string,
  tsconfig: string,
  app: string,
  extra: Record<string, string> = {},
) =>
  run(
    dir,
    cli,
    [
      "--app",
      `node --import ${quote(loader)} ${quote(app)}`,
      "deploy",
      stack,
      "--require-approval",
      "never",
      "--outputs-file",
      resolve(deploymentDir, `${stack}.json`),
    ],
    {
      PLATFORM_ENV: target,
      CDK_OUTDIR: "cdk.out",
      TSX_TSCONFIG_PATH: tsconfig,
      ...extra,
    },
  );
deploy(
  resolve(root, "platform-cdk"),
  `Wander${target}Foundation`,
  "tsconfig.json",
  "src/app.ts",
);
const registry = `${platform.account}.dkr.ecr.${platform.region}.amazonaws.com`;
print(
  `aws ecr get-login-password --region ${quote(platform.region)} | docker login --username AWS --password-stdin ${quote(registry)}`,
);
if (execute) {
  const password = execFileSync("aws", [
    "ecr",
    "get-login-password",
    "--region",
    platform.region,
  ]);
  const login = spawnSync(
    "docker",
    ["login", "--username", "AWS", "--password-stdin", registry],
    { input: password, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (login.error || login.status !== 0) throw new Error("ECR login failed");
}
for (const name of ["rest", "graph"] as const) {
  const repository = parameter(`images/${name}-repository-uri`);
  const image = `${repository}:${revisions[name]}`;
  let exists = false;
  print(
    `# reuse ${name}'s immutable tag if already published; otherwise build/push`,
  );
  if (execute) {
    try {
      execFileSync(
        "aws",
        [
          "ecr",
          "describe-images",
          "--region",
          platform.region,
          "--repository-name",
          `wander-${target}-${name}`,
          "--image-ids",
          `imageTag=${revisions[name]}`,
          "--query",
          "imageDetails[0].imageDigest",
          "--output",
          "text",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      exists = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("stderr" in error) ||
        !String(error.stderr).includes("ImageNotFoundException")
      )
        throw new Error("Cannot verify immutable image tag", { cause: error });
    }
  }
  if (!exists) {
    run(repos[name], "docker", [
      "build",
      "--platform",
      "linux/amd64",
      "-t",
      image,
      ".",
    ]);
    run(repos[name], "docker", ["push", image]);
  }
  deploy(
    repos[name],
    `Wander${target}${name === "rest" ? "Rest" : "Graph"}`,
    "infra/tsconfig.json",
    "infra/app.ts",
    { API_IMAGE_TAG: revisions[name] },
  );
}
const client = parameter("auth/browser-client-id");
const pool = parameter("auth/user-pool-id");
const domain = parameter("auth/hosted-domain");
run(repos.ui, "node", ["scripts/build-static.mjs"], {
  UI_ASSET_REVISION: revisions.ui,
  UI_SITE_ORIGIN: platform.siteOrigin,
  NEXT_PUBLIC_APP_MODE: "live",
  NEXT_PUBLIC_GRAPHQL_URL: `${graphOrigin}/graphql`,
  NEXT_PUBLIC_COGNITO_DOMAIN: `https://${domain}`,
  NEXT_PUBLIC_COGNITO_CLIENT_ID: client,
  NEXT_PUBLIC_COGNITO_ISSUER: `https://cognito-idp.${platform.region}.amazonaws.com/${pool}`,
  NEXT_PUBLIC_AUTH_REDIRECT_URI: `${platform.siteOrigin}/auth/callback/`,
  NEXT_PUBLIC_SENTRY_DSN: "",
  SENTRY_SOURCE_MAPS: "false",
});
let artifact = `<archive:${revisions.ui}-public-config-hash>`;
if (execute) {
  artifact = archiveStatic(
    resolve(repos.ui, "out"),
    resolve(deploymentDir, "ui"),
    revisions.ui,
  );
}
print(`# preserve immutable UI export at ${artifact}`);
deploy(repos.ui, `Wander${target}Ui`, "infra/tsconfig.json", "infra/app.ts");
run(repos.ui, "node", ["scripts/publish-static.mjs", "--execute"], {
  UI_ASSET_REVISION: revisions.ui,
  UI_BUCKET_NAME: parameter("ui/bucket-name"),
  UI_DISTRIBUTION_ID: parameter("ui/distribution-id"),
  STATIC_ARTIFACT_DIR: artifact,
});
