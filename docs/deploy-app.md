# Deploying the app (API + frontend)

Same pattern as `infra/README.md` — everything runs from Azure Cloud
Shell ([shell.azure.com](https://shell.azure.com)), no local install
needed, works from a phone browser. Do this **after** the infrastructure
in `infra/` has been deployed (`herotasks-func-dev` and
`herotasks-swa-dev` need to already exist).

## 1. Deploy the API

```bash
cd ~/Hero-Tasks-App/api
npm install
func azure functionapp publish herotasks-func-dev
```

If `func` isn't found, install it first (one-time per Cloud Shell session):
```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

This pushes `hero.js` and its dependencies into the Function App. On
first request, it auto-seeds the household (Peter, Tymanda, Toby, Ollie —
PIN `1234` each) — no manual data entry needed.

**Quick sanity check** once it's deployed:
```bash
curl https://herotasks-func-dev.azurewebsites.net/api/hero
```
Should return a JSON blob starting `{"ok":true,"people":[...`. If you get
a timeout or 5xx, check Application Insights logs in the Portal (the
Function App resource → Monitoring → Logs) rather than guessing.

## 2. Deploy the frontend

Get the deployment token (a secret — don't paste it anywhere public):
```bash
az staticwebapp secrets list \
  --name herotasks-swa-dev \
  --resource-group herotasks-dev-rg \
  --query "properties.apiKey" -o tsv
```

Deploy with it:
```bash
cd ~/Hero-Tasks-App
npx -y @azure/static-web-apps-cli deploy ./frontend \
  --deployment-token "<paste the token from above>" \
  --env production
```

That's it — no build step, the frontend is plain HTML/CSS/JS.

## 3. Open it

```
https://salmon-river-0e879dc00.7.azurestaticapps.net
```
(or whatever `staticWebAppDefaultHostname` your `infra` deployment output
showed). Tap a name, PIN `1234`, and it should load real data from the
API — confirming the whole chain (frontend → Function App → Cosmos DB)
actually works end-to-end.

## Redeploying after a code change

Both commands above are safe to re-run any time this repo changes —
pull the latest first (`git pull`), then repeat step 1 and/or step 2
depending on what changed (API code vs. frontend code).

## What this covers vs. what's still missing

**Working in this MVP:** login (PIN-based), allocating tasks by voice
or typing, daily/weekly/one-off cycles, completing tasks, parent
approve/reject, points, levels, streaks, leaderboard, kids logging
extra tasks.

**Not built yet** (later backlog issues): rewards/redemption (#10),
voice-to-structured-reminder LLM validation (#12), calendar/planning
views (#13–17), parent dashboard analytics (#19–20), settings/privacy
controls (#21). The app is fully usable for the core chore loop today,
just not feature-complete against the full backlog.
