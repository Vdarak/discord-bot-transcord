import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';

/**
 * Google Gemini AI Summary Generation Service
 * Handles meeting transcript analysis and summary generation
 */

// Initialize Gemini AI
let genAI;
let model;

/**
 * Initializes the Gemini AI service
 */
export function initializeGemini() {
  try {
    if (!config.apis.gemini) {
      throw new Error('Gemini API key not found in configuration');
    }
    
    genAI = new GoogleGenerativeAI(config.apis.gemini);
    model = genAI.getGenerativeModel({ 
      model: config.gemini.model,
      generationConfig: {
        temperature: config.gemini.temperature,
        maxOutputTokens: config.gemini.maxTokens,
      }
    });
    
    console.log(`✅ Gemini AI initialized with model: ${config.gemini.model}`);
    return true;
    
  } catch (error) {
    console.error('❌ Failed to initialize Gemini AI:', error.message);
    throw error;
  }
}

/**
 * Generates a meeting summary from the combined transcript
 * @param {Object} combinedTranscript - Combined transcript object
 * @param {Object} meetingInfo - Additional meeting information
 * @returns {Promise<Object>} Generated summary with structured sections
 */
export async function generateMeetingSummary(combinedTranscript, meetingInfo = {}) {
  try {
    const startTime = Date.now();
    console.log(`🤖 [SUMMARY] Starting summary generation with Gemini ${config.gemini.model}`);
    
    // Ensure Gemini is initialized
    if (!model) {
      console.log(`🔧 [SUMMARY] Initializing Gemini AI...`);
      initializeGemini();
    }
    
    // Validate input
    if (!combinedTranscript.combinedText || combinedTranscript.combinedText.trim().length === 0) {
      throw new Error('No transcript text available for summarization');
    }
    
    console.log(`📊 [SUMMARY] Input validation:`);
    console.log(`   - Transcript length: ${combinedTranscript.combinedText.length} characters`);
    console.log(`   - Participants: ${combinedTranscript.participants.length}`);
    console.log(`   - Total words: ${combinedTranscript.statistics.totalWords}`);
    console.log(`   - Average confidence: ${combinedTranscript.statistics.averageConfidence}%`);
    
    // Prepare the prompt with transcript
    const prompt = `${config.gemini.summaryPrompt}${combinedTranscript.combinedText}
    
Additional Meeting Context:
- Participants: ${combinedTranscript.participants.map(p => p.username).join(', ')}
- Total Words: ${combinedTranscript.statistics.totalWords}
- Average Confidence: ${combinedTranscript.statistics.averageConfidence}%
- Meeting Duration: ${formatDuration(meetingInfo.duration || combinedTranscript.statistics.totalDuration)}`;
    
    console.log(`📊 Sending ${combinedTranscript.combinedText.length} characters to Gemini for analysis`);
    
    // Decide which Gemini model to use. For very large transcripts, try the configured largeModel.
    let modelToUse = model;
    try {
      const transcriptLength = combinedTranscript.combinedText.length;
      if (config.gemini.largeModel && transcriptLength > (config.gemini.largeInputThreshold || 0) && config.gemini.largeModel !== config.gemini.model) {
        console.log(`🔎 [SUMMARY] Large transcript detected (${transcriptLength} chars). Using large model: ${config.gemini.largeModel}`);
        modelToUse = genAI.getGenerativeModel({
          model: config.gemini.largeModel,
          generationConfig: {
            temperature: config.gemini.temperature,
            maxOutputTokens: config.gemini.maxTokens
          }
        });
      }
    } catch (modelSelectErr) {
      console.warn('⚠️ Could not select large model, falling back to configured model:', modelSelectErr.message);
      modelToUse = model;
    }

    // Generate summary
    const result = await modelToUse.generateContent(prompt);
    const summaryText = result.response.text();
    
    if (!summaryText || summaryText.trim().length === 0) {
      throw new Error('Gemini returned empty summary');
    }
    
    console.log(`✅ Summary generated: ${summaryText.length} characters`);
    
    // Parse the structured summary
    const structuredSummary = parseStructuredSummary(summaryText);
    
    // Create complete summary object
    const meetingSummary = {
      // Include an explicit speakerCount field so callers can display participant counts without parsing metadata
      speakerCount: combinedTranscript.participants ? combinedTranscript.participants.length : (combinedTranscript.statistics?.participantCount || 0),
      ...structuredSummary,
      metadata: {
        generatedAt: Date.now(),
        generatedBy: 'Gemini AI',
        model: config.gemini.model,
        transcriptLength: combinedTranscript.combinedText.length,
        participantCount: combinedTranscript.participants.length,
        totalWords: combinedTranscript.statistics.totalWords,
        averageConfidence: combinedTranscript.statistics.averageConfidence,
        meetingDuration: meetingInfo.duration || combinedTranscript.statistics.totalDuration,
        startTime: meetingInfo.startTime,
        endTime: meetingInfo.endTime
      },
      rawSummary: summaryText,
      participants: combinedTranscript.participants,
      statistics: combinedTranscript.statistics
    };
    
    console.log('📝 Summary structure created with metadata');
    
    return meetingSummary;
    
  } catch (error) {
    console.error('❌ Summary generation failed:', error.message);
    
    // Return fallback summary on error
    return createFallbackSummary(combinedTranscript, meetingInfo, error.message);
  }
}

/**
 * Parses the structured summary text from Gemini into organized sections
 * @param {string} summaryText - Raw summary text from Gemini
 * @returns {Object} Parsed summary sections
 */
function parseStructuredSummary(summaryText) {
  try {
    const sections = {
      briefOverview: '',
      keyDiscussionPoints: [],
      actionItems: [],
      decisionsMade: [],
      nextSteps: ''
    };
    
    // Split by sections using numbered headers
    const lines = summaryText.split('\\n').map(line => line.trim()).filter(line => line.length > 0);
    let currentSection = null;
    let currentContent = [];
    
    for (const line of lines) {
      // Check for section headers
      if (line.match(/^1\\.?\\s*brief\\s*overview/i)) {
        if (currentSection) {
          finalizeSectionContent(sections, currentSection, currentContent);
        }
        currentSection = 'briefOverview';
        currentContent = [];
      } else if (line.match(/^2\\.?\\s*key\\s*discussion\\s*points/i)) {
        if (currentSection) {
          finalizeSectionContent(sections, currentSection, currentContent);
        }
        currentSection = 'keyDiscussionPoints';
        currentContent = [];
      } else if (line.match(/^3\\.?\\s*action\\s*items/i)) {
        if (currentSection) {
          finalizeSectionContent(sections, currentSection, currentContent);
        }
        currentSection = 'actionItems';
        currentContent = [];
      } else if (line.match(/^4\\.?\\s*decisions\\s*made/i)) {
        if (currentSection) {
          finalizeSectionContent(sections, currentSection, currentContent);
        }
        currentSection = 'decisionsMade';
        currentContent = [];
      } else if (line.match(/^5\\.?\\s*next\\s*steps/i)) {
        if (currentSection) {
          finalizeSectionContent(sections, currentSection, currentContent);
        }
        currentSection = 'nextSteps';
        currentContent = [];
      } else if (currentSection && line.length > 0) {
        // Add content to current section
        currentContent.push(line);
      }
    }
    
    // Finalize the last section
    if (currentSection) {
      finalizeSectionContent(sections, currentSection, currentContent);
    }
    
    // If parsing failed, try to extract content more broadly
    if (!sections.briefOverview && !sections.keyDiscussionPoints.length) {
      return extractFallbackSections(summaryText);
    }
    
    return sections;
    
  } catch (error) {
    console.warn('⚠️ Failed to parse structured summary, using fallback parsing');
    return extractFallbackSections(summaryText);
  }
}

/**
 * Finalizes content for a specific section
 * @param {Object} sections - Sections object
 * @param {string} sectionName - Name of current section
 * @param {Array} content - Content lines for the section
 */
function finalizeSectionContent(sections, sectionName, content) {
  if (content.length === 0) return;
  
  if (sectionName === 'briefOverview' || sectionName === 'nextSteps') {
    // Join as paragraph
    sections[sectionName] = content.join(' ').replace(/^\\d+\\.\\s*/, '');
  } else {
    // Process as bullet points
    const bullets = content
      .filter(line => line.length > 0)
      .map(line => line.replace(/^[•\\-\\*]\\s*/, '').replace(/^\\d+\\.\\s*/, ''))
      .filter(bullet => bullet.length > 0);
    
    sections[sectionName] = bullets;
  }
}

/**
 * Extracts sections using fallback parsing when structured parsing fails
 * @param {string} summaryText - Raw summary text
 * @returns {Object} Extracted sections
 */
function extractFallbackSections(summaryText) {
  console.log('🔄 Using fallback summary parsing');
  
  // Split into paragraphs and try to identify content
  const paragraphs = summaryText.split('\\n\\n').filter(p => p.trim().length > 0);
  
  return {
    briefOverview: paragraphs[0] || summaryText.substring(0, 200) + '...',
    keyDiscussionPoints: paragraphs.slice(1, 4).map(p => p.trim()),
    actionItems: [],
    decisionsMade: [],
    nextSteps: paragraphs[paragraphs.length - 1] || 'No specific next steps identified.'
  };
}

/**
 * Creates a fallback summary when Gemini AI fails
 * @param {Object} combinedTranscript - Combined transcript
 * @param {Object} meetingInfo - Meeting information
 * @param {string} errorMessage - Error that occurred
 * @returns {Object} Fallback summary
 */
function createFallbackSummary(combinedTranscript, meetingInfo, errorMessage) {
  console.log('🔄 Creating fallback summary due to AI failure');
  
  const participantList = combinedTranscript.participants.map(p => p.username).join(', ');
  const wordCount = combinedTranscript.statistics.totalWords;
  const duration = formatDuration(meetingInfo.duration || combinedTranscript.statistics.totalDuration);
  
  return {
    briefOverview: `Meeting with ${combinedTranscript.participants.length} participants (${participantList}). Total discussion contained ${wordCount} words over ${duration}. AI summary generation failed: ${errorMessage}`,
    keyDiscussionPoints: [
      'AI summary generation unavailable',
      `${combinedTranscript.participants.length} participants contributed to the discussion`,
      `Average transcription confidence: ${combinedTranscript.statistics.averageConfidence}%`
    ],
    actionItems: ['Review raw transcript for specific action items'],
    decisionsMade: ['Unable to identify decisions - review transcript'],
    nextSteps: 'Manual review of transcript recommended',
    metadata: {
      generatedAt: Date.now(),
      generatedBy: 'Fallback System',
      model: 'fallback',
      transcriptLength: combinedTranscript.combinedText.length,
      participantCount: combinedTranscript.participants.length,
      totalWords: wordCount,
      averageConfidence: combinedTranscript.statistics.averageConfidence,
      meetingDuration: meetingInfo.duration || combinedTranscript.statistics.totalDuration,
      startTime: meetingInfo.startTime,
      endTime: meetingInfo.endTime,
      error: errorMessage
    },
    rawSummary: `Fallback summary generated due to AI error: ${errorMessage}`,
    participants: combinedTranscript.participants,
    statistics: combinedTranscript.statistics,
    isError: true
  };
}

/**
 * Formats duration in milliseconds to human-readable string
 * @param {number} duration - Duration in milliseconds
 * @returns {string} Formatted duration
 */
function formatDuration(duration) {
  if (!duration || duration <= 0) return '0 seconds';
  
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Validates summary quality and completeness
 * @param {Object} summary - Generated summary object
 * @returns {Object} Validation results
 */
export function validateSummary(summary) {
  const validation = {
    isValid: true,
    warnings: [],
    errors: []
  };
  
  // Check required sections
  if (!summary.briefOverview || summary.briefOverview.length < 10) {
    validation.errors.push('Brief overview is missing or too short');
    validation.isValid = false;
  }
  
  if (!summary.keyDiscussionPoints || summary.keyDiscussionPoints.length === 0) {
    validation.warnings.push('No key discussion points identified');
  }
  
  if (!summary.metadata || !summary.metadata.generatedAt) {
    validation.errors.push('Summary metadata is missing');
    validation.isValid = false;
  }
  
  if (summary.isError) {
    validation.warnings.push('Summary was generated using fallback method');
  }
  
  // Check content quality
  if (summary.briefOverview && summary.briefOverview.length > 1000) {
    validation.warnings.push('Brief overview is unusually long');
  }
  
  if (summary.keyDiscussionPoints && summary.keyDiscussionPoints.length > 20) {
    validation.warnings.push('Too many discussion points - summary may lack focus');
  }
  
  return validation;
}

/**
 * Gets Gemini service statistics and health
 * @returns {Object} Service statistics
 */
export function getGeminiStats() {
  return {
    initialized: !!model,
    model: config.gemini.model,
    temperature: config.gemini.temperature,
    maxTokens: config.gemini.maxTokens,
    apiKeyConfigured: !!config.apis.gemini
  };
}

/**
 * Tests Gemini connectivity with a simple prompt
 * @returns {Promise<boolean>} True if connection successful
 */
export async function testGeminiConnection() {
  try {
    if (!model) {
      initializeGemini();
    }
    
    const result = await model.generateContent('Hello, please respond with "Connection successful"');
    const response = result.response.text();
    
    console.log('✅ Gemini connection test successful');
    return response.toLowerCase().includes('connection successful');
    
  } catch (error) {
    console.error('❌ Gemini connection test failed:', error.message);
    return false;
  }
}

export default {
  initializeGemini,
  generateMeetingSummary,
  validateSummary,
  getGeminiStats,
  testGeminiConnection,
  formatDuration
};