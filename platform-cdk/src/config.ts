import { z } from "zod";

/** CDK's default bootstrap qualifier; a custom `cdk bootstrap --qualifier` is not supported. */
export const bootstrapQualifier = "hnb659fds";

const schema = z.object({
  PLATFORM_ACCOUNT: z.string().regex(/^\d{12}$/),
  PLATFORM_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  PLATFORM_AVAILABILITY_ZONES: z.string().min(3),
  PLATFORM_ENV: z.string().regex(/^[a-z][a-z0-9-]{0,14}$/),
  PLATFORM_SITE_ORIGIN: z.url(),
  PLATFORM_CERTIFICATE_ARN: z
    .string()
    .regex(/^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/[a-f0-9-]{36}$/),
  PLATFORM_DEPLOY_PRINCIPAL_ARN: z
    .string()
    .regex(/^arn:aws:iam::\d{12}:(role|user)\/[A-Za-z0-9+=,.@_\/-]+$/),
  PLATFORM_COGNITO_DOMAIN_PREFIX: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/),
  PLATFORM_GITHUB_REPOSITORY: z
    .union([
      z.literal(""),
      z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    ])
    .optional(),
});

export interface PlatformConfig {
  account: string;
  region: string;
  availabilityZones: [string, string];
  environment: string;
  siteOrigin: string;
  certificateArn: string;
  deployPrincipalArn: string;
  cognitoDomainPrefix: string;
  /** owner/name allowed to assume the deployment role through GitHub OIDC; unset disables it. */
  githubRepository: string | undefined;
}

export function parseConfig(
  input: Record<string, string | undefined>,
): PlatformConfig {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid platform input: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const values = result.data;
  const availabilityZones = values.PLATFORM_AVAILABILITY_ZONES.split(",").map(
    (zone) => zone.trim(),
  );
  const [firstZone, secondZone] = availabilityZones;
  if (
    !firstZone ||
    !secondZone ||
    availabilityZones.length !== 2 ||
    firstZone === secondZone ||
    availabilityZones.some(
      (zone) => !new RegExp(`^${values.PLATFORM_REGION}[a-z]$`).test(zone),
    )
  )
    throw new Error("Invalid platform input: PLATFORM_AVAILABILITY_ZONES");
  const origin = new URL(values.PLATFORM_SITE_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.toString() !== `${origin.origin}/` ||
    origin.username ||
    origin.password
  )
    throw new Error("Invalid platform input: PLATFORM_SITE_ORIGIN");
  if (
    !values.PLATFORM_CERTIFICATE_ARN.startsWith(
      `arn:aws:acm:${values.PLATFORM_REGION}:${values.PLATFORM_ACCOUNT}:`,
    )
  )
    throw new Error("Invalid platform input: PLATFORM_CERTIFICATE_ARN");
  if (
    !values.PLATFORM_DEPLOY_PRINCIPAL_ARN.startsWith(
      `arn:aws:iam::${values.PLATFORM_ACCOUNT}:`,
    )
  )
    throw new Error("Invalid platform input: PLATFORM_DEPLOY_PRINCIPAL_ARN");
  const config: PlatformConfig = {
    account: values.PLATFORM_ACCOUNT,
    region: values.PLATFORM_REGION,
    availabilityZones: [firstZone, secondZone],
    environment: values.PLATFORM_ENV,
    siteOrigin: origin.origin,
    certificateArn: values.PLATFORM_CERTIFICATE_ARN,
    deployPrincipalArn: values.PLATFORM_DEPLOY_PRINCIPAL_ARN,
    cognitoDomainPrefix: values.PLATFORM_COGNITO_DOMAIN_PREFIX,
    githubRepository: values.PLATFORM_GITHUB_REPOSITORY || undefined,
  };
  return Object.freeze(config);
}
