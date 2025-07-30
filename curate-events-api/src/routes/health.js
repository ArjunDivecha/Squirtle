/**
 * health.js
 * 
 * Health check endpoint for API monitoring and status verification
 */

import express from 'express';
import { createLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';

const router = express.Router();
const logger = createLogger('HealthRoute');

/**
 * GET /api/health
 * 
 * Returns server health status, configuration info, and API connectivity
 */
router.get('/', async (req, res) => {
  const startTime = Date.now();
  
  logger.info('Health check requested');
  
  try {
    // Basic health information
    const healthInfo = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      environment: config.nodeEnv,
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: 'MB'
      }
    };

    // Configuration information (safe to expose)
    const configInfo = {
      api: {
        maxEventsPerCategory: config.api.maxEventsPerCategory,
        defaultCategories: config.api.defaultCategories,
        timeout: config.api.timeout,
        rateLimitingEnabled: config.rateLimiting.enabled
      },
      perplexity: {
        model: config.perplexity.model,
        maxTokens: config.perplexity.maxTokens,
        temperature: config.perplexity.temperature,
        hasApiKey: !!config.perplexityApiKey
      }
    };

    // Check Perplexity API connectivity if requested
    let apiStatus = null;
    if (req.query.check_api === 'true') {
      try {
        // Import dynamically to avoid circular dependencies
        const { PerplexityClient } = await import('../clients/PerplexityClient.js');
        const client = new PerplexityClient(config.perplexityApiKey);
        
        logger.info('Testing Perplexity API connectivity');
        const testResult = await client.testConnection();
        
        apiStatus = {
          perplexity: {
            available: testResult.success,
            responseTime: testResult.processingTime,
            eventPatterns: testResult.eventPatterns,
            meetsExpectation: testResult.meetsExpectation,
            error: testResult.error || null
          }
        };
        
        logger.info('API connectivity test completed', apiStatus);
        
      } catch (error) {
        logger.error('API connectivity test failed', { error: error.message });
        
        apiStatus = {
          perplexity: {
            available: false,
            error: error.message
          }
        };
      }
    }

    const responseTime = Date.now() - startTime;
    
    const response = {
      ...healthInfo,
      config: configInfo,
      ...(apiStatus && { apiStatus }),
      responseTime: `${responseTime}ms`
    };

    logger.info('Health check completed', {
      responseTime: `${responseTime}ms`,
      apiTestRequested: req.query.check_api === 'true',
      status: 'healthy'
    });

    res.json(response);

  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    logger.error('Health check failed', {
      error: error.message,
      responseTime: `${responseTime}ms`
    });

    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
      responseTime: `${responseTime}ms`
    });
  }
});

/**
 * GET /api/health/deep
 * 
 * Comprehensive health check including API connectivity test
 */
router.get('/deep', async (req, res) => {
  // Redirect to main health check with API test enabled
  req.query.check_api = 'true';
  return router.handle(req, res);
});

export default router;