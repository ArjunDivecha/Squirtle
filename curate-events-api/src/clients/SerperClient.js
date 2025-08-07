/**
 * =============================================================================
 * SCRIPT NAME: SerperClient.js
 * =============================================================================
 * 
 * DESCRIPTION:
 * Client for the Serper.dev service, which provides access to Google Search
 * results including events and organic search results. This replaces SerpAPI
 * due to credit limitations.
 * 
 * VERSION: 1.0
 * LAST UPDATED: 2025-08-06
 * AUTHOR: Cascade
 * =============================================================================
 */

import config from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SerperClient');

export class SerperClient {
  constructor() {
    this.apiKey = config.serperApiKey;
    this.baseUrl = 'https://google.serper.dev/search';
    this.timeout = 15000; // 15 seconds
  }

  /**
   * Search for events using Serper Google Search API.
   * @param {Object} options - Search options.
   * @returns {Promise<Object>} API response with events.
   */
  async searchEvents({ category, location, limit = 10 }) {
    const startTime = Date.now();
    const query = `${category} events in ${location} 2025`;

    const payload = {
      q: query,
      gl: 'us',
      hl: 'en',
      num: Math.min(limit * 2, 20), // Get more results to filter for events
      type: 'search'
    };

    logger.info('Searching Serper for events', { query });

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      const processingTime = Date.now() - startTime;

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Extract events from organic results and people also ask
      const organicResults = data.organic || [];
      const peopleAlsoAsk = data.peopleAlsoAsk || [];
      const relatedSearches = data.relatedSearches || [];

      // Filter and transform results that look like events
      const eventResults = this.filterEventResults([...organicResults, ...peopleAlsoAsk]);
      const transformedEvents = eventResults
        .slice(0, limit)
        .map(result => this.transformEvent(result, category))
        .filter(Boolean);

      logger.info(`Serper search successful, found ${transformedEvents.length} events.`, { 
        processingTime: `${processingTime}ms`,
        totalResults: organicResults.length 
      });

      return {
        success: true,
        events: transformedEvents,
        count: transformedEvents.length,
        processingTime,
        source: 'serper',
        metadata: {
          totalOrganic: organicResults.length,
          relatedSearches: relatedSearches.map(r => r.query || r).slice(0, 5)
        }
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      logger.error('Serper error', { error: error.message, query, processingTime: `${processingTime}ms` });
      return {
        success: false,
        error: error.message,
        events: [],
        count: 0,
        processingTime,
        source: 'serper'
      };
    }
  }

  /**
   * Filter search results to find event-related content.
   * @param {Array} results - Search results from Serper.
   * @returns {Array} Filtered results that appear to be events.
   */
  filterEventResults(results) {
    const eventKeywords = [
      'event', 'festival', 'concert', 'conference', 'workshop', 'meetup',
      'seminar', 'exhibition', 'show', 'performance', 'gathering', 'summit',
      'fair', 'expo', 'convention', 'symposium', 'webinar', 'class',
      'eventbrite', 'meetup.com', 'facebook.com/events', 'tickets',
      'registration', 'rsvp', 'calendar'
    ];

    return results.filter(result => {
      const title = (result.title || '').toLowerCase();
      const snippet = (result.snippet || '').toLowerCase();
      const link = (result.link || '').toLowerCase();
      const question = (result.question || '').toLowerCase();
      
      const searchText = `${title} ${snippet} ${link} ${question}`;
      
      return eventKeywords.some(keyword => searchText.includes(keyword)) ||
             this.containsDatePattern(searchText) ||
             this.containsVenuePattern(searchText);
    });
  }

  /**
   * Check if text contains date patterns indicating an event.
   * @param {string} text - Text to check.
   * @returns {boolean} True if date patterns found.
   */
  containsDatePattern(text) {
    const datePatterns = [
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i,
      /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
      /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*,?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
      /\b(today|tomorrow|tonight|this\s+(week|weekend|month))\b/i,
      /\b\d{1,2}(st|nd|rd|th)\s+(of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)/i
    ];
    
    return datePatterns.some(pattern => pattern.test(text));
  }

  /**
   * Check if text contains venue/location patterns.
   * @param {string} text - Text to check.
   * @returns {boolean} True if venue patterns found.
   */
  containsVenuePattern(text) {
    const venuePatterns = [
      /\b(at|@)\s+[A-Z][a-zA-Z\s]+\b/,
      /\b(venue|location|address|hall|center|theatre|theater|auditorium|stadium|arena)\b/i,
      /\b\d+\s+[A-Z][a-zA-Z\s]+\s+(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr)\b/i
    ];
    
    return venuePatterns.some(pattern => pattern.test(text));
  }

  /**
   * Transform a Serper search result into our standard event format.
   * @param {Object} serperResult - A single result from Serper.
   * @param {string} category - The event category.
   * @returns {Object|null} A normalized event object or null if invalid.
   */
  transformEvent(serperResult, category) {
    try {
      const title = serperResult.title || serperResult.question;
      if (!title) return null;

      // Extract date information from snippet or title
      const snippet = serperResult.snippet || '';
      const dateInfo = this.extractDateInfo(title + ' ' + snippet);
      
      // Extract venue information
      const venue = this.extractVenue(title + ' ' + snippet);
      
      // Generate event ID
      const eventId = `serper_${title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;

      return {
        id: eventId,
        title: title,
        description: snippet || 'Event details available on the event page.',
        category: category,
        venue: venue,
        location: venue,
        startDate: dateInfo.startDate,
        endDate: dateInfo.endDate,
        eventUrl: serperResult.link,
        ticketUrl: this.extractTicketUrl(serperResult.link, snippet),
        source: 'serper_api',
        confidence: this.calculateConfidence(serperResult, category),
        thumbnail: null // Serper doesn't provide thumbnails in basic search
      };
    } catch (error) {
      logger.error('Error transforming Serper event', { 
        error: error.message, 
        eventTitle: serperResult.title || serperResult.question 
      });
      return null;
    }
  }

  /**
   * Extract date information from text.
   * @param {string} text - Text to extract dates from.
   * @returns {Object} Object with startDate and endDate.
   */
  extractDateInfo(text) {
    const now = new Date();
    let startDate = now.toISOString();
    let endDate = startDate;

    // Try to extract specific dates
    const datePatterns = [
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s*(\d{4})?/i,
      /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/,
      /\b(\d{1,2})(st|nd|rd|th)\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i
    ];

    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          let dateStr;
          if (pattern.source.includes('january|february')) {
            // Month name pattern
            const month = match[1];
            const day = match[2];
            const year = match[3] || now.getFullYear();
            dateStr = `${month} ${day}, ${year}`;
          } else if (pattern.source.includes('\\d{1,2}\\/')) {
            // MM/DD/YYYY pattern
            const month = match[1];
            const day = match[2];
            const year = match[3].length === 2 ? `20${match[3]}` : match[3];
            dateStr = `${month}/${day}/${year}`;
          } else {
            // Day + month pattern
            const day = match[1];
            const month = match[3];
            const year = now.getFullYear();
            dateStr = `${month} ${day}, ${year}`;
          }
          
          const parsedDate = new Date(dateStr);
          if (!isNaN(parsedDate.getTime())) {
            startDate = parsedDate.toISOString();
            endDate = startDate;
            break;
          }
        } catch (e) {
          // Continue to next pattern if parsing fails
        }
      }
    }

    return { startDate, endDate };
  }

  /**
   * Extract venue information from text.
   * @param {string} text - Text to extract venue from.
   * @returns {string} Venue name or default.
   */
  extractVenue(text) {
    const venuePatterns = [
      /\b(?:at|@)\s+([A-Z][a-zA-Z\s&'-]+(?:Center|Centre|Hall|Theatre|Theater|Auditorium|Stadium|Arena|Club|Bar|Restaurant|Hotel|Museum|Gallery|Park))\b/i,
      /\b([A-Z][a-zA-Z\s&'-]+(?:Center|Centre|Hall|Theatre|Theater|Auditorium|Stadium|Arena))\b/i,
      /\b(?:venue|location):\s*([A-Z][a-zA-Z\s&'-]+)/i
    ];

    for (const pattern of venuePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return 'See Event Page';
  }

  /**
   * Extract ticket URL if different from main event URL.
   * @param {string} eventUrl - Main event URL.
   * @param {string} snippet - Event snippet text.
   * @returns {string|null} Ticket URL or null.
   */
  extractTicketUrl(eventUrl, snippet) {
    // If the main URL is already a ticket platform, return it
    const ticketDomains = ['eventbrite.com', 'ticketmaster.com', 'universe.com', 'brownpapertickets.com'];
    if (ticketDomains.some(domain => eventUrl && eventUrl.includes(domain))) {
      return eventUrl;
    }

    // Look for ticket URLs in snippet
    const urlPattern = /https?:\/\/[^\s]+/g;
    const urls = snippet.match(urlPattern) || [];
    
    for (const url of urls) {
      if (ticketDomains.some(domain => url.includes(domain))) {
        return url;
      }
    }

    return null;
  }

  /**
   * Calculate confidence score for an event.
   * @param {Object} result - Serper search result.
   * @param {string} category - Event category.
   * @returns {number} Confidence score between 0 and 1.
   */
  calculateConfidence(result, category) {
    let confidence = 0.6; // Base confidence for Serper results

    const text = `${result.title || ''} ${result.snippet || ''} ${result.link || ''}`.toLowerCase();
    
    // Boost confidence for event-specific domains
    const eventDomains = ['eventbrite.com', 'meetup.com', 'facebook.com/events', 'lu.ma'];
    if (eventDomains.some(domain => text.includes(domain))) {
      confidence += 0.2;
    }

    // Boost confidence for category-specific keywords
    if (text.includes(category.toLowerCase())) {
      confidence += 0.1;
    }

    // Boost confidence for event keywords
    const eventKeywords = ['event', 'festival', 'concert', 'conference', 'workshop'];
    if (eventKeywords.some(keyword => text.includes(keyword))) {
      confidence += 0.1;
    }

    // Boost confidence for date patterns
    if (this.containsDatePattern(text)) {
      confidence += 0.05;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Get the health status of the Serper API.
   * @returns {Promise<Object>} Health status.
   */
  async getHealthStatus() {
    const startTime = Date.now();
    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          q: 'test',
          num: 1
        })
      });
      
      const processingTime = Date.now() - startTime;
      
      if (response.ok) {
        const data = await response.json();
        return { 
          status: 'healthy', 
          latency: processingTime, 
          message: 'Serper API responding.',
          credits: data.credits || 'unknown'
        };
      } else {
        const errorText = await response.text();
        return { 
          status: 'unhealthy', 
          latency: processingTime, 
          message: `HTTP ${response.status}: ${errorText}` 
        };
      }
    } catch (error) {
      return { 
        status: 'unhealthy', 
        latency: null, 
        message: error.message 
      };
    }
  }
}

export default SerperClient;
