import { Client, Collection, Events, GatewayIntentBits, REST, Routes, ActivityType } from 'discord.js';
import { createServer } from 'http';
import { config, validateConfig, logConfig } from './config.js';
import { initializeGemini, testGeminiConnection } from './utils/summarizer.js';
import { setBotState } from './utils/presence.js';
import { validateStreamingConfig, stopAllStreamingSessions } from './utils/streamingAudioProcessor.js';
import { initializeStreamingClient } from './utils/streamingTranscription.js';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
    
    // Validate streaming configuration
    if (!validateStreamingConfig()) {
      throw new Error('Invalid streaming transcription configuration');
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
        GatewayIntentBits.GuildMessages
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
    
    // Set up streaming session cleanup handlers
    setupBotShutdownHandlers();
    
    // Login to Discord
    console.log('🔑 Logging in to Discord...');
    try {
      await client.login(config.discord.token);
    } catch (error) {
      console.error('❌ Failed to login to Discord:', error);
      console.log('🏥 Health check server will continue running...');
      // Don't exit - keep health check server running for Railway
    }
    
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    // Start health check anyway for Railway
    if (config.server.healthCheck) {
      console.log('🏥 Starting health check server (bot failed)...');
      startHealthCheckServer();
    }
    // Don't exit immediately - let Railway health check work
    console.log('⚠️ Bot startup failed, but keeping process alive for health checks');
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
      './commands/test.js',
      './commands/join.js',
      './commands/stop.js',
      './commands/recording-status.js',
      './commands/help.js'
    ];
    
    for (const file of commandFiles) {
      try {
        const commandModule = await import(file);
        const command = commandModule;
        
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
    
    console.log('🟢 Bot is fully operational!');
    // Ensure the bot has a consistent default name and neutral presence
    try {
      await setBotState(client, 'idle');
    } catch (err) {
      console.warn('⚠️ Could not set initial bot state:', err.message);
    }
  });
  
  // Slash command interaction handler
  client.on(Events.InteractionCreate, async (interaction) => {
    const startTime = Date.now();
    console.log(`⚡ [INTERACTION] Received ${interaction.commandName} at ${startTime}`);
    
    if (!interaction.isChatInputCommand()) return;
    
    const command = client.commands.get(interaction.commandName);
    
    if (!command) {
      console.warn(`❌ Unknown command: ${interaction.commandName}`);
      return;
    }
    
    const handlerTime = Date.now();
    console.log(`⚡ [INTERACTION] Handler ready after ${handlerTime - startTime}ms`);

    try {
      console.log(`🔧 Executing command: ${interaction.commandName} by ${interaction.user.tag} in ${interaction.guild?.name || 'DM'}`);
      await command.execute(interaction);
      
      const endTime = Date.now();
      console.log(`⚡ [INTERACTION] Command completed in ${endTime - startTime}ms`);
    } catch (error) {
      console.error(`❌ Command execution error (${interaction.commandName}):`, error);
      
      const errorMessage = {
        content: '❌ An error occurred while executing this command.',
        flags: [64] // EPHEMERAL flag
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
  const server = createServer(async (req, res) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
      
      if (req.url === '/health' || req.url === '/') {
        try {
          const healthData = {
            status: 'healthy',
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            bot: {
              connected: client?.isReady() || false,
              guilds: client?.guilds?.cache?.size || 0,
              user: client?.user?.tag || null
            },
            memory: {
              used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
              total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
            },
            version: '1.0.0',
            port: config.server.port
          };
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(healthData, null, 2));
          
          if (config.server.environment === 'development') {
            console.log(`🏥 Health check accessed: ${req.url}`);
          }
        } catch (error) {
          console.error('❌ Health check error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: error.message }));
        }
      } else if (req.url && req.method === 'GET' && req.url.startsWith('/recordings')) {
        try {
          const parts = req.url.split('/').filter(Boolean);
          // /recordings -> list
          if (parts.length === 1) {
            const recordingsDir = config.files && config.files.recordingsDir ? config.files.recordingsDir : join(__dirname, 'recordings');
            try {
              const files = await fs.readdir(recordingsDir);
              const wavFiles = files.filter(f => f.endsWith('.wav'));
              const list = wavFiles.map(f => ({ file: f, url: `/recordings/${encodeURIComponent(f)}` }));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(list, null, 2));
            } catch (dirErr) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify([]));
            }

            return;
          }

          // /recordings/:file -> download
          if (parts.length === 2) {
            const recordingsDir = config.files && config.files.recordingsDir ? config.files.recordingsDir : join(__dirname, 'recordings');
            const fileName = decodeURIComponent(parts[1]);
            const filePath = join(recordingsDir, fileName);
            try {
              const stat = await fs.stat(filePath);
              res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename="${fileName}"`
              });
              const readStream = fs.createReadStream(filePath);
              readStream.pipe(res);
              return;
            } catch (fileErr) {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('Not Found');
              return;
            }
          }
        } catch (error) {
          console.error('❌ [HTTP] Recordings endpoint error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });
    
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.warn(`⚠️ Port ${config.server.port} is already in use`);
        // Try a different port
        const altPort = parseInt(config.server.port) + 1;
        server.listen(altPort, '0.0.0.0', () => {
          console.log(`🏥 Health check server running on port ${altPort} (fallback)`);
        });
      } else {
        console.error('❌ Health check server error:', error);
      }
    });
    
    server.listen(config.server.port, '0.0.0.0', () => {
      console.log(`🏥 Health check server running on port ${config.server.port}`);
      console.log(`🌐 Health endpoint: http://0.0.0.0:${config.server.port}/health`);
    });
    
    return server;
    
  } catch (error) {
    console.error('❌ Failed to start health check server:', error);
    return null;
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
      
      // Stop all active streaming sessions
      await stopAllStreamingSessions();
      
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
    // Start health check server immediately for Railway
    console.log('🏥 Starting health check server for Railway...');
    startHealthCheckServer();
    
    // Start the Discord bot
    await startBot();
    
    // Start performance monitoring after bot is ready
    if (client) {
      client.once(Events.ClientReady, () => {
        setupPerformanceMonitoring();
      });
    }
    
  } catch (error) {
    console.error('💥 Fatal error starting bot:', error);
    // Keep the health check server running even if bot fails
    console.log('🏥 Keeping health check server alive...');
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