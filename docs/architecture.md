# Architecture

Wander is a trip planner split into three applications and one hub. They talk to each other only
through typed interfaces. The browser talks to GraphQL, GraphQL talks to REST, and only REST
stores data.

## Repositories

```mermaid
flowchart LR
  subgraph hub["graph-rest-react-stack (hub)"]
    compose[Docker Compose]
    foundation[CDK foundation stack]
    scripts["Deploy, smoke and<br/>acceptance scripts"]
    telemetry[Collector configs and dashboard]
  end
  ui["react-ui<br/>Next.js static export"]
  gql["graph-api<br/>GraphQL Yoga on Node"]
  rest["rest-api<br/>Hono on Bun"]

  compose --> ui & gql & rest
  scripts -->|"deploys in order"| foundation --> rest --> gql --> ui
```

Each repository installs, tests and deploys on its own. The hub pins compatible revisions and
owns everything the three applications share.

| Layer   | Owns                                                                                | Main trade-off                                              |
| ------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| UI      | Interaction, generated urql operations, PKCE sign-in, planning guides, local images | Public configuration is fixed at build time                 |
| GraphQL | Client-shaped reads, DataLoader, provider orchestration, generation lifecycle       | Process-local jobs need one task; a restart interrupts work |
| REST    | Domain rules, ownership, conditional writes, share projections, OpenAPI             | The extra HTTP hop keeps persistence separate from planning |
| Hub     | Compose, shared CDK foundation, release tooling                                     | Four independent repositories need compatible revisions     |

## Runtime

```mermaid
flowchart LR
  subgraph browser[Browser]
    pages["/  /plan/  /trip/  /share/<br/>/docs/  /auth/callback/"]
  end
  subgraph graphapi["graph-api :4000"]
    yoga["/graphql<br/>depth and cost limits"]
    sse["/generations/:id/events<br/>authenticated SSE"]
    gen["Generation manager<br/>process-local jobs and replay"]
    loader["Typed REST client<br/>request-scoped DataLoader"]
    ports["Provider ports"]
  end
  subgraph restapi["rest-api :3000"]
    routes["/trips  /shared  /health<br/>/docs Swagger UI  /openapi.json"]
    domain["Trip domain<br/>ownership and versions"]
    store["Store port"]
  end
  mem[(Memory)]
  ddb[(DynamoDB)]
  idp["Cognito, or demo identity"]
  vendors["wttr · Overpass · Ticketmaster<br/>OpenAI · Anthropic, or mocks"]

  pages -->|"GraphQL over HTTP"| yoga
  pages -->|"fetch with bearer token"| sse
  pages -.->|"PKCE sign-in"| idp
  yoga --> gen & loader
  sse --> gen
  gen --> ports --> vendors
  gen --> loader
  loader -->|"validated HTTP and bearer"| routes
  routes --> domain --> store
  store --> mem
  store --> ddb
  yoga -.->|"verify JWT"| idp
  routes -.->|"verify JWT"| idp
```

By default the system runs on mock providers, demo identity and in-memory storage, with
telemetry off. A fresh clone needs no accounts. In live mode, both APIs verify Cognito access
tokens and never fall back to demo identity. Memory storage resets when REST restarts. DynamoDB
keeps trips but not graph jobs.

## Planning journey

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant G as graph-api
  participant P as Providers
  participant R as rest-api
  B->>G: startCreateGeneration(input)
  G-->>B: Generation id
  B->>G: GET /generations/:id/events
  G->>P: weather, places, events
  G->>P: stream itinerary text
  P-->>G: chunks
  G-->>B: SSE snapshots with sequence numbers
  G->>R: POST /trips
  R-->>G: saved trip and version
  G-->>B: completion event with trip id
  B->>G: trip(id) / pinActivity / swapActivity / refine
  G->>R: conditional writes, version checked
  B->>G: shareTrip
  G->>R: POST /trips/:id/share
  Note over B,R: Anyone with the link reads it through sharedTrip and GET /shared/... and gets a read-only projection
```

If the connection drops, the browser reconnects and replays from the last sequence number it
saw. A stale edit gets a conflict back instead of overwriting newer data. A share stays readable
until it expires or is revoked; revoking is the REST `DELETE /trips/:id/share` call.

## Planning providers

```mermaid
flowchart LR
  env["PROVIDER_WEATHER · PROVIDER_PLACES<br/>PROVIDER_EVENTS · PROVIDER_LLM"] --> registry[Registry]
  registry --> weather["Weather port<br/>mock or wttr"]
  registry --> places["Places port<br/>mock or Overpass"]
  registry --> events["Events port<br/>mock or Ticketmaster"]
  registry --> llm["LLM port<br/>mock, OpenAI or Anthropic"]
  weather & places & events & llm --> planner["Trip planner<br/>imports ports only"]
```

Only the adapters you select get built. A selected adapter must have its key and model before
startup, and if it fails at runtime it reports a safe error rather than quietly switching to a
mock.

## Local container stack

```mermaid
flowchart LR
  subgraph core[Default services]
    ui["ui :3001<br/>static export server"]
    gql["graph :4000"]
    rest["rest :3000"]
  end
  subgraph dynamo["profile: dynamo"]
    vol[dynamodb-volume-init] --> ddb[("dynamodb<br/>named volume")]
    init[dynamodb-init] --> ddb
  end
  subgraph tel["profile: telemetry"]
    col[collector] --> jaeger["jaeger :16686"]
  end
  subgraph nr["profile: newrelic"]
    colnr[collector-newrelic] --> nrc[(New Relic)]
  end
  ui -.->|"browser calls :4000"| gql
  gql --> rest --> ddb
  gql & rest -.->|OTLP| col
  gql & rest -.->|OTLP| colnr
```

Source development and Compose use the same ports, so run only one at a time. A normal shutdown
keeps the database volume.

## AWS

```mermaid
flowchart LR
  user((User))
  subgraph edge[Public edge]
    cf[CloudFront] -->|OAC| s3[(Private S3 bucket)]
    galb["Public ALB<br/>HTTPS"]
  end
  subgraph vpc["VPC private subnets"]
    gtask["graph Fargate task<br/>one task, stop then start"]
    ralb[Internal ALB]
    rtask["rest Fargate tasks<br/>rolling replacement"]
  end
  ddb[(DynamoDB)]
  cog[Cognito user pool]
  sm[Secrets Manager]
  ssm["SSM versioned parameters"]
  ecr[ECR]
  logs["CloudWatch Logs<br/>KMS encrypted"]

  user --> cf
  user --> galb --> gtask --> ralb --> rtask --> ddb
  user -.->|sign-in| cog
  gtask -.->|selected keys| sm
  gtask & rtask -.-> logs
  ecr -.-> gtask & rtask
  ssm -.->|"resolved at deploy"| gtask & rtask & cf
```

The foundation stack owns the shared, stateful pieces: the network, both load balancers, the
cluster, the table, Cognito, the image repositories, the bucket, the log key and the roles. It
publishes all of them as versioned SSM parameters. Each application stack resolves those
parameters at deploy time and deploys only its own compute or distribution. REST and the tasks are never publicly
reachable, and the UI stack owns the bucket's only access policy.

## Build and release

```mermaid
flowchart LR
  schema[schema.graphql snapshot] --> codegen[Typed operations]
  art[artwork SVG] --> sharp[Sharp AVIF/WebP, committed]
  codegen & sharp --> next[Next static export]
  next --> maps["Optional Sentry<br/>source-map upload, then removal"]
  maps --> archive["Archive by revision<br/>and public config"]
  archive --> publish["S3 publish<br/>hashed assets first, HTML last"]
  images[API images tagged by SHA] --> ecr[ECR] --> ecs[ECS rollout]
```

Next builds the static app, Vite only transforms tests, and Sharp runs at build time.
There is no Next server running at request time and no direct path from the UI to REST.
Rollback republishes an archived export without rebuilding it. Hashed assets are kept between
releases, but a release is not atomic across pages.

## Observability and testing

API telemetry uses OpenTelemetry for traces, metrics and redacted logs, and is off by default.
When turned on it goes to a collector that forwards to Jaeger or New Relic. W3C trace context
carries from the browser through graph to REST. Browser errors go to Sentry, also opt-in.
Vitest, real REST-to-graph integration tests, Playwright and CDK assertions cover the boundaries
locally. Docker acceptance and account-backed acceptance run separately.
