import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { FoundationStack } from "../src/foundation.js";

const fixture = {
  PLATFORM_ACCOUNT: "111111111111",
  PLATFORM_REGION: "us-east-1",
  PLATFORM_AVAILABILITY_ZONES: "us-east-1a,us-east-1b",
  PLATFORM_ENV: "demo",
  PLATFORM_SITE_ORIGIN: "https://wander.example",
  PLATFORM_CERTIFICATE_ARN:
    "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-4000-8000-000000000000",
  PLATFORM_DEPLOY_PRINCIPAL_ARN:
    "arn:aws:iam::111111111111:role/wander-deployer",
  PLATFORM_COGNITO_DOMAIN_PREFIX: "wander-demo-example",
};

function synth(extra: Record<string, string> = {}) {
  const config = parseConfig({ ...fixture, ...extra });
  const app = new cdk.App();
  app.node.setContext(
    `availability-zones:account=${config.account}:region=${config.region}`,
    config.availabilityZones,
  );
  return Template.fromStack(new FoundationStack(app, "Foundation", config));
}

describe("foundation deployment contract", () => {
  it("validates identifiers, origins, certificate region, and explicit AZs", () => {
    expect(() => parseConfig({ ...fixture, PLATFORM_ACCOUNT: "bad" })).toThrow(
      "PLATFORM_ACCOUNT",
    );
    expect(() =>
      parseConfig({
        ...fixture,
        PLATFORM_SITE_ORIGIN: "http://wander.example",
      }),
    ).toThrow("PLATFORM_SITE_ORIGIN");
    expect(() =>
      parseConfig({
        ...fixture,
        PLATFORM_AVAILABILITY_ZONES: "us-east-1a,us-east-1a",
      }),
    ).toThrow("PLATFORM_AVAILABILITY_ZONES");
    expect(() =>
      parseConfig({ ...fixture, PLATFORM_REGION: "eu-west-1" }),
    ).toThrow("PLATFORM_AVAILABILITY_ZONES");
  });

  it("creates the private retained data resources and bounded logs", () => {
    const template = synth();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      SSESpecification: { SSEEnabled: true },
    });
    template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.anyValue(),
    });
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
    template.resourceCountIs("AWS::S3::BucketPolicy", 0);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 14,
      KmsKeyId: Match.anyValue(),
    });
  });

  it("grants only regional Logs scoped use alongside account administration", () => {
    const template = synth();
    const keys = Object.values(template.findResources("AWS::KMS::Key"));
    expect(keys).toHaveLength(1);
    expect(keys[0].Properties.EnableKeyRotation).toBe(true);
    expect(keys[0].DeletionPolicy).toBe("Retain");
    const statements = keys[0].Properties.KeyPolicy.Statement;
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatchObject({
      Action: "kms:*",
      Principal: {
        AWS: {
          "Fn::Join": [
            "",
            ["arn:", { Ref: "AWS::Partition" }, ":iam::111111111111:root"],
          ],
        },
      },
    });
    expect(statements[1]).toEqual({
      Effect: "Allow",
      Principal: { Service: "logs.us-east-1.amazonaws.com" },
      Action: [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*",
      ],
      Resource: "*",
      Condition: {
        ArnEquals: {
          "kms:EncryptionContext:aws:logs:arn":
            "arn:aws:logs:us-east-1:111111111111:log-group:/wander/demo/api",
        },
      },
    });
  });

  it("separates private REST networking and execution/task/deploy roles", () => {
    const template = synth();
    template.resourceCountIs("AWS::EC2::NatGateway", 1);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 2);
    template.hasResourceProperties(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      { Scheme: "internal" },
    );
    template.resourceCountIs("AWS::IAM::Role", 5);
    template.hasResourceProperties("AWS::ECR::Repository", {
      ImageTagMutability: "IMMUTABLE",
    });
    const ingress = Object.values(
      template.findResources("AWS::EC2::SecurityGroupIngress"),
    );
    expect(
      ingress
        .filter((rule) => rule.Properties.ToPort === 3000)
        .every((rule) => rule.Properties.SourceSecurityGroupId),
    ).toBe(true);
    expect(JSON.stringify(ingress)).not.toContain('"CidrIp"');
    const policyText = JSON.stringify(
      template.findResources("AWS::IAM::Policy"),
    );
    expect(policyText).toContain("dynamodb:");
    expect(policyText).toContain("secretsmanager:");
    // ECR issues registry tokens only account-wide; every other grant names its resources.
    const unscoped = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) => statement.Resource === "*");
    expect(unscoped.map((statement) => statement.Action)).toEqual([
      "ecr:GetAuthorizationToken",
    ]);
  });

  it("publishes versioned references and never embeds secret values", () => {
    const template = synth();
    const parameters = template.findResources("AWS::SSM::Parameter");
    expect(Object.values(parameters)).toHaveLength(25);
    expect(
      Object.values(parameters).every((item) =>
        item.Properties.Name.startsWith("/wander/demo/v1/"),
      ),
    ).toBe(true);
    expect(JSON.stringify(template.toJSON())).not.toContain(
      "SENTRY_AUTH_TOKEN",
    );
    expect(template.findResources("AWS::SecretsManager::Secret")).toEqual({});
  });

  it("trusts only the configured principal unless GitHub OIDC is selected", () => {
    const trust = (extra: Record<string, string> = {}) =>
      synth(extra).findResources("AWS::IAM::Role", {
        Properties: {
          AssumeRolePolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Principal: {
                  AWS: "arn:aws:iam::111111111111:role/wander-deployer",
                },
              }),
            ]),
          },
        },
      });
    const [plain] = Object.values(trust({ PLATFORM_GITHUB_REPOSITORY: "" }));
    expect(plain?.Properties.AssumeRolePolicyDocument.Statement).toHaveLength(
      1,
    );
    const [oidc] = Object.values(
      trust({
        PLATFORM_GITHUB_REPOSITORY: "example-owner/graph-rest-react-stack",
      }),
    );
    expect(oidc?.Properties.AssumeRolePolicyDocument.Statement[1]).toEqual({
      Effect: "Allow",
      Action: "sts:AssumeRoleWithWebIdentity",
      Principal: {
        Federated:
          "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com",
      },
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub":
            "repo:example-owner/graph-rest-react-stack:environment:demo",
        },
      },
    });
    for (const value of ["owner", "owner/repo/extra", "owner/repo:*"])
      expect(() =>
        parseConfig({ ...fixture, PLATFORM_GITHUB_REPOSITORY: value }),
      ).toThrow("PLATFORM_GITHUB_REPOSITORY");
  });

  it("scopes the deployment role to bootstrap roles and publication targets", () => {
    const template = synth();
    const [policy] = Object.entries(
      template.findResources("AWS::IAM::Policy"),
    ).filter(([id]) => id.startsWith("DeploymentRole"));
    const statements: { Action: string | string[]; Resource: unknown }[] =
      policy?.[1].Properties.PolicyDocument.Statement ?? [];
    const actions = statements.flatMap((statement) =>
      [statement.Action].flat(),
    );
    expect(actions.some((action) => action.startsWith("iam:"))).toBe(false);
    expect(actions).not.toContain("secretsmanager:GetSecretValue");
    const resources = (action: string) =>
      statements
        .filter((statement) => [statement.Action].flat().includes(action))
        .flatMap((statement) => [statement.Resource].flat());
    expect(resources("sts:AssumeRole")).toEqual(
      ["deploy", "file-publishing", "image-publishing", "lookup"].map(
        (kind) =>
          `arn:aws:iam::111111111111:role/cdk-hnb659fds-${kind}-role-111111111111-us-east-1`,
      ),
    );
    expect(resources("ssm:GetParameter")).toEqual([
      "arn:aws:ssm:us-east-1:111111111111:parameter/wander/demo/v1/*",
      "arn:aws:ssm:us-east-1:111111111111:parameter/cdk-bootstrap/hnb659fds/version",
    ]);
    expect(resources("secretsmanager:DescribeSecret")).toEqual([
      "arn:aws:secretsmanager:us-east-1:111111111111:secret:/wander/demo/v1/secrets/*",
    ]);
    expect(resources("cloudfront:CreateInvalidation")).toEqual([
      "arn:aws:cloudfront::111111111111:distribution/*",
    ]);
    const repositories = Object.keys(
      template.findResources("AWS::ECR::Repository"),
    );
    expect(resources("ecr:PutImage")).toEqual(
      repositories.map((id) => ({ "Fn::GetAtt": [id, "Arn"] })),
    );
    expect(JSON.stringify(resources("s3:PutObject"))).toContain("UiBucket");
  });
});
