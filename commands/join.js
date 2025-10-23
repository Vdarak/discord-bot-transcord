import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { config, voiceConfig, embedColors } from '../config.js';
import { startStreamingSession, getCurrentStreamingStatus, validateStreamingConfig } from '../utils/streamingAudioProcessor.js';

/**
 * Join Command - Makes the bot join a voice channel and start streaming transcription
 */

export const data = new SlashCommandBuilder()
  .setName('join')
  .setDescription('Join your voice channel and start recording the meeting')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
  // Defer reply IMMEDIATELY to prevent timeout
  const deferStart = Date.now();
  try {
    console.log(`⚡ [JOIN] Starting defer at ${deferStart}`);
    await interaction.deferReply({ flags: [] });
    const deferEnd = Date.now();
    console.log(`⚡ [JOIN] Defer completed in ${deferEnd - deferStart}ms`);
  } catch (error) {
    const deferError = Date.now();
    console.error(`❌ [JOIN] Failed to defer reply after ${deferError - deferStart}ms:`, error);
    // If we can't defer, the interaction has likely timed out
    return;
  }

  try {
    console.log(`🎤 [JOIN] Join command executed by ${interaction.user.tag} in ${interaction.guild.name}`);
    
    // Permission check
    if (!hasPermission(interaction)) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('❌ Permission Denied', 'You need "Manage Channels" permission or the required role to use this command.')]
      });
    }
    
    // Validate streaming configuration
    if (!validateStreamingConfig()) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('❌ Configuration Error', 'Streaming transcription is not properly configured. Check API keys and settings.')]
      });
    }
    
    // Check if bot is already recording
    const currentStatus = getCurrentStreamingStatus();
    if (currentStatus && currentStatus.active) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('🔴 Already Recording', `Bot is already recording. Use \`/stop\` to end the current recording first.`)]
      });
    }
    
    // Get user's voice channel
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member.voice.channel) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('❌ Not in Voice Channel', 'You must be in a voice channel to start recording.')]
      });
    }
    
    const voiceChannel = member.voice.channel;
    
    // Check bot permissions in voice channel
    const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
    if (!voiceChannel.permissionsFor(botMember).has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('❌ Missing Permissions', `Bot needs Connect and Speak permissions in ${voiceChannel.name}.`)]
      });
    }
    
    // Get users in voice channel
    const otherMembers = voiceChannel.members.filter(m => !m.user.bot);
    if (otherMembers.size === 0) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('⚠️ Empty Channel', 'No other users found in the voice channel. Recording will start when participants join.')]
      });
    }
    
    try {
      // Join voice channel
      console.log(`🔗 [JOIN] Connecting to voice channel: ${voiceChannel.name}`);
      
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        ...voiceConfig
      });
      
      // Wait for connection to be ready
      await entersState(connection, VoiceConnectionStatus.Ready, 30000);
      console.log('✅ [JOIN] Voice connection established');
      
      // Update bot nickname to indicate recording
      try {
        await botMember.setNickname('🔴 Recording');
      } catch (error) {
        console.warn('⚠️ [JOIN] Could not update bot nickname:', error.message);
      }
      
      // Create unique session ID
      const sessionId = `${interaction.guild.id}_${Date.now()}`;
      const userIds = Array.from(otherMembers.keys());
      
      // Start streaming transcription session
      console.log(`🎯 [JOIN] Starting streaming session: ${sessionId}`);
      const streamingSession = await startStreamingSession(sessionId, connection, userIds);
      
      console.log(`✅ [JOIN] Streaming session started with ${userIds.length} participants`);
      
      // Send confirmation
      const embed = new EmbedBuilder()
        .setColor(embedColors.recording)
        .setTitle('🔴 Streaming Transcription Started')
        .setDescription(`Recording started in **${voiceChannel.name}**\\nReal-time transcription is active!`)
        .addFields(
          { name: '👥 Current Participants', value: `${otherMembers.size} users`, inline: true },
          { name: '⏱️ Started By', value: interaction.user.tag, inline: true },
          { name: '🕐 Started At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
          { name: '🎯 Session ID', value: `\`${sessionId}\``, inline: false },
          { name: '⚡ Technology', value: 'AssemblyAI Streaming API\\n(No file storage required!)', inline: true }
        )
        .setFooter({ text: 'Use /stop to end recording and generate summary' })
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
      
      // Send status to designated status channel
      try {
        const statusChannel = await interaction.client.channels.fetch(config.discord.statusChannelId);
        if (statusChannel) {
          const statusEmbed = new EmbedBuilder()
            .setColor(embedColors.success)
            .setTitle('🔴 Streaming Transcription Started')
            .setDescription(`Recording started in **${voiceChannel.name}** by ${interaction.user.tag}`)
            .addFields(
              { name: '👥 Participants', value: `${otherMembers.size} users`, inline: true },
              { name: '🕐 Started At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
              { name: '🎯 Session', value: `\`${sessionId}\``, inline: true }
            )
            .setTimestamp();
          
          await statusChannel.send({ embeds: [statusEmbed] });
        }
      } catch (error) {
        console.warn('⚠️ [JOIN] Could not send status message:', error.message);
      }
      
      // Send Discord policy compliance warning to designated status channel
      try {
        const statusChannel = await interaction.client.channels.fetch(config.discord.statusChannelId);
        if (statusChannel) {
          const warningEmbed = new EmbedBuilder()
            .setColor(embedColors.warning)
            .setTitle('🔴 Voice Recording Active')
            .setDescription(`**Meeting recording is now active in ${voiceChannel.name}**\\n\\n⚠️ **Important Discord Policy Notice:**\\n• Bot can only record users who actively speak\\n• Recording requires participant awareness and consent\\n• All voice data will be transcribed and summarized\\n• Users can leave the channel to opt out\\n\\n**Technical Note:** If no audio is captured, ensure users are speaking clearly and the bot has proper permissions.\\n\\n✨ **New:** Using streaming transcription for real-time results!`)
            .setFooter({ text: `Started by ${interaction.user.tag} • Use /stop to end recording` })
            .setTimestamp();
          
          await statusChannel.send({ embeds: [warningEmbed] });
        }
      } catch (error) {
        console.warn('⚠️ [JOIN] Could not send recording warning:', error.message);
      }
      
      console.log(`✅ [JOIN] Join command completed successfully`);
      
    } catch (error) {
      console.error('❌ [JOIN] Failed to set up streaming transcription:', error);
      
      // Try to reset bot nickname
      try {
        await botMember.setNickname(null);
      } catch (resetError) {
        console.warn('⚠️ [JOIN] Could not reset bot nickname:', resetError.message);
      }
      
      const errorEmbed = new EmbedBuilder()
        .setColor(embedColors.error)
        .setTitle('❌ Recording Setup Failed')
        .setDescription(`Failed to start streaming transcription: ${error.message}`)
        .addFields(
          { name: '🔧 Troubleshooting', value: '• Check AssemblyAI API key\\n• Verify voice channel permissions\\n• Ensure stable internet connection\\n• Try again in a few moments', inline: false }
        )
        .setTimestamp();
      
      await interaction.editReply({ embeds: [errorEmbed] });
    }
    
  } catch (error) {
    console.error('❌ [JOIN] Fatal error in join command:', error);
    // Let the global error handler in index.js manage the interaction response
    throw error;
  }
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