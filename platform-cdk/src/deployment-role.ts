import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { bootstrapQualifier, type PlatformConfig } from "./config.js";

interface DeploymentTargets {
  repositories: ecr.IRepository[];
  uiBucket: s3.IBucket;
}

/**
 * The identity deploy-all.sh runs as. CloudFormation changes go through the CDK bootstrap roles,
 * so this role passes no role itself; it only publishes images and the static export.
 */
export function createDeploymentRole(
  scope: Construct,
  config: PlatformConfig,
  targets: DeploymentTargets,
) {
  const { account, region, environment } = config;
  const role = new iam.Role(scope, "DeploymentRole", {
    assumedBy: new iam.ArnPrincipal(config.deployPrincipalArn),
  });
  if (config.githubRepository)
    role.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRoleWithWebIdentity"],
        principals: [
          new iam.FederatedPrincipal(
            `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`,
          ),
        ],
        conditions: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": `repo:${config.githubRepository}:environment:${environment}`,
          },
        },
      }),
    );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [
        "deploy",
        "file-publishing",
        "image-publishing",
        "lookup",
      ].map(
        (kind) =>
          `arn:aws:iam::${account}:role/cdk-${bootstrapQualifier}-${kind}-role-${account}-${region}`,
      ),
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [
        `arn:aws:ssm:${region}:${account}:parameter/wander/${environment}/v1/*`,
        `arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/${bootstrapQualifier}/version`,
      ],
    }),
  );
  // Preflight confirms selected secrets exist; reading their values stays with ECS execution roles.
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["secretsmanager:DescribeSecret"],
      resources: [
        `arn:aws:secretsmanager:${region}:${account}:secret:/wander/${environment}/v1/secrets/*`,
      ],
    }),
  );
  for (const repository of targets.repositories) {
    repository.grantPullPush(role);
    repository.grant(role, "ecr:DescribeImages");
  }
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [targets.uiBucket.bucketArn],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [targets.uiBucket.arnForObjects("*")],
    }),
  );
  // The distribution belongs to the UI stack, deployed later; scope to this account's distributions.
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
      resources: [`arn:aws:cloudfront::${account}:distribution/*`],
    }),
  );
  return role;
}
