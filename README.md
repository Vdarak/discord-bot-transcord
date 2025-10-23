# Discord Voice Recording Bot

A production-ready Discord.js v14 bot that records voice channel meetings, transcribes them using AssemblyAI, generates AI summaries with Google Gemini, and posts results to a designated Discord channel. Optimized for Railway deployment.

![Bot Status](https://img.shields.io/badge/status-production--ready-green)
![Discord.js](https://img.shields.io/badge/discord.js-v14.14.1-blue)
![Node.js](https://img.shields.io/badge/node.js-%3E%3D18.0.0-brightgreen)
![Railway](https://img.shields.io/badge/deploy-railway-blueviolet)

## 🎯 Features

### Core Functionality
- **🎤 Multi-user Voice Recording** - Records each participant separately with high-quality audio
- **🤖 AI Transcription** - Powered by AssemblyAI with speaker identification
- **📝 Intelligent Summaries** - Google Gemini AI generates structured meeting summaries
- **🔄 Automated Workflow** - Complete pipeline from recording to summary posting
- **🧹 Smart Cleanup** - Automatic temporary file management and cleanup

### Discord Integration
- **⚡ Slash Commands** - Modern Discord interaction system
- **🔒 Permission Control** - Role-based or permission-based access control
- **📊 Real-time Status** - Live recording indicators and progress updates
- **🎨 Rich Embeds** - Beautiful, informative summary presentations
- **⚠️ Privacy Notices** - Clear recording indicators for all participants

### Technical Features
- **🚀 Railway Optimized** - Designed for Railway free tier constraints
- **💾 Memory Efficient** - Stream processing and immediate cleanup
- **🛡️ Error Handling** - Comprehensive error recovery and fallback systems
- **📈 Performance Monitoring** - Built-in memory and performance tracking
- **🔧 Health Checks** - HTTP health endpoint for deployment monitoring

## 📋 Requirements

### Bot Setup
- Discord Bot Token with necessary permissions
- AssemblyAI API key for transcription
- Google Gemini API key for summarization
- Node.js 18+ environment

### Discord Permissions
The bot requires these permissions in your Discord server:
- `Send Messages`
- `Use Slash Commands`
- `Connect` (to voice channels)
- `Speak` (in voice channels)
- `View Channels`
- `Manage Channels` (for users to access commands)

## 🚀 Quick Start

### 1. Clone and Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/discord-voice-bot.git
cd discord-voice-bot

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

### 2. Configure Environment Variables

Edit `.env` with your API keys and settings:

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
ASSEMBLYAI_API_KEY=c77ee8f2bf644bad9c4215b325fb49c5
GEMINI_API_KEY=your_gemini_api_key
SUMMARY_CHANNEL_ID=your_summary_channel_id

# Optional configurations
ALLOWED_ROLE_ID=role_id_for_command_access
MAX_RECORDING_DURATION_HOURS=2
SILENCE_TIMEOUT_MINUTES=5
MAX_FILE_SIZE_MB=100
```

### 3. Local Development

```bash
# Start development server with auto-reload
npm run dev

# Or start production server
npm start
```

### 4. Deploy to Railway

See [Railway Deployment Guide](./RAILWAY_DEPLOYMENT.md) for detailed instructions.

## 📚 Usage Guide

### Starting a Recording

1. **Join a voice channel** with other participants
2. **Use `/join` command** in any text channel
3. **Bot joins and starts recording** all participants separately
4. **Recording indicator** shows bot status as "🔴 Recording"

### Stopping and Processing

1. **Use `/stop` command** when meeting is finished
2. **Processing begins automatically**:
   - Audio files are converted to WAV format
   - Files uploaded to AssemblyAI for transcription
   - Transcripts combined and sent to Gemini for summarization
   - Final summary posted to designated channel
3. **Cleanup** - All temporary files automatically deleted

### Additional Commands

- **`/recording-status`** - Check current recording status and statistics
- **`/help`** - Display usage instructions and bot information

## 🏗️ Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Discord Bot   │    │  Audio Pipeline │    │ AI Processing   │
│                 │    │                 │    │                 │
│ • Slash Commands│───▶│ • Voice Recording│───▶│ • AssemblyAI    │
│ • Voice Events  │    │ • PCM → WAV     │    │ • Transcription │
│ • Embed Posting │    │ • File Management│    │ • Gemini Summary│
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │    Railway Platform     │
                    │                         │
                    │ • Ephemeral Storage     │
                    │ • Memory Optimization   │
                    │ • Health Monitoring     │
                    │ • Auto-scaling          │
                    └─────────────────────────┘
```

## 📁 Project Structure

```
discord-voice-bot/
├── commands/                   # Discord slash commands
│   ├── join.js                # Start recording command
│   ├── stop.js                # Stop recording and process
│   ├── recording-status.js    # Check recording status
│   └── help.js                # Help and usage info
├── utils/                     # Core utilities
│   ├── audioProcessor.js      # Voice recording and conversion
│   ├── transcription.js       # AssemblyAI integration
│   ├── summarizer.js          # Google Gemini integration
│   └── cleanup.js             # File management and cleanup
├── config.js                  # Configuration and validation
├── index.js                   # Main bot entry point
├── package.json               # Dependencies and scripts
├── .env.example               # Environment template
├── railway.json               # Railway deployment config
├── Procfile                   # Process definition
├── RAILWAY_DEPLOYMENT.md      # Deployment guide
└── README.md                  # This file
```

## 🔧 Configuration Options

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | ✅ | - | Discord bot token |
| `ASSEMBLYAI_API_KEY` | ✅ | - | AssemblyAI API key |
| `GEMINI_API_KEY` | ✅ | - | Google Gemini API key |
| `SUMMARY_CHANNEL_ID` | ✅ | - | Discord channel for summaries |
| `ALLOWED_ROLE_ID` | ❌ | - | Role ID for command access |
| `MAX_RECORDING_DURATION_HOURS` | ❌ | `2` | Maximum recording length |
| `SILENCE_TIMEOUT_MINUTES` | ❌ | `5` | Auto-stop after silence |
| `MAX_FILE_SIZE_MB` | ❌ | `100` | Max file size per user |
| `NODE_ENV` | ❌ | `development` | Environment mode |
| `PORT` | ❌ | `3000` | Health check server port |

### Audio Settings

- **Sample Rate**: 48kHz (Discord standard)
- **Bit Depth**: 16-bit
- **Channels**: Stereo (2 channels)
- **Format**: WAV (for AssemblyAI compatibility)
- **Codec**: Opus (Discord native) → PCM → WAV

## 🛠️ Development

### Prerequisites

- Node.js 18+ 
- Discord Developer Account
- AssemblyAI Account
- Google AI Studio Account (for Gemini API)

### Local Setup

```bash
# Clone repository
git clone <your-repo-url>
cd discord-voice-bot

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Start development server
npm run dev
```

### Testing

```bash
# Test with single user (yourself)
/join  # In voice channel alone
/stop  # Immediate stop

# Test with multiple users
# Have friends join voice channel
/join  # Start recording
# Conduct test conversation
/stop  # Process and check summary

# Test error scenarios
# Invalid API keys, network failures, etc.
```

## 🚨 Error Handling

The bot includes comprehensive error handling for:

- **Voice Connection Issues** - Automatic reconnection and fallback
- **API Failures** - Retry logic and graceful degradation  
- **File System Errors** - Cleanup and recovery procedures
- **Memory Limits** - Monitoring and prevention
- **Rate Limiting** - Queue management and throttling

### Common Issues and Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| "Bot not joining voice" | Missing permissions | Check Connect/Speak permissions |
| "Transcription failed" | Invalid API key | Verify AssemblyAI key |
| "Summary generation error" | Gemini API issue | Check Gemini API key and quota |
| "Memory limit exceeded" | Large recordings | Reduce file size limits |
| "Files not cleaned up" | Process crash | Emergency cleanup on restart |

## 📊 Performance Optimization

### Railway Free Tier Optimizations

- **Memory Usage**: Kept under 400MB with monitoring
- **File Storage**: Immediate cleanup after processing
- **CPU Efficiency**: Stream processing without loading full files
- **Request Limiting**: Controlled concurrent API requests

### Monitoring

- Health check endpoint: `/health`
- Memory usage alerts
- Performance metrics logging
- Error rate tracking

## 🔒 Security and Privacy

### Data Handling
- **Temporary Storage Only** - No persistent audio storage
- **Automatic Cleanup** - Files deleted after processing
- **Encrypted Transmission** - HTTPS/WSS for all API calls
- **Access Control** - Permission-based command access

### Privacy Features
- **Recording Indicators** - Clear visual/text warnings
- **Consent Notice** - Automatic notifications to participants  
- **Data Minimization** - Only necessary data processed
- **Secure APIs** - Encrypted communication with services

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines
- Follow existing code style and patterns
- Add error handling for new features
- Update documentation for changes
- Test thoroughly before submitting

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Discord.js** - Excellent Discord API wrapper
- **AssemblyAI** - High-quality speech transcription
- **Google Gemini** - Advanced AI summarization
- **Railway** - Simple and reliable hosting platform
- **Contributors** - Everyone who helps improve this project

## 📞 Support

### Getting Help
1. **Check this README** for common solutions
2. **Review [Railway Deployment Guide](./RAILWAY_DEPLOYMENT.md)** for deployment issues
3. **Check bot logs** in Railway dashboard
4. **Test API keys** individually to isolate issues

### Reporting Issues
- Use GitHub Issues for bug reports
- Include error logs and reproduction steps
- Specify environment (local/Railway) and configuration

### Feature Requests
- Open GitHub Issues with enhancement label
- Describe use case and expected behavior
- Consider contributing the feature yourself!

---

**Made with ❤️ for the Discord community**

*This bot is designed to enhance meeting productivity while respecting privacy and following best practices for Discord bot development.*