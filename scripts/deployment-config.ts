import { parseConfig as platformConfig } from "../platform-cdk/src/config.js";
import { parseConfig as apiConfig } from "../../graph-api/infra/config.js";
import { parseConfig as uiConfig } from "../../react-ui/infra/config.js";

type Input = Record<string, string | undefined>;

/**
 * Validates every deployment input in one place before any command is planned. Errors name the
 * setting, never its value. The image tag is the graph revision, known only to the caller.
 */
export function resolveDeployment(input: Input, graphRevision: string) {
  const platform = platformConfig(input);
  // The AWS CLI and SDKs honour these over --region in some paths; a mismatch deploys elsewhere.
  for (const key of ["AWS_REGION", "AWS_DEFAULT_REGION"])
    if (input[key] && input[key] !== platform.region)
      throw new Error(`${key} must match PLATFORM_REGION`);
  uiConfig(input);
  const graphOrigin = input.DEPLOY_GRAPH_ORIGIN;
  let parsed: URL | null = null;
  try {
    parsed = graphOrigin ? new URL(graphOrigin) : null;
  } catch {
    parsed = null;
  }
  if (
    !graphOrigin ||
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.origin !== graphOrigin
  )
    throw new Error("Invalid DEPLOY_GRAPH_ORIGIN");
  // The static site and the GraphQL API are separate endpoints; one origin cannot serve both.
  if (graphOrigin === platform.siteOrigin)
    throw new Error(
      "Conflicting origins: DEPLOY_GRAPH_ORIGIN equals PLATFORM_SITE_ORIGIN",
    );
  const api = apiConfig({ ...input, API_IMAGE_TAG: graphRevision });
  const secrets = [
    api.API_LLM_PROVIDER === "mock" ? null : api.API_LLM_PROVIDER,
    api.API_EVENTS_PROVIDER === "ticketmaster" ? "ticketmaster" : null,
  ].filter(
    (vendor): vendor is "openai" | "anthropic" | "ticketmaster" =>
      vendor !== null,
  );
  return Object.freeze({ platform, graphOrigin, api, secrets });
}
export type Deployment = ReturnType<typeof resolveDeployment>;

/**
 * What this deployment will run with, for review before execution. Selections, public
 * identifiers and secret names only; never a secret value.
 */
export function deploymentSummary({
  platform,
  graphOrigin,
  api,
  secrets,
}: Deployment) {
  const prefix = `/wander/${platform.environment}/v1/secrets`;
  return [
    "configuration summary (selections and names only, no secret values)",
    `  environment=${platform.environment} account=${platform.account} region=${platform.region}`,
    `  site=${platform.siteOrigin} graph=${graphOrigin}`,
    "  auth=live (Cognito) store=dynamo",
    `  providers weather=${api.API_WEATHER_PROVIDER} places=${api.API_PLACES_PROVIDER} events=${api.API_EVENTS_PROVIDER} llm=${api.API_LLM_PROVIDER} model=${api.API_LLM_MODEL ?? "none"}`,
    `  secrets required=${secrets.length ? secrets.map((vendor) => `${prefix}/${vendor}`).join(",") : "none"}`,
    "  fixed in this release path: telemetry=off sentry=off",
    "  browser settings are compiled into the UI export: a change needs a rebuild and republish",
    "  API settings are task environment: a change needs a redeploy of that service",
  ];
}
