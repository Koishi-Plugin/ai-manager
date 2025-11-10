import { Context, Schema, h } from 'koishi'

export const name = 'ai-manager'
export const inject = ['database']
export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`

/**
 * @description 存储单条消息的核心信息，用于后续处理和分析。
 * @property {string} userId - 发送消息用户的唯一ID。
 * @property {string} userName - 发送消息用户的昵称或名称。
 * @property {string} channelId - 消息所在频道的唯一ID (格式: platform:channelId)。
 * @property {string} guildId - 消息所在服务器/群组的唯一ID。
 * @property {string} messageId - 消息本身的唯一ID。
 * @property {string} content - 消息的原始内容 (Koishi的h元素字符串)。
 * @property {number} timestamp - 消息发送时的Unix时间戳 (毫秒)。
 */
interface MessageInfo {
  userId: string;
  userName: string;
  channelId: string;
  guildId: string;
  messageId: string;
  content: string;
  timestamp: number;
}

/**
 * @interface Violation
 * @description AI 服务返回的违规对象结构。
 * @property {string} id - 违规消息的ID。
 * @property {string} reason - 违规原因的文字说明。
 * @property {number} [mute] - (可选) 建议的禁言时长（秒）。
 */
interface Violation {
  id: string;
  reason: string;
  mute?: number;
}

/**
 * @interface Config
 * @description 插件的配置项接口。
 */
export interface Config {
  maxBatchSize: number;
  inactivityTimeout: number;
  maxBatchWaitTime: number;
  whitelist: string[];
  Action: ('recall' | 'mute' | 'forward')[];
  Target: string;
  Endpoint: string;
  ApiKey: string;
  Model: string;
  Rule: string;
  Debug: boolean;
}

/**
 * @const Config
 * @description 插件配置的 Schema 定义。
 */
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    Endpoint: Schema.string().required().description('API 端点 (Endpoint)'),
    ApiKey: Schema.string().role('secret').required().description('API 密钥 (Key)'),
    Model: Schema.string().description('模型 (Model)'),
    Rule: Schema.string().role('textarea').description('审查规则'),
    Debug: Schema.boolean().default(false).description('调试模式'),
  }).description('模型配置'),
  Schema.object({
    Action: Schema.array(Schema.union(['recall', 'mute', 'forward'])).role('checkbox').description('执行操作'),
    Target: Schema.string().description('转发目标').default('onebot:123456789'),
  }).description('审查操作'),
  Schema.object({
    maxBatchSize: Schema.number().min(1).max(1024).default(128).description('最大消息数量'),
    maxBatchWaitTime: Schema.number().min(60).max(3600).default(600).description('最大等待时间'),
    inactivityTimeout: Schema.number().min(5).max(600).default(300).description('消息静默超时'),
    whitelist: Schema.array(String).role('table').default(['2854196310']).description('用户白名单'),
  }).description('消息配置'),
])

/**
 * 插件的主应用函数。
 * @param ctx Koishi 的上下文对象。
 * @param config 用户配置。
 */
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('ai-manager');

  let messageBatch: MessageInfo[] = [];
  let batchTimer: NodeJS.Timeout | null = null;
  let batchStartTime: number | null = null;
  let retryTime = 0;

  /**
   * @const {string} SYSTEM_PROMPT
   * @description 注入给 AI 的系统级提示（System Prompt），定义了 AI 的角色、任务和输入输出格式。
   */
  const SYSTEM_PROMPT = `<role>你是一个高级内容审查AI。你的任务是精确、严格、高效地分析给定的消息，并仅以指定的JSON格式返回违规结果。</role>
<instructions>1. 遵循列表规则: 你只需要按照下方 <rules> 标签内定义的规则列表进行分析审查。一条消息可能同时违反多条规则，请在 "reason" 字段中清晰说明。
2. JSON格式输出: 你的回答必须且只能是一个包裹在 \`\`\`json ... \`\`\` 中的JSON数组。**绝对禁止**添加任何额外的文字。如果审查后未发现任何违规行为，必须返回一个空数组 \`[]\`。</instructions>
<input_format>你将收到一个JSON数组，其中每个对象代表一条消息：[{ "id": "消息的唯一ID", "guildId": "群组ID", "userId": "用户ID", "content": "消息的内容" }]</input_format>
<output_format>你必须返回一个JSON数组，其中每个对象代表一条违规记录：[{ "id": "违规消息的ID", "reason": "具体、清晰的违规原因", "mute": 禁言秒数 (可选, 必须为数字) }]</output_format>
<rules>${config.Rule}</rules>`;

  /**
   * 调用 AI 模型进行内容审查。
   * @param messages - 待审查的消息信息数组。
   * @returns {Promise<Violation[]>} - 返回一个包含所有已识别违规行为的数组。
   */
  const callAI = async (messages: MessageInfo[]): Promise<Violation[]> => {
    if (messages.length === 0) return [];
    const aiPayload = messages.map(msg => ({
      id: msg.messageId,
      guildId: msg.guildId,
      userId: msg.userId,
      content: msg.content
    }));
    if (config.Debug) logger.info('请求模型:', JSON.stringify(aiPayload, null, 2));
    let attempt = 0;
    while (true) {
      const now = Date.now();
      if (now < retryTime) {
        const waitTime = retryTime - now;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      try {
        const response = await ctx.http.post<{ choices: { message: { content: string } }[] }>(
          `${config.Endpoint.replace(/\/$/, '')}/chat/completions`,
          {
            model: config.Model,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(aiPayload) }],
          },
          { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.ApiKey}` }, timeout: 600000 }
        );
        const content = response?.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error;
        const potentialStrings = new Set<string>();
        const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonBlockMatch?.[1]) potentialStrings.add(jsonBlockMatch[1]);
        const firstBracket = content.indexOf('[');
        const lastBracket = content.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket > firstBracket) potentialStrings.add(content.substring(firstBracket, lastBracket + 1));
        potentialStrings.add(content);
        for (const jsonString of potentialStrings) {
          try {
            const parsed = JSON.parse(jsonString);
            if (Array.isArray(parsed)) {
              retryTime = 0;
              return parsed as Violation[];
            }
          } catch (e) { /* 忽略解析错误 */ }
        }
        throw new Error;
      } catch (e) {
        attempt++;
        retryTime = Date.now() + 20000 + attempt * 10000;
        logger.error(`第 ${attempt} 次请求失败: ${e}`);
      }
    }
  };

  /**
   * 处理 AI 返回的违规信息，并执行相应的操作（撤回、禁言、转发）。
   * @param violations - AI 返回的违规对象数组。
   * @param originalMessages - 原始消息批次，用于查找违规消息的详细信息。
   */
  const processViolations = async (violations: Violation[], originalMessages: MessageInfo[]) => {
    if (config.Action.length === 0 || violations.length === 0) return;
    if (config.Debug) logger.info('模型返回:', JSON.stringify(violations, null, 2));
    const messageMap = new Map<string, MessageInfo>(originalMessages.map(msg => [msg.messageId, msg]));
    const forwardElements: h[] = [];
    const sortedViolations = violations
      .filter(v => messageMap.has(v.id))
      .sort((a, b) => messageMap.get(a.id).timestamp - messageMap.get(b.id).timestamp);
    for (const violation of sortedViolations) {
      const msg = messageMap.get(violation.id);
      const [platform] = msg.channelId.split(':', 1);
      const bot = ctx.bots.find(b => b.platform === platform);
      if (!bot) continue;
      if (config.Action.includes('recall')) await bot.deleteMessage(msg.channelId, msg.messageId).catch(e => logger.warn(`撤回 [${msg.messageId}] 失败: ${e.message}`));
      if (config.Action.includes('mute') && violation.mute > 0) await bot.muteGuildMember(msg.guildId, msg.userId, violation.mute * 1000).catch(e => logger.warn(`禁言 [${msg.userId}] 失败: ${e.message}`));
      if (config.Action.includes('forward')) {
        const author = h('author', { userId: msg.userId, name: msg.userName });
        const headerText = `时间: ${new Date(msg.timestamp).toLocaleString('zh-CN')}\n用户: ${msg.userName} (${msg.guildId}:${msg.userId})\n原因: ${violation.reason}`;
        const messageContent = h.parse(msg.content);
        const headerNode = h('message', {}, [author, h.text(headerText)]);
        const messageNode = h('message', {}, [author, ...messageContent]);
        forwardElements.push(headerNode, messageNode);
      }
    }
    if (forwardElements.length > 0 && config.Target) {
      const forwardMessage = h('message', { forward: true }, forwardElements);
      await ctx.broadcast([config.Target], forwardMessage).catch(e => logger.error(`转发消息失败: ${e.message}`));
    }
  };

  /**
   * 触发消息批处理和分析。
   * 此函数会清空现有计时器和状态，并处理当前消息队列中的所有消息。
   */
  const triggerAnalysis = async () => {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = null;
    batchStartTime = null;
    if (messageBatch.length === 0) return;
    const messagesToAnalyze = [...messageBatch];
    messageBatch = [];
    const violations = await callAI(messagesToAnalyze);
    if (violations.length > 0) await processViolations(violations, messagesToAnalyze);
  };

  /**
   * Koishi 中间件，用于捕获和处理消息。
   */
  ctx.middleware(async (session, next) => {
    if (session.isDirect || !session.guildId || session.author.isBot || config.whitelist.includes(session.userId) || session.cid === config.Target) return next();
    if (messageBatch.length === 0) batchStartTime = Date.now();
    messageBatch.push({
      userId: session.userId,
      userName: session.author.name || session.userId,
      channelId: session.cid,
      guildId: session.guildId,
      messageId: session.messageId,
      content: session.content,
      timestamp: Date.now(),
    });
    if (messageBatch.length >= config.maxBatchSize) {
      triggerAnalysis();
      return next();
    }

    if (batchTimer) clearTimeout(batchTimer);
    const timeSinceBatchStart = Date.now() - batchStartTime;
    const maxWaitTimeRemaining = (config.maxBatchWaitTime * 1000) - timeSinceBatchStart;
    const nextTimeout = Math.min(config.inactivityTimeout * 1000, maxWaitTimeRemaining);
    if (nextTimeout > 0) {
      batchTimer = setTimeout(triggerAnalysis, nextTimeout);
    } else {
      triggerAnalysis();
    }
    return next();
  });

  /**
   * 监听插件停用事件，确保在插件卸载前处理所有剩余的消息。
   */
  ctx.on('dispose', async () => {
    if (batchTimer) clearTimeout(batchTimer);
    if (messageBatch.length > 0) {
      const messagesToAnalyze = [...messageBatch];
      const violations = await callAI(messagesToAnalyze);
      if (violations.length > 0) await processViolations(violations, messagesToAnalyze);
    }
  });
}
