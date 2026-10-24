import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveStatic } from "./archive-static.ts";
const fixture = {
  PLATFORM_ACCOUNT: "111111111111",
  PLATFORM_REGION: "us-east-1",
  PLATFORM_ENV: "demo",
  PLATFORM_AVAILABILITY_ZONES: "us-east-1a,us-east-1b",
  PLATFORM_SITE_ORIGIN: "https://wander.example",
  PLATFORM_CERTIFICATE_ARN:
    "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-4000-8000-000000000000",
  PLATFORM_DEPLOY_PRINCIPAL_ARN:
    "arn:aws:iam::111111111111:role/wander-deployer",
  PLATFORM_COGNITO_DOMAIN_PREFIX: "wander-demo-example",
  UI_CERTIFICATE_ARN:
    "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-4000-8000-000000000000",
  DEPLOY_GRAPH_ORIGIN: "https://api.wander.example",
  API_LLM_PROVIDER: "mock",
  API_EVENTS_PROVIDER: "mock",
  OPENAI_API_KEY: "PRIVATE_DEPLOY_SENTINEL",
  AWS_REGION: "",
  AWS_DEFAULT_REGION: "",
};
const run = (args = ["demo"], extra = {}) =>
  spawnSync("bash", ["scripts/deploy-all.sh", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...fixture, ...extra },
  });
// Fake AWS and Docker CLIs that log every call and answer only read-only preflight queries.
const withFakeCli = (check) => {
  const bin = mkdtempSync(join(tmpdir(), "wander-cli-"));
  const log = join(bin, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "aws"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "--version "*) exit 0 ;;
  "sts get-caller-identity")
    printf '{"Account":"%s","Arn":"arn:aws:sts::%s:assumed-role/deployer/test"}\\n' "$FAKE_ACCOUNT" "$FAKE_ACCOUNT"
    exit 0 ;;
  "ssm get-parameter") [ "$FAKE_BOOTSTRAP" = missing ] && exit 254; echo 21; exit 0 ;;
  "secretsmanager describe-secret") [ "$FAKE_SECRET" = missing ] && exit 254; echo found; exit 0 ;;
esac
exit 99
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    return check((args, extra = {}) => {
      const result = run(args, {
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_LOG: log,
        FAKE_ACCOUNT: "111111111111",
        ...extra,
      });
      return { ...result, calls: readFileSync(log, "utf8") };
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
};
test("defaults to a safe ordered plan with pinned images and built public config", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN/);
  const steps = [
    "WanderdemoFoundation",
    "docker' 'build",
    "WanderdemoRest",
    "WanderdemoGraph",
    "scripts/build-static.mjs",
    "WanderdemoUi",
    "scripts/publish-static.mjs",
  ];
  let index = -1;
  for (const step of steps) {
    const next = result.stdout.indexOf(step, index + 1);
    assert.ok(next > index, step);
    index = next;
  }
  assert.match(
    result.stdout,
    /REST=[a-f0-9]{40} graph=[a-f0-9]{40} UI=[a-f0-9]{40}/,
  );
  assert.match(result.stdout, /NEXT_PUBLIC_APP_MODE='live'/);
  assert.match(result.stdout, /auth\/callback\//);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /PRIVATE_DEPLOY_SENTINEL|:latest|GetSecretValue/,
  );
});
test("plans the shipped blank-model example without enabling a vendor", () => {
  const example = Object.fromEntries(
    readFileSync("scripts/deployment.env.example", "utf8")
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  assert.equal(example.API_LLM_MODEL, "");
  const result = run(["demo", "--dry-run"], example);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WanderdemoGraph/);
  assert.doesNotMatch(result.stdout, /describe-secret|PRIVATE_DEPLOY_SENTINEL/);
  for (const provider of ["openai", "anthropic"]) {
    const invalid = run(["demo"], { ...example, API_LLM_PROVIDER: provider });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /API_LLM_MODEL/);
    assert.equal(invalid.stdout, "");
  }
});
test("prints a reviewable summary and passes the site origin to the UI build", () => {
  const result = run(["demo"], {
    API_LLM_PROVIDER: "anthropic",
    API_LLM_MODEL: "example-model",
    API_EVENTS_PROVIDER: "ticketmaster",
    API_WEATHER_PROVIDER: "wttr",
    API_PLACES_PROVIDER: "overpass",
    ANTHROPIC_API_KEY: "PRIVATE_DEPLOY_SENTINEL",
  });
  assert.equal(result.status, 0, result.stderr);
  for (const line of [
    "# configuration summary (selections and names only, no secret values)",
    "#   environment=demo account=111111111111 region=us-east-1",
    "#   site=https://wander.example graph=https://api.wander.example",
    "#   providers weather=wttr places=overpass events=ticketmaster llm=anthropic model=example-model",
    "#   secrets required=/wander/demo/v1/secrets/anthropic,/wander/demo/v1/secrets/ticketmaster",
    "#   fixed in this release path: telemetry=off sentry=off",
  ])
    assert.ok(result.stdout.includes(line), line);
  assert.ok(
    result.stdout.indexOf("# configuration summary") <
      result.stdout.indexOf("WanderdemoFoundation"),
    "summary precedes the first command",
  );
  assert.match(result.stdout, /UI_SITE_ORIGIN='https:\/\/wander\.example'/);
  const defaults = run().stdout;
  assert.match(defaults, /secrets required=none/);
  assert.match(
    defaults,
    /providers weather=mock places=mock events=mock llm=mock model=none/,
  );
  // Weather and places need no secret, so selecting them alone checks none.
  const open = run(["demo"], {
    API_WEATHER_PROVIDER: "wttr",
    API_PLACES_PROVIDER: "overpass",
  });
  assert.equal(open.status, 0, open.stderr);
  assert.match(open.stdout, /secrets required=none/);
  assert.doesNotMatch(open.stdout, /describe-secret/);
  for (const [extra, key] of [
    [
      { API_WEATHER_PROVIDER: "PRIVATE_DEPLOY_SENTINEL" },
      "API_WEATHER_PROVIDER",
    ],
    [{ API_PLACES_PROVIDER: "wttr" }, "API_PLACES_PROVIDER"],
  ]) {
    const invalid = run(["demo"], extra);
    assert.notEqual(invalid.status, 0);
    assert.ok(invalid.stderr.includes(key), key);
    assert.equal(invalid.stdout, "");
    assert.doesNotMatch(invalid.stderr, /PRIVATE_DEPLOY_SENTINEL/);
  }
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_DEPLOY_SENTINEL/);
});
test("rejects conflicting or malformed origins without echoing values", () => {
  for (const [extra, key] of [
    [{ DEPLOY_GRAPH_ORIGIN: "https://wander.example" }, "Conflicting origins"],
    [
      { DEPLOY_GRAPH_ORIGIN: "https://api.wander.example/graphql" },
      "DEPLOY_GRAPH_ORIGIN",
    ],
    [
      { DEPLOY_GRAPH_ORIGIN: "not a url PRIVATE_DEPLOY_SENTINEL" },
      "DEPLOY_GRAPH_ORIGIN",
    ],
    [
      {
        PLATFORM_SITE_ORIGIN:
          "https://user:PRIVATE_DEPLOY_SENTINEL@wander.example",
      },
      "PLATFORM_SITE_ORIGIN",
    ],
  ]) {
    const result = run(["demo"], extra);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(key), key);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(
      result.stderr,
      /PRIVATE_DEPLOY_SENTINEL|api\.wander\.example/,
    );
  }
});
test("validates required inputs and flags before any deployment", () => {
  for (const result of [
    run(["demo", "--yes"]),
    run(["other"]),
    run(["demo"], { UI_CERTIFICATE_ARN: "" }),
    run(["demo"], { DEPLOY_GRAPH_ORIGIN: "http://api.wander.example" }),
  ]) {
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /WanderdemoFoundation/);
  }
});
test("prints only selected secret names for the explicit provider path", () => {
  const result = run(["demo", "--dry-run"], {
    API_LLM_PROVIDER: "openai",
    API_LLM_MODEL: "example-model",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /describe-secret/);
  assert.match(result.stdout, /secrets\/openai/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /PRIVATE_DEPLOY_SENTINEL|secrets\/anthropic/,
  );
});
test("dry run lists preflight queries without calling AWS", () =>
  withFakeCli((fake) => {
    const result = fake(["demo"], {
      API_LLM_PROVIDER: "openai",
      API_LLM_MODEL: "example-model",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, "");
    const order = [
      "# configuration summary",
      "aws sts get-caller-identity",
      "/cdk-bootstrap/hnb659fds/version",
      "describe-secret --secret-id /wander/demo/v1/secrets/openai",
      "WanderdemoFoundation",
    ].map((text) => result.stdout.indexOf(text));
    assert.ok(
      order.every((index, i) => index > (order[i - 1] ?? -1)),
      order,
    );
  }));
test("execution stops at preflight before any deployment or publication", () =>
  withFakeCli((fake) => {
    const selected = {
      API_LLM_PROVIDER: "anthropic",
      API_LLM_MODEL: "example-model",
    };
    for (const [extra, message] of [
      [
        { FAKE_ACCOUNT: "222222222222" },
        /different account than PLATFORM_ACCOUNT/,
      ],
      [{ FAKE_BOOTSTRAP: "missing" }, /CDK bootstrap not found/],
      [
        { FAKE_SECRET: "missing" },
        /secret \/wander\/demo\/v1\/secrets\/anthropic is missing/,
      ],
    ]) {
      const result = fake(["demo", "--execute"], { ...selected, ...extra });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stdout, /cdk' '--app|docker' 'build/);
      for (const call of result.calls.trim().split("\n"))
        assert.match(
          call,
          /^(--version|sts get-caller-identity|ssm get-parameter --name \/cdk-bootstrap\/|secretsmanager describe-secret)/,
        );
      assert.doesNotMatch(
        result.stdout + result.stderr + result.calls,
        /get-secret-value|PRIVATE_DEPLOY_SENTINEL/,
      );
    }
  }));
test("rejects an AWS region that differs from PLATFORM_REGION", () => {
  for (const key of ["AWS_REGION", "AWS_DEFAULT_REGION"]) {
    const result = run(["demo"], { [key]: "eu-west-1" });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`${key} must match PLATFORM_REGION`),
    );
    assert.equal(result.stdout, "");
  }
});

test("archives changed public auth identity separately and preserves existing exports", () => {
  const root = mkdtempSync(join(tmpdir(), "wander-archive-"));
  const source = join(root, "out");
  mkdirSync(source);
  const revision = "1111111111111111111111111111111111111111";
  const manifest = (clientId) =>
    JSON.stringify({ revision, publicConfig: { cognito: { clientId } } });
  try {
    writeFileSync(join(source, "deployment.json"), manifest("first-client"));
    writeFileSync(join(source, "index.html"), "first export");
    const first = archiveStatic(source, join(root, "archive"), revision);
    writeFileSync(join(source, "index.html"), "rebuilt export");
    assert.equal(archiveStatic(source, join(root, "archive"), revision), first);
    assert.equal(
      readFileSync(join(first, "index.html"), "utf8"),
      "first export",
    );
    writeFileSync(join(source, "deployment.json"), manifest("second-client"));
    const second = archiveStatic(source, join(root, "archive"), revision);
    assert.notEqual(second, first);
    assert.equal(
      readFileSync(join(second, "index.html"), "utf8"),
      "rebuilt export",
    );
    assert.throws(
      () => archiveStatic(source, join(root, "archive"), "wrong-revision"),
      /manifest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
