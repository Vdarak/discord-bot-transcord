import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getCurrentStreamingStatus, getStreamingSessionStats } from '../utils/streamingAudioProcessor.js';
import { getStreamingStats } from '../utils/streamingTranscription.js';
import { embedColors, config } from '../config.js';

/**
 * Recording Status Command - Shows current recording status and statistics
 */

export const data = new SlashCommandBuilder()
  .setName('recording-status')
  .setDescription('Check if bot is currently recording and show statistics');

export async function execute(interaction) {
  try {
    console.log(`📊 [STATUS] Recording status command executed by ${interaction.user.tag}`);
    
    await interaction.deferReply({ flags: [64] }); // 64 = EPHEMERAL flag
    
    const streamingStatus = getCurrentStreamingStatus();
    const sessionStats = getStreamingSessionStats();
    const transcriptionStats = getStreamingStats();
    
    if (!streamingStatus) {
      // Not recording
      const embed = new EmbedBuilder()
        .setColor(embedColors.info)
        .setTitle('🔘 Recording Status: Inactive')
        .setDescription('Bot is not currently recording in any voice channel.')
        .addFields(
          { name: '📊 System Status', value: `**Active Sessions:** ${sessionStats.activeSessions}\\n**Total Streams:** ${sessionStats.totalStreams}\\n**System Ready:** ✅`, inline: true },
          { name: '⚡ Streaming Mode', value: `**AssemblyAI:** Ready\\n**Real-time:** Enabled\\n**File Storage:** Not needed`, inline: true }
        )
        .setFooter({ text: 'Use /join to start streaming transcription in your voice channel' })
        .setTimestamp();
      
      return await interaction.editReply({ embeds: [embed] });
    }
    
    // Currently recording
    const embed = new EmbedBuilder()
      .setColor(embedColors.recording)
      .setTitle('🔴 Recording Status: Active')
      .setDescription(`Currently recording in **${recordingStatus.channelName}**`)
      .addFields(
        { 
          name: '⏱️ Recording Info', 
          value: `**Duration:** ${formatDuration(recordingStatus.duration)}\\n**Started by:** ${recordingStatus.initiatedBy}\\n**Started at:** <t:${Math.floor(recordingStatus.startTime / 1000)}:F>`, 
          inline: true 
        },
        { 
          name: '👥 Participants', 
          value: `**Current:** ${recordingStatus.participants}\\n**Active Streams:** ${recordingStats.activeRecordings}`, 
          inline: true 
        },
        { 
          name: '📊 System Status', 
          value: `**Memory:** ${memoryUsage.heapUsed}/${memoryUsage.heapTotal} MB\\n**RSS:** ${memoryUsage.rss} MB\\n**Files:** ${cleanupStats.trackedFiles}`, 
          inline: false 
        }
      );
    
    // Add participant details if available
    if (recordingStats.users && recordingStats.users.length > 0) {
      const participantList = recordingStats.users
        .map(user => `• **${user.username}**: ${formatDuration(user.duration)}`)
        .join('\\n');
      
      embed.addFields({
        name: '🎤 Individual Recordings',
        value: participantList.substring(0, 1000),
        inline: false
      });
    }
    
    // Add transcription queue info
    if (transcriptionStats.activeTranscriptions > 0) {
      embed.addFields({
        name: '🔄 Transcription Queue',
        value: `**Active:** ${transcriptionStats.activeTranscriptions}/${transcriptionStats.maxConcurrent}\\n**Concurrent Requests:** ${transcriptionStats.concurrentRequests}`,
        inline: true
      });
    }
    
    embed.setFooter({ text: 'Use /stop to end recording and generate summary' })
         .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
    
    // Send status check notification to status channel
    try {
      const statusChannel = await interaction.client.channels.fetch(config.discord.statusChannelId);
      if (statusChannel) {
        const statusNotification = new EmbedBuilder()
          .setColor(embedColors.info)
          .setTitle('📊 Status Check Requested')
          .setDescription(`${interaction.user.tag} checked recording status`)
          .addFields(
            { 
              name: '📊 Current State', 
              value: streamingStatus ? 
                `🔴 **Recording Active**\\nSession: \`${streamingStatus.sessionId}\`\\nDuration: ${formatDuration(streamingStatus.duration)}\\nParticipants: ${streamingStatus.participants}` :
                `⚪ **No Active Recording**\\nBot is ready to start new session`,
              inline: false 
            }
          )
          .setTimestamp();
        
        await statusChannel.send({ embeds: [statusNotification] });
      }
    } catch (error) {
      console.warn('⚠️ [STATUS] Could not send status notification:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Recording status command error:', error);
    
    const errorEmbed = new EmbedBuilder()
      .setColor(embedColors.error)
      .setTitle('❌ Status Check Failed')
      .setDescription('Could not retrieve recording status.')
      .setTimestamp();
    
    try {
      await interaction.editReply({ embeds: [errorEmbed] });
    } catch (replyError) {
      console.error('❌ Could not send error reply:', replyError);
    }
  }
}

/**
 * Formats duration in milliseconds to readable string
 * @param {number} duration - Duration in milliseconds
 * @returns {string} Formatted duration
 */
function formatDuration(duration) {
  if (!duration || duration <= 0) return '0s';
  
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

export default {
  data,
  execute
};