# Hero Tasks App — Azure Infrastructure

Bicep IaC for the Azure backend: Static Web App (frontend), Function App
(API), Cosmos DB (data), Key Vault (secrets). This was written directly
(not via GitHub's Copilot coding agent) and validated by compiling with
the Bicep CLI — `bicep build main.bicep` succeeds with zero errors or
warnings; the compiled output is checked in at `main.json`.

**Nothing here has been deployed.** Writing the IaC and running it against
a real Azure subscription are two different things — this repo has no
Azure credentials attached, so the actual `az deployment group create`
step is yours to run (or wire into GitHub Actions once you're ready).

## Architecture

| Module | File | Description |
|--------|------|-------------|
| **Storage Account** | `modules/storage.bicep` | Backs only the Function App's own runtime state (`AzureWebJobsStorage`) — no app data lives here |
| **Cosmos DB** | `modules/cosmosdb.bicep` | Free-tier account, one database, containers: `households`, `people`, `chores`, `completions`, `rewards`, `planningItems` (reminders/voice notes/calendar items), `auditEvents` |
| **Key Vault** | `modules/keyvault.bicep` | Secrets store (currently just `llm-api-key`), RBAC-only, Function App reads via managed identity |
| **Function App** | `modules/functionapp.bicep` | Consumption-plan API, HTTP-triggered (not timer — this is an interactive app), system-assigned managed identity for all Azure access |
| **Static Web App** | `modules/staticwebapp.bicep` | Free tier, with the Function App linked as its backend (`linkedBackends`) so auth/CORS is handled by the platform instead of hand-rolled |

`main.bicep` wires these together and grants the Function App's managed
identity exactly three roles: Storage Blob Data Contributor (its own
runtime storage), Key Vault Secrets User (read `llm-api-key`), and Cosmos
DB Built-in Data Contributor (read/write household data). No connection
strings or access keys anywhere — Cosmos DB and the storage account both
have local/key-based auth disabled (`disableLocalAuth` / `allowSharedKeyAccess: false`).

## Prerequisites (before you can actually deploy)

- An Azure subscription with a resource group created for this project
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), logged in (`az login`)
- Bicep CLI (`az bicep install`, or the standalone binary — `az` will offer to install it automatically on first `az deployment` command if missing)

## Deploying

```bash
az group create --name herotasks-dev-rg --location <your-region>

az deployment group create \
  --resource-group herotasks-dev-rg \
  --template-file infra/main.bicep \
  --parameters @infra/parameters.dev.json
```

To seed the LLM API key at deploy time instead of adding it to Key Vault
manually afterward:

```bash
az deployment group create \
  --resource-group herotasks-dev-rg \
  --template-file infra/main.bicep \
  --parameters @infra/parameters.dev.json \
  --parameters llmApiKey=<your-llm-api-key>
```

Repeat with `parameters.prod.json` and a separate resource group for prod.

## Automating deployment from GitHub Actions (optional, later)

This isn't wired up yet — it needs a one-time Azure-side setup that only
you can do (create a federated credential / service principal so GitHub
Actions can authenticate to your subscription without a long-lived
secret). Once you've done that and added the three
`AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` secrets to
this repo, tell me and I'll add the workflow — the Bicep side is already
ready for it.

## Parameter reference

### `main.bicep`

| Parameter | Type | Default | Description |
|-----------|------|---------|--------------|
| `env` | string | *(required)* | `dev` or `prod` |
| `location` | string | `resourceGroup().location` | Azure region |
| `functionWorkerRuntime` | string | `node` | Function worker runtime |
| `functionLinuxFxVersion` | string | `Node\|20` | Linux runtime stack |
| `staticWebAppSku` | string | `Free` | Static Web App SKU |
| `llmApiKey` | string (secure) | `''` | Voice-intent LLM API key; leave empty to skip seeding |
| `enableKeyVaultPublicAccess` | bool | `false` | Leave `false` unless you specifically need it |
| `cosmosSharedThroughput` | int | `400` | RU/s shared across all Cosmos containers (well within the 1000 RU/s free-tier allowance) |

## Cosmos DB data model (v1)

Matches `docs/mvp-scope-v1.md`. All containers except `households` are
partitioned by `/householdId` — cheap, co-located queries for a
single-household app. `households` is partitioned by its own `/id` since
there's no higher grouping above it.

| Container | Partition key | Holds |
|-----------|----------------|-------|
| `households` | `/id` | The household itself |
| `people` | `/householdId` | Parent + kid profiles, roles, PINs |
| `chores` | `/householdId` | Chore definitions, assignment, schedule |
| `completions` | `/householdId` | Chore completion + approval history |
| `rewards` | `/householdId` | Reward catalog + redemption history |
| `planningItems` | `/householdId` | Reminders, voice notes, calendar events |
| `auditEvents` | `/householdId` | Who changed what, when |

## Security

- **Storage account**: no public blob access, shared-key access disabled — Function App auth is managed-identity only.
- **Cosmos DB**: `disableLocalAuth: true` — no primary/secondary keys work, only Azure AD/managed identity via the SQL role assignment.
- **Key Vault**: RBAC authorization (no legacy access policies), 90-day soft-delete retention, public network access disabled by default.
- **Function App**: HTTPS-only, TLS 1.2 minimum, FTPS disabled, system-assigned managed identity for every downstream call.

## Troubleshooting

### Function App can't read from Key Vault / Cosmos DB / Storage
Role assignments can take a few minutes to propagate after first deploy. Re-check the resource's Access control (IAM) blade if a call fails immediately after deployment.

### Deployment fails with "resource already exists"
Role assignment names are deterministic GUIDs derived from resource IDs — redeploying updates the existing assignment in place. A real conflict means the same role is being assigned to the same principal twice somewhere.

## Next steps
1. Deploy to `dev` and confirm all five resources provision cleanly.
2. Write the actual Function App code (HTTP-triggered endpoints for chores/rewards/reminders/voice — this is the `developer` agent's job, issue-by-issue from here).
3. Wire up GitHub Actions deployment once Azure credentials are set up on your end.
4. Promote to `prod` with `parameters.prod.json` after `dev` is validated.
