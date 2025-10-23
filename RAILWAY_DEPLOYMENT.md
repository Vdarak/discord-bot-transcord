# Railway Deployment Guide

This file contains Railway-specific deployment instructions for the Discord Voice Recording Bot.

## Prerequisites

1. **Railway Account**: Create an account at [railway.app](https://railway.app)
2. **GitHub Repository**: Push your code to a GitHub repository
3. **API Keys**: Ensure you have valid API keys for Discord, AssemblyAI, and Google Gemini

## Deployment Steps

### 1. Create New Railway Project

1. Log in to Railway dashboard
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your bot repository
5. Railway will automatically detect it's a Node.js project

### 2. Configure Environment Variables

In Railway dashboard, go to your project → Variables tab and add:

```
DISCORD_BOT_TOKEN=your_bot_token_here
ASSEMBLYAI_API_KEY=c77ee8f2bf644bad9c4215b325fb49c5
GEMINI_API_KEY=your_gemini_api_key_here
SUMMARY_CHANNEL_ID=your_channel_id_here
NODE_ENV=production
PORT=3000
```

Optional variables:
```
DISCORD_CLIENT_ID=your_bot_client_id
ALLOWED_ROLE_ID=role_id_for_command_access
MAX_RECORDING_DURATION_HOURS=2
SILENCE_TIMEOUT_MINUTES=5
MAX_FILE_SIZE_MB=100
```

### 3. Deployment Configuration

Railway will use these files automatically:
- `railway.json` - Railway configuration
- `Procfile` - Process definition
- `package.json` - Dependencies and scripts

### 4. Deploy

1. Push changes to your GitHub repository
2. Railway will automatically detect changes and deploy
3. Monitor deployment in Railway logs
4. Check health endpoint: `https://your-app.railway.app/health`

## Railway Free Tier Considerations

### Resource Limits
- **Memory**: 512MB RAM limit
- **CPU**: Shared CPU resources
- **Storage**: Ephemeral (files deleted on restart)
- **Execution Time**: 500 hours per month
- **Bandwidth**: Limited

### Optimizations Applied

1. **Memory Management**
   - Immediate file cleanup after processing
   - Stream processing to avoid loading large files
   - Memory monitoring and warnings

2. **File Storage**
   - Uses `/tmp` directory (ephemeral)
   - Automatic cleanup on errors
   - Size limits enforced

3. **Error Handling**
   - Graceful degradation when resources limited
   - Fallback summary generation
   - Automatic reconnection on failures

## Monitoring

### Health Check
- Endpoint: `https://your-app.railway.app/health`
- Returns bot status, memory usage, uptime

### Logs
Access logs in Railway dashboard:
- Deployment logs
- Application logs
- Error tracking

### Key Metrics to Monitor
- Memory usage (keep under 400MB)
- Active recordings count
- File cleanup success rate
- Transcription success rate

## Troubleshooting

### Common Issues

1. **Memory Limit Exceeded**
   ```
   Error: JavaScript heap out of memory
   ```
   - Reduce MAX_FILE_SIZE_MB
   - Check for memory leaks in active recordings
   - Restart service

2. **File System Errors**
   ```
   ENOSPC: no space left on device
   ```
   - Temporary files not cleaned up
   - Force cleanup with emergency cleanup
   - Check cleanup handlers

3. **Voice Connection Issues**
   ```
   Could not establish voice connection
   ```
   - Check bot permissions in voice channels
   - Verify opus codec installation
   - Check Discord API status

4. **API Rate Limits**
   ```
   AssemblyAI rate limit exceeded
   ```
   - Reduce concurrent transcriptions
   - Implement request queuing
   - Check API key limits

### Performance Optimization

1. **Reduce Memory Usage**
   - Lower recording quality if needed
   - Implement streaming uploads
   - Reduce concurrent operations

2. **Improve Response Time**
   - Pre-warm connections
   - Cache frequently used data
   - Optimize embed generation

## Scaling Considerations

### When to Upgrade
- Memory usage consistently > 400MB
- Frequent rate limit errors
- Multiple simultaneous recordings needed

### Alternative Deployment Options
- Railway Pro plan (more resources)
- Self-hosted VPS
- Other cloud platforms (Heroku, DigitalOcean)

## Security

### Environment Variables
- Never commit API keys to repository
- Use Railway's variable encryption
- Rotate keys regularly

### Bot Permissions
- Minimum required permissions only
- Regular permission audits
- Monitor bot usage across servers

## Backup and Recovery

### Data Backup
- No persistent data stored (by design)
- Configuration backup via environment variables
- Code backup via GitHub repository

### Disaster Recovery
- Railway automatic restarts on failure
- Health check monitoring
- Graceful shutdown procedures

## Support

### Railway Support
- Documentation: [docs.railway.app](https://docs.railway.app)
- Discord: Railway Discord server
- GitHub: Railway GitHub issues

### Bot-Specific Issues
- Check application logs first
- Verify API key validity
- Test components individually
- Review configuration settings

## Updates and Maintenance

### Automatic Updates
- Railway deploys on GitHub pushes
- Monitor deployment success
- Test new features in staging

### Manual Maintenance
- Regular dependency updates
- API key rotation
- Performance monitoring
- Usage analytics review