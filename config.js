import 'dotenv/config';

/**
 * Bot Configuration and Environment Variables
 * Validates and exports all required environment variables with defaults
 */

// Validate required environment variables
const requiredEnvVars = {
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY
  // SUMMARY_CHANNEL_ID is optional because a sensible default is provided below
};

// Check for missing required variables
const missingVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingVars.forEach(varName => console.error(`   - ${varName}`));
  console.error('\nPlease check your .env file and ensure all required variables are set.');
  process.exit(1);
}

// Bot configuration object
export const config = {
  // Discord Bot Settings
  discord: {
    token: process.env.DISCORD_BOT_TOKEN,
  summaryChannelId: process.env.SUMMARY_CHANNEL_ID || '1431024855385374802', // Channel for meeting summaries ONLY
  transcriptChannelId: process.env.TRANSCRIPT_CHANNEL_ID || '1432537458993528923', // Channel where raw transcripts are attached
  statusChannelId: process.env.STATUS_CHANNEL_ID || '1431006332147863705', // Channel for bot status messages
    allowedRoleId: process.env.ALLOWED_ROLE_ID || null,
    clientId: process.env.DISCORD_CLIENT_ID || null
  },

  // API Keys
  apis: {
    assemblyAI: process.env.ASSEMBLYAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY
  },

  // Recording Settings
  recording: {
    maxDurationHours: parseInt(process.env.MAX_RECORDING_DURATION_HOURS) || 2,
    silenceTimeoutMinutes: parseInt(process.env.SILENCE_TIMEOUT_MINUTES) || 5,
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB) || 100,
    // If true, save raw recordings to disk and expose download API
    saveToDisk: process.env.SAVE_RECORDINGS === 'true' || false,
    sampleRate: 48000,
    bitDepth: 16,
    channels: 2
  },

  // File Management
  files: {
    tempDir: '/tmp',
    audioFormat: 'wav',
    recordingsDir: process.env.RECORDINGS_DIR || './recordings',
    cleanup: {
      immediate: true,
      onError: true
    }
  },

  // AssemblyAI Settings
  assemblyAI: {
    baseUrl: 'https://api.assemblyai.com/v2',
    uploadEndpoint: '/upload',
    transcriptEndpoint: '/transcript',
    pollingInterval: 3000, // 3 seconds
    maxConcurrent: 5,
    speechModel: 'universal',
    timeout: 300000 // 5 minutes
  },

  // Gemini Settings
  gemini: {
    // Default model; can be overridden with GEMINI_MODEL env var if desired
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite',
    // Alternative higher-capacity model to try for very large inputs/outputs
    largeModel: process.env.GEMINI_LARGE_MODEL || 'gemini-2.0-flash-lite',
    maxTokens: parseInt(process.env.GEMINI_MAX_TOKENS) || 8192,
    temperature: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.3,
    // If transcript length (characters) exceeds this threshold, summarizer may try `largeModel`
    largeInputThreshold: parseInt(process.env.GEMINI_LARGE_INPUT_THRESHOLD) || 50000,
    // Updated default prompt: request Markdown-formatted meeting summary suitable for direct
    // posting into Discord embeds. The model should return ONLY the Markdown content (no
    // surrounding JSON, code fences, or explanatory text). Structure the output exactly
    // using these headings so the bot can display the text verbatim in embeds:
    //
    // ## Meeting Summary
    // ### Brief Overview
    // (2-4 sentence high-level summary)
    //
    // ### Chronological Sections
    // - **<heading>**
    //   - point 1
    //   - point 2
    //
    // ### Action Items
    // - Action — Assignee: <name> — Due: <date>
    // OR: No action items identified.
    //
    // Output only Markdown; do not include any JSON or extra commentary.
    summaryPrompt: process.env.GEMINI_SUMMARY_PROMPT || `You are a professional meeting summarizer. Analyze the following Discord voice meeting transcript and return a Markdown-formatted meeting summary only — no JSON and no explanatory text.
## Meeting Summary

### Brief Overview
(Provide a 2-4 sentence high-level summary of meeting purpose and outcome)

### Chronological Sections
- **<heading>**
  - point 1
  - point 2

### Action Items
- Action — Assignee: <name> — Due: <date>
Or: No action items identified.

Output only the Markdown content above. Do not include any extra commentary, surrounding code fences, or JSON. Keep language concise and use bullets for lists.

Meeting Transcript:
`

  
  },

  // Server Settings
  server: {
    port: parseInt(process.env.PORT) || 3000,
    environment: process.env.NODE_ENV || 'development',
    healthCheck: true
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    timestamps: true,
    colors: process.env.NODE_ENV !== 'production'
  }
};

// Voice Connection Settings
export const voiceConfig = {
  selfDeaf: false,  // Bot must hear users to record them
  selfMute: true,   // Bot shouldn't speak during recording
  debug: config.server.environment === 'development'
};

// Audio Processing Settings
export const audioConfig = {
  sampleRate: config.recording.sampleRate,
  channels: config.recording.channels,
  bitDepth: config.recording.bitDepth,
  format: 's16le', // 16-bit little-endian PCM
  opusDecodingArgs: [
    '-f', 's16le',
    '-ar', config.recording.sampleRate.toString(),
    '-ac', config.recording.channels.toString()
  ]
};

// Discord Embed Colors
export const embedColors = {
  success: 0x00ff00,
  error: 0xff0000,
  warning: 0xffff00,
  info: 0x3498db,
  recording: 0xff6b6b,
  summary: 0x3498db
};

// Utility function to validate configuration
export function validateConfig() {
  const errors = [];

  // Validate numeric values
  if (config.recording.maxDurationHours <= 0 || config.recording.maxDurationHours > 24) {
    errors.push('MAX_RECORDING_DURATION_HOURS must be between 1 and 24');
  }

  if (config.recording.silenceTimeoutMinutes <= 0) {
    errors.push('SILENCE_TIMEOUT_MINUTES must be greater than 0');
  }

  if (config.recording.maxFileSizeMB <= 0) {
    errors.push('MAX_FILE_SIZE_MB must be greater than 0');
  }

  // Validate Discord Channel ID format
  if (!/^\d{17,19}$/.test(config.discord.summaryChannelId)) {
    errors.push('SUMMARY_CHANNEL_ID must be a valid Discord channel ID (17-19 digits)');
  }

  if (errors.length > 0) {
    console.error('❌ Configuration validation failed:');
    errors.forEach(error => console.error(`   - ${error}`));
    process.exit(1);
  }

  console.log('✅ Configuration validated successfully');
}

// Log configuration (excluding sensitive data)
export function logConfig() {
  if (config.server.environment === 'development') {
    console.log('🔧 Bot Configuration:');
    console.log(`   Environment: ${config.server.environment}`);
    console.log(`   Port: ${config.server.port}`);
    console.log(`   Max Recording Duration: ${config.recording.maxDurationHours} hours`);
    console.log(`   Silence Timeout: ${config.recording.silenceTimeoutMinutes} minutes`);
    console.log(`   Max File Size: ${config.recording.maxFileSizeMB} MB`);
    console.log(`   Summary Channel: ${config.discord.summaryChannelId}`);
    console.log(`   Allowed Role: ${config.discord.allowedRoleId || 'None (using permissions)'}`);
  }
}

export default config;