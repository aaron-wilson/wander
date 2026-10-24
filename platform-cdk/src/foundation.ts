import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as logs from "aws-cdk-lib/aws-logs";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import type { PlatformConfig } from "./config.js";
import { createDeploymentRole } from "./deployment-role.js";

export class FoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, config: PlatformConfig) {
    super(scope, id, {
      env: { account: config.account, region: config.region },
      description: "Wander shared foundation",
    });
    const path = `/wander/${config.environment}/v1`;
    const parameter = (name: string, value: string) =>
      new ssm.StringParameter(
        this,
        `Parameter${name.replace(/[^A-Za-z0-9]/g, "")}`,
        {
          parameterName: `${path}/${name}`,
          stringValue: value,
          tier: ssm.ParameterTier.STANDARD,
        },
      );

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `wander-${config.environment}`,
    });
    const graphAlb = new elbv2.ApplicationLoadBalancer(this, "GraphAlb", {
      vpc,
      internetFacing: true,
    });
    const graphListener = graphAlb.addListener("Https", {
      port: 443,
      certificates: [elbv2.ListenerCertificate.fromArn(config.certificateArn)],
      defaultAction: elbv2.ListenerAction.fixedResponse(404),
    });
    graphAlb.addListener("HttpRedirect", {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
      }),
    });
    const restAlb = new elbv2.ApplicationLoadBalancer(this, "RestAlb", {
      vpc,
      internetFacing: false,
    });
    const restListener = restAlb.addListener("RestHttp", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404),
    });
    const restTasks = new ec2.SecurityGroup(this, "RestTasks", { vpc });
    const graphTasks = new ec2.SecurityGroup(this, "GraphTasks", { vpc });
    restTasks.connections.allowFrom(restAlb, ec2.Port.tcp(3000));
    graphTasks.connections.allowFrom(graphAlb, ec2.Port.tcp(4000));
    restAlb.connections.allowFrom(graphTasks, ec2.Port.tcp(3000));

    const table = new dynamodb.Table(this, "Trips", {
      tableName: `wander-${config.environment}-trips`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const pool = new cognito.UserPool(this, "Users", {
      userPoolName: `wander-${config.environment}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const client = pool.addClient("BrowserClient", {
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [`${config.siteOrigin}/auth/callback/`],
        logoutUrls: [config.siteOrigin],
      },
    });
    pool.addDomain("HostedLogin", {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });

    const restRepository = new ecr.Repository(this, "RestImages", {
      repositoryName: `wander-${config.environment}-rest`,
      encryption: ecr.RepositoryEncryption.AES_256,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ maxImageCount: 20 }],
    });
    const graphRepository = new ecr.Repository(this, "GraphImages", {
      repositoryName: `wander-${config.environment}-graph`,
      encryption: ecr.RepositoryEncryption.AES_256,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ maxImageCount: 20 }],
    });
    const uiBucket = new s3.Bucket(this, "UiBucket", {
      bucketName: `wander-${config.account}-${config.region}-${config.environment}-ui`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const logKey = new kms.Key(this, "LogKey", {
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const logGroupName = `/wander/${config.environment}/api`;
    logKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [
          new iam.ServicePrincipal(`logs.${config.region}.amazonaws.com`),
        ],
        actions: [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ],
        resources: ["*"],
        conditions: {
          ArnEquals: {
            "kms:EncryptionContext:aws:logs:arn": `arn:aws:logs:${config.region}:${config.account}:log-group:${logGroupName}`,
          },
        },
      }),
    );
    const logGroup = new logs.LogGroup(this, "ApiLogs", {
      logGroupName,
      retention: logs.RetentionDays.TWO_WEEKS,
      encryptionKey: logKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const assumeTasks = new iam.ServicePrincipal("ecs-tasks.amazonaws.com");
    const restTask = new iam.Role(this, "RestTaskRole", {
      assumedBy: assumeTasks,
    });
    const graphTask = new iam.Role(this, "GraphTaskRole", {
      assumedBy: assumeTasks,
    });
    table.grantReadWriteData(restTask);
    const executionPolicy = iam.ManagedPolicy.fromAwsManagedPolicyName(
      "service-role/AmazonECSTaskExecutionRolePolicy",
    );
    const restExecution = new iam.Role(this, "RestExecutionRole", {
      assumedBy: assumeTasks,
      managedPolicies: [executionPolicy],
    });
    const graphExecution = new iam.Role(this, "GraphExecutionRole", {
      assumedBy: assumeTasks,
      managedPolicies: [executionPolicy],
    });
    const deployRole = createDeploymentRole(this, config, {
      repositories: [restRepository, graphRepository],
      uiBucket,
    });
    for (const name of ["openai", "anthropic", "ticketmaster"]) {
      secretsmanager.Secret.fromSecretNameV2(
        this,
        `ExistingSecret${name}`,
        `${path}/secrets/${name}`,
      ).grantRead(graphExecution);
    }

    parameter("network/vpc-id", vpc.vpcId);
    vpc.privateSubnets.forEach((subnet, index) =>
      parameter(`network/private-subnet-${index + 1}-id`, subnet.subnetId),
    );
    parameter("network/rest-task-security-group-id", restTasks.securityGroupId);
    parameter(
      "network/graph-task-security-group-id",
      graphTasks.securityGroupId,
    );
    parameter("compute/rest-listener-arn", restListener.listenerArn);
    parameter("compute/graph-listener-arn", graphListener.listenerArn);
    parameter("compute/cluster-arn", cluster.clusterArn);
    parameter("compute/graph-alb-arn", graphAlb.loadBalancerArn);
    parameter("compute/graph-alb-dns", graphAlb.loadBalancerDnsName);
    parameter("compute/rest-alb-arn", restAlb.loadBalancerArn);
    parameter("compute/rest-alb-dns", restAlb.loadBalancerDnsName);
    parameter("data/trips-table-name", table.tableName);
    parameter("auth/user-pool-id", pool.userPoolId);
    parameter("auth/browser-client-id", client.userPoolClientId);
    parameter(
      "auth/hosted-domain",
      `${config.cognitoDomainPrefix}.auth.${config.region}.amazoncognito.com`,
    );
    parameter("images/rest-repository-uri", restRepository.repositoryUri);
    parameter("images/graph-repository-uri", graphRepository.repositoryUri);
    parameter("ui/bucket-name", uiBucket.bucketName);
    parameter("roles/rest-task-arn", restTask.roleArn);
    parameter("roles/graph-task-arn", graphTask.roleArn);
    parameter("roles/rest-execution-arn", restExecution.roleArn);
    parameter("roles/graph-execution-arn", graphExecution.roleArn);
    parameter("roles/deployment-arn", deployRole.roleArn);
    parameter("logs/api-group-name", logGroup.logGroupName);

    new cdk.CfnOutput(this, "ParameterPrefix", { value: path });
    new cdk.CfnOutput(this, "GraphAlbDns", {
      value: graphAlb.loadBalancerDnsName,
    });
  }
}
