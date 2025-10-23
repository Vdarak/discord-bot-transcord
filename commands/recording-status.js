import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getCurrentRecordingStatus } from './join.js';
import { embedColors } from '../config.js';
import { getRecordingStats, getMemoryUsage } from '../utils/audioProcessor.js';
import { getTranscriptionStats } from '../utils/transcription.js';
import { getCleanupStats } from '../utils/cleanup.js';

/**
 * Recording Status Command - Shows current recording status and statistics
 */

export const data = new SlashCommandBuilder()
  .setName('recording-status')
  .setDescription('Check if bot is currently recording and show statistics');

export async function execute(interaction) {
  try {
    console.log(`📊 Recording status command executed by ${interaction.user.tag}`);
    
    await interaction.deferReply({ flags: [64] }); // 64 = EPHEMERAL flag
    
    const recordingStatus = getCurrentRecordingStatus();
    const recordingStats = getRecordingStats();
    const memoryUsage = getMemoryUsage();
    const transcriptionStats = getTranscriptionStats();
    const cleanupStats = getCleanupStats();
    
    if (!recordingStatus) {
      // Not recording
      const embed = new EmbedBuilder()
        .setColor(embedColors.info)
        .setTitle('🔘 Recording Status: Inactive')
        .setDescription('Bot is not currently recording in any voice channel.')
        .addFields(
          { name: '📊 System Status', value: `**Memory Usage:** ${memoryUsage.heapUsed} MB\\n**Tracked Files:** ${cleanupStats.trackedFiles}\\n**Active Transcriptions:** ${transcriptionStats.activeTranscriptions}`, inline: true },
          { name: '🎵 Audio System', value: `**Active Streams:** ${recordingStats.activeRecordings}\\n**System Ready:** ✅`, inline: true }
        )
        .setFooter({ text: 'Use /join to start recording in your voice channel' })
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