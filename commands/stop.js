import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { config, embedColors } from '../config.js';
import { getCurrentStreamingStatus } from '../utils/streamingAudioProcessor.js';
import { stopStreamingSession } from '../utils/streamingAudioProcessor.js';
import { generateMeetingSummary } from '../utils/summarizer.js';

/**
 * Stop Command - Stops streaming recording and processes transcription/summary
 */

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop the current recording and generate meeting summary')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
  // Log interaction metadata immediately to help debug timing / unknown interaction issues
  try {
    const now = Date.now();
    console.log(`⚡ [INTERACTION META] id=${interaction.id} token=${interaction.token} created=${interaction.createdTimestamp} age=${now - interaction.createdTimestamp}ms`);
  } catch (metaErr) {
    console.warn('⚠️ [STOP] Could not read interaction metadata:', metaErr);
  }

  // Defer reply IMMEDIATELY to prevent timeout
  try {
    await interaction.deferReply({ flags: [] });
  } catch (error) {
    console.error('❌ [STOP] Failed to defer reply:', error);
    // If we can't defer, the interaction has likely timed out
    return;
  }

  try {
    console.log(`⏹️ [STOP] Stop command executed by ${interaction.user.tag} in ${interaction.guild.name}`);
    
    // Permission check
    if (!hasPermission(interaction)) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('❌ Permission Denied', 'You need "Manage Channels" permission or the required role to use this command.')]
      });
    }
    
    // Check if bot is recording
    const recordingStatus = getCurrentStreamingStatus();
    if (!recordingStatus) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('⚠️ Not Recording', 'Bot is not currently recording. Use `/join` to start a recording first.')]
      });
    }
    
    // Send initial processing message
    const processingEmbed = new EmbedBuilder()
      .setColor(embedColors.warning)
      .setTitle('⏹️ Recording Stopped')
      .setDescription('Processing streaming transcription and generating summary...')
      .addFields(
        { name: '📊 Recording Stats', value: `Duration: ${formatDuration(recordingStatus.duration)}\\nParticipants: ${recordingStatus.participants}`, inline: true },
        { name: '🔄 Processing Status', value: '• Stopping streaming transcription...\\n• Compiling final transcript...\\n• Generating AI summary...', inline: false }
      )
      .setFooter({ text: 'Streaming transcription - processing is much faster!' })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [processingEmbed] });
    
    let finalTranscript = null;
    let meetingSummary = null;
    let processingError = null;
    
    try {
      // Step 1: Stop streaming transcription and get final transcript
      console.log('🔄 [STOP] Step 1: Stopping streaming transcription...');
      finalTranscript = await stopStreamingSession(recordingStatus.sessionId);
      
      if (!finalTranscript || !finalTranscript.combinedText || finalTranscript.combinedText.trim().length === 0) {
        throw new Error('No transcript was generated - no speech was detected during the recording');
      }
      
    const totalWords = finalTranscript?.statistics?.totalWords ?? finalTranscript?.wordCount ?? 0;
    const participantCount = finalTranscript?.statistics?.participantCount ?? (Array.isArray(finalTranscript?.participants) ? finalTranscript.participants.length : (finalTranscript?.rawParticipantsMap ? Object.keys(finalTranscript.rawParticipantsMap).length : 0));
    console.log(`✅ [STOP] Transcript received: ${totalWords} words from ${participantCount} participants`);
      
      // Update progress
      await updateProcessingProgress(interaction, 'Transcript compiled', '• ✅ Stopping streaming transcription\\n• ✅ Compiling final transcript\\n• 🔄 Generating AI summary...');
      
      // Step 2: Generate AI summary
      console.log('🔄 [STOP] Step 2: Generating AI summary...');
      meetingSummary = await generateMeetingSummary(finalTranscript, {
        sessionId: recordingStatus.sessionId,
        duration: recordingStatus.duration,
        participantCount: finalTranscript.statistics.participantCount
      });
      
      console.log(`✅ [STOP] Summary generated successfully`);
      
      // Update progress - completed
      await updateProcessingProgress(interaction, 'Summary generated', '• ✅ Streaming transcription stopped\\n• ✅ Final transcript compiled\\n• ✅ AI summary generated\\n• 🔄 Posting results...');
      
    } catch (error) {
      console.error('❌ [STOP] Processing error:', error);
      // Keep the full error object for diagnostics but expose a user-friendly message
      processingError = error && error.message ? error.message : String(error);
    }

    // If processing failed and we have no summary, provide a short fallback message so
    // we can still post something to the summary/status channels instead of failing later.
    if (processingError && !meetingSummary) {
      meetingSummary = `Processing failed: ${processingError}`;
    }
    
    try {
      // Step 3: Post results to summary channel
      console.log('🔄 [STOP] Step 3: Posting results...');
      
      const summaryChannel = await interaction.client.channels.fetch(config.discord.summaryChannelId);
      if (!summaryChannel) {
        throw new Error(`Summary channel not found: ${config.discord.summaryChannelId}`);
      }
      
      // Create and send summary embed
  const summaryEmbed = await createSummaryEmbed(meetingSummary, finalTranscript, recordingStatus, processingError);
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
        console.warn('⚠️ [STOP] Could not send status message:', error.message);
      }
      
      // Compute safe stats for the final embed (avoid exceptions if fields missing)
      const totalWordsSafe = finalTranscript?.statistics?.totalWords ?? finalTranscript?.wordCount ?? 0;
      const participantCountSafe = finalTranscript?.statistics?.participantCount ?? (Array.isArray(finalTranscript?.participants) ? finalTranscript.participants.length : (finalTranscript?.rawParticipantsMap ? Object.keys(finalTranscript.rawParticipantsMap).length : 0));
      const avgConfidenceSafe = typeof finalTranscript?.statistics?.averageConfidence === 'number' ? finalTranscript.statistics.averageConfidence : 0;

      // Send completion message
      const completionEmbed = new EmbedBuilder()
        .setColor(processingError ? embedColors.warning : embedColors.success)
        .setTitle(processingError ? '⚠️ Processing Completed with Errors' : '✅ Processing Complete')
        .setDescription(processingError 
          ? `Recording processed with errors. Summary posted in <#${config.discord.summaryChannelId}>`
          : `Meeting summary successfully posted in <#${config.discord.summaryChannelId}>`
        )
        .addFields(
          { 
            name: '📊 Final Statistics', 
            value: finalTranscript 
              ? `**Words:** ${totalWordsSafe}\n**Participants:** ${participantCountSafe}\n**Confidence:** ${avgConfidenceSafe.toFixed(1)}%`
              : 'No transcript data available',
            inline: true 
          },
          { 
            name: '⏱️ Processing Time', 
            value: `${Math.round((Date.now() - recordingStatus.startTime) / 1000)}s total\n(Real-time streaming!)`,
            inline: true 
          }
        )
        .setFooter({ 
          text: processingError 
            ? `Error: ${processingError}` 
            : 'Streaming transcription completed successfully'
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [completionEmbed] });
      
      console.log(`✅ [STOP] Stop command completed successfully`);
      
    } catch (postError) {
      console.error('❌ [STOP] Failed to post results:', postError);

      // If we lack access to the configured summary channel, attempt to notify in the status channel instead
      if (postError && postError.code === 50001) {
        try {
          const statusChannel = await interaction.client.channels.fetch(config.discord.statusChannelId);
          const fallbackEmbed = new EmbedBuilder()
            .setColor(embedColors.warning)
            .setTitle('⚠️ Summary Post Failed - Missing Access')
            .setDescription(`I couldn't post the meeting summary to <#${config.discord.summaryChannelId}> because I don't have access. The summary is attached here instead.`)
            .addFields(
              { name: 'Session', value: recordingStatus.sessionId, inline: true },
              { name: 'Error', value: postError.message, inline: true }
            )
            .setTimestamp();

          if (statusChannel) {
            // Only include the summary embed if it was successfully created
            const embedsToSend = [fallbackEmbed];
            if (typeof summaryEmbed !== 'undefined') embedsToSend.push(summaryEmbed);
            await statusChannel.send({ embeds: embedsToSend });
          }
        } catch (fallbackErr) {
          console.error('❌ [STOP] Failed to post fallback summary to status channel:', fallbackErr);
        }
      }

      const errorDescription = postError && postError.message ? postError.message : String(postError);
      const errorEmbed = new EmbedBuilder()
        .setColor(embedColors.error)
        .setTitle('❌ Processing Failed')
        .setDescription(`Failed to process recording: ${errorDescription}`)
        .addFields(
          { name: 'Error Code', value: postError && postError.code ? String(postError.code) : 'N/A', inline: true },
          { name: 'Context', value: `Session: ${recordingStatus.sessionId}`, inline: true }
        )
        .setTimestamp();

      try {
        await interaction.editReply({ embeds: [errorEmbed] });
      } catch (editErr) {
        console.error('❌ [STOP] Failed to edit reply with error embed:', editErr);
      }
    }
    
  } catch (error) {
    console.error('❌ [STOP] Fatal error in stop command:', error);
    // Let the global error handler in index.js manage the interaction response
    throw error;
  }
}

/**
 * Updates the processing progress message
 * @param {Object} interaction - Discord interaction
 * @param {string} currentStep - Current step description
 * @param {string} statusText - Status text for the embed
 */
async function updateProcessingProgress(interaction, currentStep, statusText) {
  try {
    const progressEmbed = new EmbedBuilder()
      .setColor(embedColors.warning)
      .setTitle('⏹️ Recording Stopped')
      .setDescription(`Processing streaming transcription and generating summary...\\n\\n**Current Step:** ${currentStep}`)
      .addFields(
        { name: '🔄 Processing Status', value: statusText, inline: false }
      )
      .setFooter({ text: 'Streaming transcription - much faster than file-based!' })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [progressEmbed] });
  } catch (error) {
    console.warn('⚠️ [STOP] Could not update progress:', error.message);
  }
}

/**
 * Creates a summary embed for the completed transcription
 * @param {Object} summary - Generated summary
 * @param {Object} transcript - Final transcript
 * @param {Object} recordingInfo - Recording information
 * @param {string} error - Error message if any
 * @returns {EmbedBuilder} Summary embed
 */
async function createSummaryEmbed(summary, transcript, recordingInfo, error = null) {
  const embed = new EmbedBuilder()
    .setColor(error ? embedColors.warning : embedColors.success)
    .setTitle('📝 Meeting Summary')
    .setTimestamp();
  
  if (error) {
    embed.setDescription(`⚠️ **Processing completed with errors**\\n\\n${error}`)
         .addFields(
           { name: '⚠️ Error Details', value: error, inline: false }
         );
  } else if (summary && transcript) {
    // Truncate summary if too long for Discord embed limits
    // Accept either a string summary or a structured summary object returned by generateMeetingSummary
    const maxSummaryLength = 3000;
    let summaryText = '';
    if (typeof summary === 'string') {
      summaryText = summary;
    } else if (summary && typeof summary === 'object') {
      // Prefer rawSummary, then briefOverview, then stringify a small portion
      summaryText = summary.rawSummary || summary.briefOverview || JSON.stringify(summary);
    } else {
      summaryText = String(summary || 'No summary available');
    }

    summaryText = summaryText.length > maxSummaryLength ? summaryText.substring(0, maxSummaryLength) + '\n\n*[Summary truncated for Discord embed limits]*' : summaryText;
      // Safely extract statistics (some runs may not populate every field)
      const words = transcript?.statistics?.totalWords ?? transcript?.wordCount ?? 0;
      const participantsCount = transcript?.statistics?.participantCount ?? (Array.isArray(transcript?.participants) ? transcript.participants.length : (transcript?.rawParticipantsMap ? Object.keys(transcript.rawParticipantsMap).length : 0));
      const avgConf = typeof transcript?.statistics?.averageConfidence === 'number' ? transcript.statistics.averageConfidence : 0;
      const participantsList = (Array.isArray(transcript?.participants) && transcript.participants.length > 0)
        ? transcript.participants.map(p => `• ${p.name || p.username || 'Unknown'}`).slice(0, 10).join('\n')
        : 'No participants identified';

      embed.setDescription(summaryText)
           .addFields(
             { 
               name: '📊 Statistics', 
               value: `**Words:** ${words}\n**Participants:** ${participantsCount}\n**Confidence:** ${avgConf.toFixed(1)}%\n**Duration:** ${formatDuration(recordingInfo.duration)}`,
               inline: true 
             },
             { 
               name: '👥 Participants', 
               value: participantsList,
               inline: true 
             }
           );
  } else {
    embed.setDescription('❌ **No transcript or summary available**\\n\\nThe recording may not have captured any speech.');
  }
  
  return embed;
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
 * Formats duration in milliseconds to human readable format
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
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