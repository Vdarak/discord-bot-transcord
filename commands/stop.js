import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { config, embedColors } from '../config.js';
import { getCurrentRecordingStatus } from './join.js';
import { stopAllRecordings, processAllRecordings } from '../utils/audioProcessor.js';
import { transcribeMultipleFiles, combineTranscripts } from '../utils/transcription.js';
import { generateMeetingSummary } from '../utils/summarizer.js';
import { cleanupRecordingFiles } from '../utils/cleanup.js';

/**
 * Stop Command - Stops recording and processes transcription/summary
 */

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop the current recording and generate meeting summary')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
  try {
    console.log(`⏹️ Stop command executed by ${interaction.user.tag} in ${interaction.guild.name}`);
    
    // Defer reply for long processing time
    await interaction.deferReply({ flags: [] });
    
    // Permission check
    if (!hasPermission(interaction)) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('❌ Permission Denied', 'You need "Manage Channels" permission or the required role to use this command.')]
      });
    }
    
    // Check if bot is recording
    const recordingStatus = getCurrentRecordingStatus();
    if (!recordingStatus) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('⚠️ Not Recording', 'Bot is not currently recording. Use `/join` to start a recording first.')]
      });
    }
    
    // Send initial processing message
    const processingEmbed = new EmbedBuilder()
      .setColor(embedColors.warning)
      .setTitle('⏹️ Recording Stopped')
      .setDescription('Processing transcription and generating summary...')
      .addFields(
        { name: '📊 Recording Stats', value: `Duration: ${formatDuration(recordingStatus.duration)}\\nParticipants: ${recordingStatus.participants}`, inline: true },
        { name: '🔄 Processing Status', value: '• Stopping audio streams...\\n• Converting audio files...\\n• Uploading to AssemblyAI...\\n• Waiting for transcription...\\n• Generating AI summary...', inline: false }
      )
      .setFooter({ text: 'This may take several minutes depending on recording length' })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [processingEmbed] });
    
    let recordingFiles = [];
    let wavFiles = [];
    let transcriptionResults = null;
    let combinedTranscript = null;
    let meetingSummary = null;
    let processingError = null;
    
    try {
      // Step 1: Stop all recordings
      console.log('🔄 Step 1: Stopping all recordings...');
      recordingFiles = await stopAllRecordings();
      
      if (recordingFiles.length === 0) {
        throw new Error('No recordings found to process');
      }
      
      // Update progress
      await updateProcessingProgress(interaction, 'Stopped recordings', '• ✅ Stopping audio streams\\n• 🔄 Converting audio files...\\n• ⏳ Uploading to AssemblyAI...\\n• ⏳ Waiting for transcription...\\n• ⏳ Generating AI summary...');
      
      // Step 2: Process audio files (PCM to WAV conversion)
      console.log('🔄 Step 2: Processing audio files...');
      wavFiles = await processAllRecordings(recordingFiles);
      
      if (wavFiles.length === 0) {
        throw new Error('No audio files could be processed');
      }
      
      // Update progress
      await updateProcessingProgress(interaction, 'Converted audio files', '• ✅ Stopping audio streams\\n• ✅ Converting audio files\\n• 🔄 Uploading to AssemblyAI...\\n• ⏳ Waiting for transcription...\\n• ⏳ Generating AI summary...');
      
      // Step 3: Transcribe with AssemblyAI
      console.log('🔄 Step 3: Transcribing audio...');
      transcriptionResults = await transcribeMultipleFiles(wavFiles);
      
      if (transcriptionResults.successful.length === 0) {
        throw new Error('No transcriptions were successful');
      }
      
      // Update progress
      await updateProcessingProgress(interaction, 'Transcription completed', '• ✅ Stopping audio streams\\n• ✅ Converting audio files\\n• ✅ Uploading to AssemblyAI\\n• ✅ Transcription completed\\n• 🔄 Generating AI summary...');
      
      // Step 4: Combine transcripts
      console.log('🔄 Step 4: Combining transcripts...');
      const meetingMetadata = {
        startTime: recordingStatus.startTime,
        endTime: Date.now(),
        duration: Date.now() - recordingStatus.startTime,
        channelName: recordingStatus.channelName,
        initiatedBy: recordingStatus.initiatedBy
      };
      
      combinedTranscript = combineTranscripts(transcriptionResults.successful, meetingMetadata);
      
      // Step 5: Generate AI summary
      console.log('🔄 Step 5: Generating AI summary...');
      meetingSummary = await generateMeetingSummary(combinedTranscript, meetingMetadata);
      
      // Update progress - completed
      await updateProcessingProgress(interaction, 'Summary generated', '• ✅ Stopping audio streams\\n• ✅ Converting audio files\\n• ✅ Uploading to AssemblyAI\\n• ✅ Transcription completed\\n• ✅ AI summary generated\\n• 🔄 Posting results...');
      
    } catch (error) {
      console.error('❌ Processing error:', error);
      processingError = error.message;
    }
    
    try {
      // Step 6: Post results to summary channel
      console.log('🔄 Step 6: Posting results...');
      
      const summaryChannel = await interaction.client.channels.fetch(config.discord.summaryChannelId);
      if (!summaryChannel) {
        throw new Error(`Summary channel not found: ${config.discord.summaryChannelId}`);
      }
      
      // Create and send summary embed
      const summaryEmbed = await createSummaryEmbed(meetingSummary, combinedTranscript, recordingStatus, processingError);
      const summaryMessage = await summaryChannel.send({ embeds: [summaryEmbed] });
      
      // Send status to designated status channel
      try {
        const statusChannel = await interaction.client.channels.fetch(config.discord.statusChannelId);
        if (statusChannel && statusChannel.id !== summaryChannel.id) {
          const statusEmbed = new EmbedBuilder()
            .setColor(processingError ? embedColors.warning : embedColors.success)
            .setTitle('📝 Recording Processed')
            .setDescription(`Meeting recording completed and summary generated`)
            .addFields(
              { name: '📊 Stats', value: `Duration: ${formatDuration(recordingStatus.duration)}\\nParticipants: ${recordingStatus.participants}`, inline: true },
              { name: '📝 Summary', value: `Posted in <#${config.discord.summaryChannelId}>`, inline: true }
            )
            .setTimestamp();
          
          await statusChannel.send({ embeds: [statusEmbed] });
        }
      } catch (error) {
        console.warn('⚠️ Could not send status message:', error.message);
      }
      
      // Send completion message
      const completionEmbed = new EmbedBuilder()
        .setColor(processingError ? embedColors.warning : embedColors.success)
        .setTitle(processingError ? '⚠️ Processing Completed with Errors' : '✅ Processing Complete')
        .setDescription(processingError 
          ? `Recording processed with errors. Summary posted in <#${config.discord.summaryChannelId}>`
          : `Meeting summary successfully posted in <#${config.discord.summaryChannelId}>`
        )
        .addFields(
          { name: '📊 Final Stats', value: createFinalStatsText(recordingFiles, transcriptionResults, combinedTranscript), inline: false }
        );
      
      if (processingError) {
        completionEmbed.addFields({ name: '❌ Error Details', value: processingError.substring(0, 1000), inline: false });
      }
      
      completionEmbed.addFields({ name: '🔗 Summary Link', value: `[View Summary](${summaryMessage.url})`, inline: true });
      completionEmbed.setTimestamp();
      
      await interaction.editReply({ embeds: [completionEmbed] });
      
      console.log('✅ Stop command completed successfully');
      
    } catch (postError) {
      console.error('❌ Error posting results:', postError);
      
      const errorEmbed = new EmbedBuilder()
        .setColor(embedColors.error)
        .setTitle('❌ Processing Failed')
        .setDescription('Failed to post summary to designated channel.')
        .addFields(
          { name: 'Error Details', value: postError.message.substring(0, 1000), inline: false },
          { name: 'Raw Data Available', value: combinedTranscript ? 'Transcript data is available for manual review' : 'No transcript data available', inline: false }
        )
        .setTimestamp();
      
      await interaction.editReply({ embeds: [errorEmbed] });
    }
    
    // Step 7: Cleanup files
    try {
      console.log('🧹 Step 7: Cleaning up temporary files...');
      const allFiles = [...recordingFiles, ...wavFiles];
      if (allFiles.length > 0) {
        await cleanupRecordingFiles(allFiles);
      }
    } catch (cleanupError) {
      console.warn('⚠️ Cleanup error:', cleanupError.message);
      // Don't fail the entire operation for cleanup errors
    }
    
  } catch (error) {
    console.error('❌ Stop command error:', error);
    
    try {
      await interaction.editReply({
        embeds: [createErrorEmbed('❌ Command Error', `An unexpected error occurred: ${error.message}`)]
      });
    } catch (replyError) {
      console.error('❌ Could not send error reply:', replyError);
    }
  }
}

/**
 * Updates the processing progress message
 * @param {Object} interaction - Discord interaction
 * @param {string} currentStep - Current step description
 * @param {string} statusList - Updated status list
 */
async function updateProcessingProgress(interaction, currentStep, statusList) {
  try {
    const updatedEmbed = new EmbedBuilder()
      .setColor(embedColors.info)
      .setTitle('⏹️ Recording Stopped')
      .setDescription(`Processing transcription and generating summary...\\n\\n**Current Step:** ${currentStep}`)
      .addFields(
        { name: '🔄 Processing Status', value: statusList, inline: false }
      )
      .setFooter({ text: 'This may take several minutes depending on recording length' })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [updatedEmbed] });
  } catch (error) {
    console.warn('⚠️ Could not update progress:', error.message);
  }
}

/**
 * Creates the final summary embed for posting
 * @param {Object} summary - Meeting summary
 * @param {Object} transcript - Combined transcript
 * @param {Object} recordingStatus - Recording status
 * @param {string} error - Processing error if any
 * @returns {EmbedBuilder} Summary embed
 */
async function createSummaryEmbed(summary, transcript, recordingStatus, error) {
  const embed = new EmbedBuilder()
    .setColor(error ? embedColors.warning : embedColors.summary)
    .setTitle(`📝 Meeting Summary - ${new Date().toLocaleDateString()}`)
    .setTimestamp();
  
  if (error) {
    embed.setDescription(`⚠️ **Processing completed with errors**\\n\\n${error}`);
  }
  
  // Add meeting metadata
  embed.addFields({
    name: '📊 Meeting Information',
    value: `**Channel:** ${recordingStatus.channelName}\\n**Duration:** ${formatDuration(recordingStatus.duration)}\\n**Participants:** ${recordingStatus.participants}\\n**Started by:** ${recordingStatus.initiatedBy}`,
    inline: false
  });
  
  if (summary && !error) {
    // Add summary sections
    if (summary.briefOverview) {
      embed.addFields({
        name: '📋 Brief Overview',
        value: summary.briefOverview.substring(0, 1000),
        inline: false
      });
    }
    
    if (summary.keyDiscussionPoints && summary.keyDiscussionPoints.length > 0) {
      const discussionPoints = summary.keyDiscussionPoints
        .slice(0, 10) // Limit to 10 points
        .map(point => `• ${point}`)
        .join('\\n');
      
      embed.addFields({
        name: '💬 Key Discussion Points',
        value: discussionPoints.substring(0, 1000),
        inline: false
      });
    }
    
    if (summary.actionItems && summary.actionItems.length > 0) {
      const actionItems = summary.actionItems
        .slice(0, 10)
        .map(item => `• ${item}`)
        .join('\\n');
      
      embed.addFields({
        name: '✅ Action Items',
        value: actionItems.substring(0, 1000),
        inline: false
      });
    }
    
    if (summary.decisionsMade && summary.decisionsMade.length > 0) {
      const decisions = summary.decisionsMade
        .slice(0, 10)
        .map(decision => `• ${decision}`)
        .join('\\n');
      
      embed.addFields({
        name: '🎯 Decisions Made',
        value: decisions.substring(0, 1000),
        inline: false
      });
    }
    
    if (summary.nextSteps) {
      embed.addFields({
        name: '➡️ Next Steps',
        value: summary.nextSteps.substring(0, 1000),
        inline: false
      });
    }
  }
  
  // Add transcript statistics
  if (transcript) {
    embed.addFields({
      name: '📈 Transcript Statistics',
      value: `**Total Words:** ${transcript.statistics.totalWords}\\n**Average Confidence:** ${transcript.statistics.averageConfidence}%\\n**Processing Time:** ${formatDuration(transcript.meetingMetadata.processingTime)}`,
      inline: true
    });
  }
  
  // Add participants info
  if (transcript && transcript.participants.length > 0) {
    const participantInfo = transcript.participants
      .map(p => `**${p.username}:** ${p.wordCount} words`)
      .join('\\n');
    
    embed.addFields({
      name: '👥 Participant Contributions',
      value: participantInfo.substring(0, 1000),
      inline: true
    });
  }
  
  embed.setFooter({ 
    text: summary && summary.metadata 
      ? `Transcribed by AssemblyAI | Summarized by ${summary.metadata.generatedBy}`
      : 'Transcribed by AssemblyAI | Summary generation failed'
  });
  
  return embed;
}

/**
 * Creates final statistics text
 * @param {Array} recordingFiles - Recording files
 * @param {Object} transcriptionResults - Transcription results
 * @param {Object} combinedTranscript - Combined transcript
 * @returns {string} Statistics text
 */
function createFinalStatsText(recordingFiles, transcriptionResults, combinedTranscript) {
  const stats = [];
  
  if (recordingFiles) {
    stats.push(`**Recordings:** ${recordingFiles.length} files`);
  }
  
  if (transcriptionResults) {
    stats.push(`**Transcriptions:** ${transcriptionResults.successful.length} successful, ${transcriptionResults.failed.length} failed`);
  }
  
  if (combinedTranscript) {
    stats.push(`**Total Words:** ${combinedTranscript.statistics.totalWords}`);
    stats.push(`**Avg Confidence:** ${combinedTranscript.statistics.averageConfidence}%`);
  }
  
  return stats.join('\\n') || 'No statistics available';
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

/**
 * Checks if user has permission to use the command
 * @param {Object} interaction - Discord interaction
 * @returns {boolean} True if user has permission
 */
function hasPermission(interaction) {
  // Check for Manage Channels permission
  if (interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return true;
  }
  
  // Check for specific role if configured
  if (config.discord.allowedRoleId) {
    return interaction.member.roles.cache.has(config.discord.allowedRoleId);
  }
  
  return false;
}

/**
 * Creates an error embed
 * @param {string} title - Error title
 * @param {string} description - Error description
 * @returns {EmbedBuilder} Error embed
 */
function createErrorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(embedColors.error)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

export default {
  data,
  execute
};