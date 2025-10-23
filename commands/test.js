import { SlashCommandBuilder } from 'discord.js';

/**
 * Test Command - Simple immediate response for debugging
 */

export const data = new SlashCommandBuilder()
  .setName('test')
  .setDescription('Test command with immediate response');

export async function execute(interaction) {
  try {
    console.log(`🧪 [TEST] Test command executed by ${interaction.user.tag}`);
    
    // Try immediate reply instead of defer
    await interaction.reply({
      content: '✅ Test command working! Bot is responsive.',
      flags: [64] // EPHEMERAL
    });
    
    console.log(`🧪 [TEST] Test command completed successfully`);
    
  } catch (error) {
    console.error('❌ [TEST] Test command error:', error);
    throw error;
  }
}