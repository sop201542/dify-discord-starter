import { SlashCommandBuilder } from "@discordjs/builders";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import {
  ChannelType,
  Client,
  CommandInteraction,
  IntentsBitField,
  type Message,
} from "discord.js";
import * as dotenv from "dotenv";
import { ChatMessageRequest } from "./dify-client/api.types";
import DifyChatClient from "./dify-client/dify-client";
import { DifyFile, ThoughtItem, VisionFile } from "./dify-client/dify.types";

dotenv.config();
const conversationCache = new Map<string, string>();
const counterCache = new Map<string, number>();

// 【新增】用來暫存前兩次對話內容的記憶庫，方便第 3 次進行整合
const summaryCache = new Map<string, string[]>();

class DiscordBot {
  private client: Client;
  private difyClient: DifyChatClient;
  private readonly TOKEN: string;
  private readonly HISTORY_MODE: string;
  private readonly MAX_MESSAGE_LENGTH: number;
  private readonly MESSAGE_CONTENT_ALLOWED: boolean;
  private readonly TRIGGER_KEYWORDS: string[];

  constructor() {
    this.TOKEN = process.env.DISCORD_BOT_TOKEN || "";
    this.HISTORY_MODE = process.env.HISTORY_MODE || "";
    this.MAX_MESSAGE_LENGTH = Number(process.env.MAX_MESSAGE_LENGTH) || 2000;
    this.MESSAGE_CONTENT_ALLOWED =
      String(process.env.MESSAGE_CONTENT_ALLOWED).toLowerCase() === "true" ||
      false;

    this.TRIGGER_KEYWORDS = this.parseTriggerKeywords();

    if (!this.TOKEN) {
      throw new Error("DISCORD_BOT_TOKEN must be provided in the .env file");
    }

    const intents = [
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMessages,
      IntentsBitField.Flags.DirectMessages,
    ];

    if (this.MESSAGE_CONTENT_ALLOWED) {
      intents.push(IntentsBitField.Flags.MessageContent);
    }

    this.client = new Client({
      intents,
    });
    this.difyClient = new DifyChatClient();

    this.client.once("ready", () => {
      console.log(
        "Discord bot is ready!",
        "Client ID:",
        this.client.user!.id,
        `\nInstall this bot to your server with this link: https://discord.com/api/oauth2/authorize?client_id=${this.client.user!.id}&permissions=0&scope=bot%20applications.commands `
      );
    });

    this.client.on("messageCreate", async (message) => {
      if (message.author.id === this.client.user?.id) return;
      await this.handleChatMessage(message);
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isCommand()) return;

      if (interaction.commandName === "chat") {
        await this.handleChatCommand(interaction);
      } else if (interaction.commandName === "new-conversation") {
        const cacheId =
          this.HISTORY_MODE && this.HISTORY_MODE === "user"
            ? interaction.user.id
            : interaction.channelId;
        conversationCache.delete(cacheId);
        counterCache.delete(interaction.channelId);
        summaryCache.delete(interaction.channelId); // 清空暫存
        await interaction.reply("New conversation started!");
      }
    });
  }

  public start() {
    return this.client.login(this.TOKEN);
  }

  private parseTriggerKeywords(): string[] {
    let keywords: string[] = [];
    const rawKeywords = process.env.TRIGGER_KEYWORDS;
    if (!rawKeywords) return keywords;

    try {
      keywords = JSON.parse(rawKeywords);
    } catch (error) {
      console.warn("Invalid JSON in TRIGGER_KEYWORDS.", error);
    }
    return keywords;
  }

  public async installSlashCommand(guildId: string) {
    const commands = [
      new SlashCommandBuilder()
        .setName("chat")
        .setDescription("Chat with the bot in private.")
        .addStringOption((option) =>
          option.setName("message").setDescription("Your message.").setRequired(true))
        .toJSON(),
      new SlashCommandBuilder()
        .setName("new-conversation")
        .setDescription("Start a new conversation and clear history.")
        .toJSON(),
    ];
    const rest = new REST({ version: "9" }).setToken(this.TOKEN);
    try {
      await rest.put(Routes.applicationGuildCommands(this.client.user!.id, guildId), { body: commands });
    } catch (error) {
      console.error(error);
    }
  }

  private async handleChatCommand(interaction: CommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    const message = interaction.options.get("message", true);
    const cacheKey = this.getCacheKey(interaction.user.id, interaction.channel?.id);

    try {
      const { messages, files } = await this.generateAnswer(
        {
          inputs: {
            username: interaction.user.globalName || interaction.user.username,
            now: new Date().toUTCString(),
            history_summary: "", // 指令預設留空
          },
          query: message.value! as string,
          response_mode: "streaming",
          conversation_id: (cacheKey && conversationCache.get(cacheKey)) || "",
          user: this.getUserId(interaction.user.id, interaction.guild?.id),
        },
        {
          cacheKey,
          handleChatflowAnswer: (chatflowMessages, files) => {
            if (chatflowMessages.length > 0) {
              this.sendInteractionAnswer(interaction, chatflowMessages, files);
            }
          },
        }
      );
      this.sendInteractionAnswer(interaction, messages, files);
    } catch (error) {
      console.error(error);
    }
  }

  private sendInteractionAnswer(interaction: CommandInteraction, messages: string[], files?: DifyFile[]) {
    for (const [index, m] of messages.entries()) {
      if (m.length === 0) continue;
      if (!interaction.replied && index === 0) {
        interaction.editReply({ content: m });
      } else {
        interaction.followUp({ content: m, ephemeral: true });
      }
    }
  }

  // 🔥 【核心修改】每 2 次對話進行整合的 handleChatMessage
  private async handleChatMessage(message: Message) {
    const cacheKey = this.getCacheKey(message.author.id, message.channelId);
    const channelId = message.channelId;

    const currentCount = counterCache.get(channelId) || 0;
    const MAX_TALK_LIMIT = 8; // 總對話上限依舊是 8 次

    if (currentCount >= MAX_TALK_LIMIT) {
      conversationCache.delete(cacheKey);
      counterCache.delete(channelId);
      summaryCache.delete(channelId); // 清除暫存
      await message.channel.send("🛑 **【系統提示】對話次數已達上限，AI 交流自動結束。**");
      return;
    }

    // 將當前對方講的話，存入這個頻道的暫存歷史中
    const currentHistory = summaryCache.get(channelId) || [];
    currentHistory.push(`${message.author.username}: ${message.content}`);
    summaryCache.set(channelId, currentHistory);

    counterCache.set(channelId, currentCount + 1);

    if (message.channel.type !== ChannelType.GroupDM) {
      message.channel.sendTyping().catch(console.error);
    }

    // 💡 核心邏輯：判斷是否剛好滿 2 次
    let summaryPrompt = "";
    if (currentCount > 0 && currentCount % 2 === 0) {
      // 提取前兩次的對話記錄
      const lastTwoLogs = currentHistory.slice(-2).join("\n");
      summaryPrompt = `\n【系統通知：請注意！這是你們過去兩次的對話摘要，請看過一遍後，整合到你接下來的回答中】\n${lastTwoLogs}\n請在回覆中先用一句話總結上述進度，再發表你的新觀點。`;
    }

    try {
      const { messages, files } = await this.generateAnswer(
        {
          inputs: {
            username: message.author.globalName || message.author.username,
            now: new Date().toUTCString(),
            // 將整合指令透過 inputs 或附加到 query 裡送給 Dify
            history_summary: summaryPrompt 
          },
          // 將系統整合提示悄悄塞在 query 後面，強迫 DeepSeek 看一遍
          query: message.content.replace(`<@${this.client.user?.id}>`, "") + (summaryPrompt ? `\n\n${summaryPrompt}` : ""),
          response_mode: "streaming",
          conversation_id: (cacheKey && conversationCache.get(cacheKey)) || "",
          user: this.getUserId(message.author.id, message.guild?.id),
        },
        {
          cacheKey,
          onPing: async () => {
            if (message.channel.type !== ChannelType.GroupDM) {
              await message.channel.sendTyping().catch(console.error);
            }
          },
          handleChatflowAnswer: (chatflowMessages, files) => {
            if (chatflowMessages.length > 0) {
              this.sendChatnswer(message, chatflowMessages, files);
            }
          },
        }
      );

      // 紀錄 AI 自己講過的話，這樣歷史記錄才會完整
      const aiReply = messages.join("\n");
      currentHistory.push(`Bot: ${aiReply}`);
      summaryCache.set(channelId, currentHistory);

      this.sendChatnswer(message, messages, files);

      // 如果剛剛進行了整合，在 Discord 提示一下
      if (summaryPrompt) {
        await message.channel.send(`🔄 *[系統提示：已將前 2 次對話進行摘要整合並注入給 AI]*`);
      }

      if (currentCount + 1 === MAX_TALK_LIMIT - 1) {
        await message.channel.send(`⚠️ *提示：下一句將是最後一次對話。 (目前進度: ${currentCount + 1}/${MAX_TALK_LIMIT})*`);
      }

    } catch (error) {
      console.error("Error sending message to Dify:", error);
      await message.reply("Sorry, something went wrong while generating the answer.");
    }
  }

  private sendChatnswer(message: Message, messages: string[], files?: DifyFile[]) {
    for (const [index, m] of messages.entries()) {
      if (m.length === 0) continue;
      if (index === 0) {
        message.reply({
          content: m,
          files: files?.map((f) => ({
            attachment: f.url,
            name: f.extension ? `generated_${f.type}.${f.extension}` : `generated_${f.type}`,
          })),
        });
      } else {
        message.reply(m);
      }
    }
  }

  private async generateAnswer(
    reqiest: ChatMessageRequest,
    { cacheKey, onPing, handleChatflowAnswer }: { cacheKey: string; onPing?: () => void; handleChatflowAnswer?: (messages: string[], files?: Array<VisionFile & { thought?: ThoughtItem }>) => void; }
  ): Promise<{ messages: string[]; files: Array<VisionFile & { thought?: ThoughtItem }>; }> {
    if (reqiest.query.length === 0) return Promise.resolve({ messages: [], files: [] });
    return new Promise(async (resolve, reject) => {
      try {
        let buffer = { defaultAnswer: "", chatflowAnswer: "" };
        let files: VisionFile[] = [];
        let fileGenerationThought: ThoughtItem[] = [];
        let bufferType = "defaultMessage";
        await this.difyClient.streamChatMessage(reqiest, {
          onMessage: async (answer, isFirstMessage, { conversationId }) => {
            if (bufferType === "defaultMessage") buffer.defaultAnswer += answer;
            else buffer.chatflowAnswer += answer;
            if (cacheKey) conversationCache.set(cacheKey, conversationId);
          },
          onFile: async (file: DifyFile) => { files.push(file); },
          onThought: async (thought) => { fileGenerationThought.push(thought); },
          onNodeStarted: async (nodeStarted) => {
            if (nodeStarted.data.node_type === "llm") { bufferType = "chatflowAnswer"; onPing?.(); }
            else if (nodeStarted.data.node_type === "tool") { onPing?.(); }
          },
          onNodeFinished: async (nodeFinished) => {
            if (nodeFinished.data.node_type === "answer") {
              bufferType = "defaultMessage";
              handleChatflowAnswer?.(this.splitMessage(buffer.chatflowAnswer, { maxLength: this.MAX_MESSAGE_LENGTH }), files);
              files = []; buffer.chatflowAnswer = "";
            }
          },
          onCompleted: () => {
            resolve({
              messages: this.splitMessage([buffer.chatflowAnswer, buffer.defaultAnswer].filter(Boolean).join("\n\n"), { maxLength: this.MAX_MESSAGE_LENGTH }),
              files: files.map((file) => ({ ...file, thought: fileGenerationThought.find((t) => file.id && t.message_files?.includes(file.id)) })) as any,
            });
          },
          onPing,
        });
      } catch (error: any) { reject(error); }
    });
  }

  private getCacheKey(userId: string | undefined, channelId: string | undefined): string {
    return this.HISTORY_MODE === "user" ? (userId || "") : (channelId || "");
  }

  private getUserId(userId: string | undefined, serverId: string | undefined) {
    if (this.HISTORY_MODE === "user") return userId || "default_discord_user";
    if (this.HISTORY_MODE === "channel") return serverId || userId || "default_discord_user";
    return userId || "default_discord_user";
  }

  splitMessage(message: string, options: { maxLength?: number; char?: string; prepend?: string; append?: string; } = {}): string[] {
    const { maxLength = 2000, char = "\n", prepend = "", append = "" } = options;
    if (message.length <= maxLength) return [message];
    const splitText = message.split(char);
    const messages = [""];
    for (let part of splitText) {
      if (messages[messages.length - 1].length + part.length + 1 > maxLength) {
        messages[messages.length - 1] += append;
        messages.push(prepend);
      }
      messages[messages.length - 1] += (messages[messages.length - 1].length > 0 && messages[messages.length - 1] !== prepend ? char : "") + part;
    }
    return messages;
  }
}

export default DiscordBot;
