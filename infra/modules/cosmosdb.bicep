@description('Deployment environment suffix (for example: dev or prod).')
param env string

@description('Azure region for the Cosmos DB account.')
param location string

@description('Function App managed identity principal ID that needs data-plane read/write access.')
param functionPrincipalId string

@description('Cosmos DB SQL database name.')
param databaseName string = 'herotasks'

@description('Shared throughput (RU/s) across all containers in the database. The Cosmos DB free tier covers up to 1000 RU/s and 25GB storage account-wide, comfortably above what a 2-kid household needs.')
param sharedThroughput int = 400

@description('Built-in Cosmos DB Data Contributor role definition GUID — same value on every Cosmos account, not environment-specific.')
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'

var cosmosAccountName = toLower(replace('herotasks-cosmos-${env}', '-', ''))

// Every non-households container is scoped to a household via this partition key,
// which keeps all of one family's data co-located and queries cheap.
var householdScopedContainers = [
  'people'
  'chores'
  'completions'
  'rewards'
  'pushSubscriptions'
  'planningItems'
  'auditEvents'
]

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosAccountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: true
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    // No primary/secondary keys usable — every client (the Function App) authenticates
    // via managed identity + the SQL role assignment below, never a connection string.
    disableLocalAuth: true
    minimalTlsVersion: 'Tls12'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmosAccount
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
    options: {
      throughput: sharedThroughput
    }
  }
}

// One household's own document — partitioned by its own id since there's no
// higher-level grouping above a household.
resource householdsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: 'households'
  properties: {
    resource: {
      id: 'households'
      partitionKey: {
        paths: ['/id']
        kind: 'Hash'
      }
    }
  }
}

resource scopedContainers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = [for name in householdScopedContainers: {
  parent: database
  name: name
  properties: {
    resource: {
      id: name
      partitionKey: {
        paths: ['/householdId']
        kind: 'Hash'
      }
    }
  }
}]

resource dataContributorRoleAssignment 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, functionPrincipalId, cosmosDataContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: functionPrincipalId
    scope: cosmosAccount.id
  }
}

output cosmosAccountName string = cosmosAccount.name
output cosmosEndpoint string = cosmosAccount.properties.documentEndpoint
output databaseName string = database.name
