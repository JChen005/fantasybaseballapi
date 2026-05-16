function getOpenApiDoc() {
  return {
    openapi: '3.0.0',
    info: {
      title: 'DraftKit Player API',
      version: '0.1.0',
      description: 'Licensed player and valuation API for DraftKit.',
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
        },
      },
    },
    paths: {
      '/v1/health': { get: { summary: 'Health check' } },
      '/v1/license/status': { get: { summary: 'License status', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players': { get: { summary: 'List players', security: [{ ApiKeyAuth: [] }] } },
      '/v1/valuations/players': { post: { summary: 'League-aware player valuations', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players/search': { get: { summary: 'Search players', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players/{playerId}': { get: { summary: 'Player details', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players/{playerId}/transactions': { get: { summary: 'Player transactions', security: [{ ApiKeyAuth: [] }] } },
      '/v1/teams/{teamId}/depth-chart': { get: { summary: 'Team depth chart', security: [{ ApiKeyAuth: [] }] } },
      '/v1/admin/mock-transaction': { post: { summary: 'Publish mock transaction (admin secret)' } },
      '/v1/admin/data-refresh': { post: { summary: 'Refresh seed data' } },
    },
  };
}

module.exports = {
  getOpenApiDoc,
};
