import { Client, Collection, Events, GatewayIntentBits, REST, Routes, ActivityType } from 'discord.js';
import { config, validateConfig, logConfig } from './config.js';
import { setupCleanupHandlers, emergencyCleanup } from './utils/cleanup.js';
import { initializeGemini, testGeminiConnection } from './utils/summarizer.js';
import { validateAudioConfig } from './utils/audioProcessor.js';
import { cancelAllTranscriptions } from './utils/transcription.js';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ffmpegPath from 'ffmpeg-static';

// Set ffmpeg path for Railway compatibility
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

/**
 * Discord Voice Recording Bot - Main Entry Point
 * Handles bot initialization, command registration, and event management
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Bot instance
let client;
let isShuttingDown = false;

/**
 * Initializes and starts the Discord bot
 */
async function startBot() {
  try {
    console.log('🚀 Starting Discord Voice Recording Bot...');
    
    // Validate configuration
    validateConfig();
    logConfig();
    
    // Validate audio configuration
    if (!validateAudioConfig()) {
      throw new Error('Invalid audio configuration');
    }
    
    // Initialize Gemini AI
    try {
      initializeGemini();
      console.log('🤖 Testing Gemini AI connection...');
      const geminiWorking = await testGeminiConnection();
      if (!geminiWorking) {
        console.warn('⚠️ Gemini AI connection test failed - summaries may not work properly');
      }
    } catch (error) {
      console.warn('⚠️ Gemini AI initialization failed:', error.message);
    }
    
    // Create Discord client
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ],
      presence: {
        activities: [{ 
          name: 'voice channels for /join command', 
          type: ActivityType.Watching 
        }],
        status: 'online',
      }
    });
    
    // Load commands
    await loadCommands();
    
    // Set up event handlers
    setupEventHandlers();
    
    // Set up cleanup handlers for graceful shutdown
    setupCleanupHandlers();
    setupBotShutdownHandlers();
    
    // Login to Discord
    console.log('🔑 Logging in to Discord...');
    await client.login(config.discord.token);
    
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

/**
 * Loads all command files and registers them
 */
async function loadCommands() {
  try {
    console.log('📋 Loading commands...');
    
    client.commands = new Collection();
    const commands = [];
    
    // Load command files
    const commandFiles = [
      './commands/join.js',
      './commands/stop.js',
      './commands/recording-status.js',
      './commands/help.js'
    ];
    
    for (const file of commandFiles) {
      try {
        const commandModule = await import(file);
        const command = commandModule.default;
        
        if (command && command.data && command.execute) {
          client.commands.set(command.data.name, command);
          commands.push(command.data.toJSON());
          console.log(`✅ Loaded command: ${command.data.name}`);
        } else {
          console.warn(`⚠️ Invalid command file: ${file}`);
        }
      } catch (error) {
        console.error(`❌ Failed to load command ${file}:`, error.message);
      }
    }
    
    console.log(`📋 Loaded ${client.commands.size} commands`);
    return commands;
    
  } catch (error) {
    console.error('❌ Failed to load commands:', error);
    throw error;
  }
}

/**
 * Sets up Discord event handlers
 */
function setupEventHandlers() {
  // Bot ready event
  client.once(Events.ClientReady, async () => {
    console.log(`✅ Bot ready! Logged in as ${client.user.tag}`);
    console.log(`🌐 Connected to ${client.guilds.cache.size} servers`);
    
    // Register slash commands
    try {
      await registerSlashCommands();
    } catch (error) {
      console.error('❌ Failed to register slash commands:', error);
    }
    
    // Start health check server if configured
    if (config.server.healthCheck) {
      startHealthCheckServer();
    }
    
    console.log('🟢 Bot is fully operational!');
  });
  
  // Slash command interaction handler
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const command = client.commands.get(interaction.commandName);
    
    if (!command) {
      console.warn(`❌ Unknown command: ${interaction.commandName}`);
      return;
    }
    
    try {
      console.log(`🔧 Executing command: ${interaction.commandName} by ${interaction.user.tag} in ${interaction.guild?.name || 'DM'}`);
      await command.execute(interaction);
    } catch (error) {
      console.error(`❌ Command execution error (${interaction.commandName}):`, error);
      
      const errorMessage = {
        content: '❌ An error occurred while executing this command.',
        ephemeral: true
      };
      
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply(errorMessage);
        } else {
          await interaction.reply(errorMessage);
        }
      } catch (replyError) {
        console.error('❌ Could not send error message to user:', replyError);
      }
    }
  });
  
  // Voice state update handler (managed by join command)
  // This is set up dynamically in the join command
  
  // Error handling
  client.on(Events.Error, (error) => {
    console.error('❌ Discord client error:', error);
  });
  
  client.on(Events.Warn, (warning) => {
    console.warn('⚠️ Discord client warning:', warning);
  });
  
  // Debug logging in development
  if (config.server.environment === 'development') {
    client.on(Events.Debug, (debug) => {
      if (debug.includes('heartbeat')) return; // Skip heartbeat spam
      console.log(`🐛 Debug: ${debug}`);
    });
  }
  
  // Guild events for logging
  client.on(Events.GuildCreate, (guild) => {
    console.log(`➕ Bot added to guild: ${guild.name} (${guild.id})`);
  });
  
  client.on(Events.GuildDelete, (guild) => {
    console.log(`➖ Bot removed from guild: ${guild.name} (${guild.id})`);
  });
}

/**
 * Registers slash commands with Discord
 */
async function registerSlashCommands() {
  try {
    console.log('🔄 Registering slash commands...');
    
    const commands = Array.from(client.commands.values()).map(cmd => cmd.data.toJSON());
    
    const rest = new REST().setToken(config.discord.token);
    
    if (config.discord.clientId) {
      // Register globally if client ID is provided
      const data = await rest.put(
        Routes.applicationCommands(config.discord.clientId),
        { body: commands }
      );
      console.log(`✅ Registered ${data.length} global slash commands`);
    } else {
      // Register for each guild individually
      console.log('🔄 Registering commands per guild...');
      let totalRegistered = 0;
      
      for (const guild of client.guilds.cache.values()) {
        try {
          const data = await rest.put(
            Routes.applicationGuildCommands(client.user.id, guild.id),
            { body: commands }
          );
          totalRegistered += data.length;
        } catch (error) {
          console.warn(`⚠️ Failed to register commands in ${guild.name}:`, error.message);
        }
      }
      
      console.log(`✅ Registered commands in ${client.guilds.cache.size} guilds (${totalRegistered} total)`);
    }
    
  } catch (error) {
    console.error('❌ Failed to register slash commands:', error);
    throw error;
  }
}

/**
 * Starts a simple health check HTTP server for Railway
 */
function startHealthCheckServer() {
  try {
    // Import http module dynamically to avoid loading if not needed
    import('http').then(({ createServer }) => {
      const server = createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'healthy',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            bot: {
              connected: client?.isReady() || false,
              guilds: client?.guilds.cache.size || 0,
              user: client?.user?.tag || null
            },
            memory: process.memoryUsage(),
            version: '1.0.0'
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });
      
      server.listen(config.server.port, () => {
        console.log(`🏥 Health check server running on port ${config.server.port}`);
      });
      
      server.on('error', (error) => {
        console.warn('⚠️ Health check server error:', error.message);
      });
    });
  } catch (error) {
    console.warn('⚠️ Could not start health check server:', error.message);
  }
}

/**
 * Sets up bot-specific shutdown handlers
 */
function setupBotShutdownHandlers() {
  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) {
      console.log('🛑 Forced shutdown');
      process.exit(1);
    }
    
    isShuttingDown = true;
    console.log(`\\n🛑 Received ${signal}, shutting down gracefully...`);
    
    try {
      // Set bot status to indicate shutdown
      if (client && client.isReady()) {
        await client.user.setPresence({
          activities: [{ name: 'Shutting down...', type: ActivityType.Custom }],
          status: 'dnd'
        });
      }
      
      // Cancel active transcriptions
      cancelAllTranscriptions();
      
      // Emergency cleanup of files
      await emergencyCleanup();
      
      // Disconnect from Discord
      if (client) {
        console.log('🔌 Disconnecting from Discord...');
        client.destroy();
      }
      
      console.log('✅ Graceful shutdown completed');
      process.exit(0);
      
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };
  
  // Handle various shutdown signals
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
  
  // Handle unhandled errors
  process.on('uncaughtException', async (error) => {
    console.error('💥 Uncaught Exception:', error);
    await gracefulShutdown('UNCAUGHT_EXCEPTION');
  });
  
  process.on('unhandledRejection', async (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    await gracefulShutdown('UNHANDLED_REJECTION');
  });
}

/**
 * Monitors bot performance and logs warnings
 */
function setupPerformanceMonitoring() {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    
    // Warn if memory usage is high (Railway free tier has 512MB limit)
    if (memUsedMB > 400) {
      console.warn(`⚠️ High memory usage: ${memUsedMB}MB / ${memTotalMB}MB`);
    }
    
    // Log stats in development
    if (config.server.environment === 'development') {
      console.log(`📊 Memory: ${memUsedMB}MB, Guilds: ${client?.guilds.cache.size || 0}, Uptime: ${Math.round(process.uptime())}s`);
    }
  }, 60000); // Every minute
}

/**
 * Main execution
 */
async function main() {
  try {
    await startBot();
    
    // Start performance monitoring after bot is ready
    if (client) {
      client.once(Events.ClientReady, () => {
        setupPerformanceMonitoring();
      });
    }
    
  } catch (error) {
    console.error('💥 Fatal error starting bot:', error);
    process.exit(1);
  }
}

// Start the bot
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 Fatal startup error:', error);
    process.exit(1);
  });
}

export { client, startBot };
export default { client, startBot };