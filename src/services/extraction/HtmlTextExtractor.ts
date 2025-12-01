/**
 * HTML Text Extractor
 * 
 * Converts HTML email bodies to clean text for processing
 */

import { ExtractorConfig, DEFAULT_EXTRACTOR_CONFIG } from './types';
import { decode } from 'html-entities';

export class HtmlTextExtractor {
  private config: ExtractorConfig;

  constructor(config: Partial<ExtractorConfig> = {}) {
    this.config = { ...DEFAULT_EXTRACTOR_CONFIG, ...config };
  }

  /**
   * Convert HTML to visible text
   * Preserves essential structure while removing markup
   */
  htmlToText(html: string): string {
    if (!html) return '';

    let text = html;

    // Remove script and style blocks completely
    text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

    // Convert line-break elements to newlines
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<\/tr>/gi, '\n');
    text = text.replace(/<\/td>/gi, ' ');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    text = decode(text);

    // Normalize whitespace (but preserve newlines)
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s+/g, '\n');
    text = text.replace(/\s+\n/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');

    return text.trim();
  }

  /**
   * Extract normalized core text for classification
   * This strips out noise to focus on content that indicates receipt vs. non-receipt
   */
  extractCoreText(html: string): string {
    if (!html) return '';

    let text = html;

    // Remove script and style blocks
    text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

    // Convert breaks to newlines
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');

    // Strip all HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    text = decode(text);

    // Remove URLs
    text = text.replace(/https?:\/\/\S+/gi, ' ');

    // Remove email addresses
    text = text.replace(/[\w.-]+@[\w.-]+\.\w+/gi, ' ');

    // Remove numbers and currency symbols (we only care about keyword presence)
    text = text.replace(/\d+([.,]\d+)?/g, ' ');
    text = text.replace(/[$€£¥CA]/g, ' ');

    // Split into lines and filter
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // Filter out footer noise
    const coreLines: string[] = [];
    for (const line of lines) {
      const lower = line.toLowerCase();
      const isFooter = this.config.footerWords.some(word => lower.includes(word));
      if (!isFooter) {
        coreLines.push(line);
      }
    }

    // Take first N lines and collapse
    const core = coreLines.slice(0, this.config.maxCoreLines).join(' ').toLowerCase();
    
    // Final whitespace normalization
    return core.replace(/\s+/g, ' ').trim();
  }

  /**
   * Extract specific data patterns from HTML with context awareness
   * Uses data-testid attributes when available (Uber emails use these)
   */
  extractDataAttribute(html: string, testId: string): string | null {
    const regex = new RegExp(`data-testid="${testId}"[^>]*>([^<]+)`, 'i');
    const match = html.match(regex);
    return match ? decode(match[1]).trim() : null;
  }

  /**
   * Extract text near a label (e.g., "Total CA$20.33")
   * Returns the text found within a window after the label
   */
  extractNearLabel(text: string, label: string, windowSize: number = 80): string | null {
    const lowerText = text.toLowerCase();
    const lowerLabel = label.toLowerCase();
    
    const index = lowerText.indexOf(lowerLabel);
    if (index === -1) return null;

    const start = index + label.length;
    const end = Math.min(text.length, start + windowSize);
    const window = text.slice(start, end);

    return window.trim() || null;
  }

  /**
   * Extract all text between two patterns
   */
  extractBetween(text: string, startPattern: string, endPattern: string): string | null {
    const startIndex = text.indexOf(startPattern);
    if (startIndex === -1) return null;

    const searchStart = startIndex + startPattern.length;
    const endIndex = text.indexOf(endPattern, searchStart);
    if (endIndex === -1) return null;

    return text.slice(searchStart, endIndex).trim() || null;
  }
}

