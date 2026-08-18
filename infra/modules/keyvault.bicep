@description('Deployment environment suffix (for example: dev or prod).')
param env string

@description('Azure region for the Key Vault.')
param location string

@description('Function App managed identity principal ID that needs secret read access.')
param functionPrincipalId string

@description('Secure value for the voice-intent LLM API key. Leave empty to skip seeding this secret.')
@secure()
param llmApiKey string = ''

@description('Built-in Key Vault role definition ID for the Secrets User role.')
param keyVaultRoleDefinitionId string = '4633458b-17de-408a-b874-0445c86b69e6'

@description('Enable public network access to Key Vault. Defaults to false (security-by-default); use private endpoints instead for production.')
param enablePublicNetworkAccess bool = false

var keyVaultName = 'herotasks-kv-${env}'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enabledForDeployment: false
    enabledForTemplateDeployment: false
    enabledForDiskEncryption: false
    softDeleteRetentionInDays: 90
    publicNetworkAccess: enablePublicNetworkAccess ? 'Enabled' : 'Disabled'
  }
}

resource functionSecretsUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionPrincipalId, keyVaultRoleDefinitionId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultRoleDefinitionId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource llmApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(llmApiKey)) {
  name: 'llm-api-key'
  parent: keyVault
  properties: {
    value: llmApiKey
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
