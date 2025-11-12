import { Context, Schema, h } from 'koishi'
import { inspect } from 'util'

export const name = 'ai-manager'
export const reusable = true
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
 * @property {h[]} elements - 消息的元素数组，用于精确转发所有类型的消息。
 * @property {number} timestamp - 消息发送时的Unix时间戳 (毫秒)。
 */
interface MessageInfo {
  userId: string;
  userName: string;
  channelId: string;
  guildId: string;
  messageId: string;
  content: string;
  elements: h[];
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
  batchMode: boolean;
  maxBatchSize: number;
  maxBatchTime: number;
  whitelist: string[];
  Action: ('recall' | 'mute' | 'forward')[];
  Target: string;
  forwardRaw: boolean;
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
    Debug: Schema.boolean().default(false).description('输出原始请求与响应'),
  }).description('模型配置'),
  Schema.object({
    Action: Schema.array(Schema.union(['recall', 'mute', 'forward'])).role('checkbox').description('执行操作'),
    Target: Schema.string().description('转发目标').default('onebot:123456789'),
    forwardRaw: Schema.boolean().default(false).description('显示原始文本'),
  }).description('审查操作'),
  Schema.object({
    batchMode: Schema.boolean().default(false).description('即时模式'),
    maxBatchSize: Schema.number().min(1).max(1024).default(128).description('最大消息数量'),
    maxBatchTime: Schema.number().min(10).max(3600).default(300).description('最大等待时间'),
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
  const SYSTEM_PROMPT = `<role>你是一个具备高级上下文理解能力的内容审查AI。你的任务是精确、严格、高效地分析给定的对话片段，识别违反规则的行为，并仅以指定的JSON格式返回代表性的违规结果。</role>
<instructions>
1. 综合上下文进行分析: 你将收到的消息数组是按时间顺序排列的。你必须综合上下文来判断。特别注意识别由同一用户连续的多条消息所构成的违规，例如刷屏、骚扰、或逐渐升级的争吵，此外避免单一消息的误判。
2. 返回代表性结果: 当一个用户的多条消息共同构成一种违规时（例如刷屏），你只需要选择其中最具代表性的一条或几条消息进行报告，而不是报告所有相关的消息。你的目标是减少冗余，精准定位问题行为的核心。
3. 在原因中解释上下文: 在返回的 "reason" 字段中，必须清晰说明违规原因。如果判断基于多条消息的上下文，请明确指出，例如：“用户连续发布多条相似内容，构成刷屏”或“在对话中持续对他人进行人身攻击”。
4. 严格的JSON输出: 你的回答必须是合法的JSON数组格式。绝对禁止在JSON内容之外添加任何解释、问候、思考或其他非JSON的内容，只需要输出一个JSON数组。如果未发现违规，必须返回空数组 \`[]\`。
</instructions>
<input_format>你将收到一个JSON数组，其中每个对象代表一条消息：[{ "id": "消息的唯一ID", "guildId": "群组ID", "userId": "用户ID", "content": "消息内容" }]</input_format>
<output_format>你必须返回一个JSON数组，其中每个对象代表一条违规记录：[{ "id": "违规消息的ID", "reason": "违规原因", "mute": 禁言秒数 (可选, 必须为数字) }]</output_format>
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
        const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/i);
        if (jsonBlockMatch?.[1]) potentialStrings.add(jsonBlockMatch[1]);
        const firstBrace = content.indexOf('{');
        const lastBrace = content.lastIndexOf('}');
        const firstBracket = content.indexOf('[');
        const lastBracket = content.lastIndexOf(']');
        if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
          if (lastBrace > firstBrace) potentialStrings.add(content.substring(firstBrace, lastBrace + 1));
        } else if (firstBracket !== -1) {
          if (lastBracket > firstBracket) potentialStrings.add(content.substring(firstBracket, lastBracket + 1));
        }
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
        logger.error(`第 ${attempt} 次请求失败: ${e.message}`);
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
        const author = h('author', { id: msg.userId, name: msg.userName });
        const headerText = `时间: ${new Date(msg.timestamp).toLocaleString('zh-CN')}\n用户: ${msg.userName} (${msg.guildId}:${msg.userId})\n原因: ${violation.reason}`;
        const headerNode = h('message', {}, [author, h.text(headerText)]);
        const messageNode = h('message', {}, [author, ...msg.elements]);
        forwardElements.push(headerNode, messageNode);
        if (config.forwardRaw) {
          const elements = msg.elements.map(element => {
            if (element.type === 'json' && typeof element.attrs.data === 'string') {
              try {
                const parsedData = JSON.parse(element.attrs.data);
                return { ...element, attrs: { ...element.attrs, data: parsedData } };
              } catch (e) {
                return { ...element, attrs: { ...element.attrs, data: `[JSON 解析失败: ${e.message}]` } };
              }
            }
            return element;
          });
          const rawContent = `${inspect(elements, { depth: Infinity, colors: false })}`;
          const rawTextNode = h('message', {}, [author, h.text(rawContent)]);
          forwardElements.push(rawTextNode);
        }
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
    const currentMessage: MessageInfo = {
      userId: session.userId,
      userName: session.author.name || session.userId,
      channelId: session.cid,
      guildId: session.guildId,
      messageId: session.messageId,
      content: session.content,
      elements: session.elements,
      timestamp: Date.now(),
    };
    messageBatch.push(currentMessage);
    if (messageBatch.length >= config.maxBatchSize) {
      await triggerAnalysis();
      return next();
    }
    if (config.batchMode) {
      if (messageBatch.length === 1) batchStartTime = Date.now();
      if (batchTimer) clearTimeout(batchTimer);
      const timeSinceBatchStart = Date.now() - batchStartTime;
      const maxWaitTimeRemaining = (config.maxBatchTime * 1000) - timeSinceBatchStart;
      if (maxWaitTimeRemaining > 0) {
        batchTimer = setTimeout(triggerAnalysis, maxWaitTimeRemaining);
      } else {
        await triggerAnalysis();
      }
    }
    return next();
  });

  /**
   * 监听插件停用事件，确保在插件卸载前处理所有剩余的消息。
   */
  ctx.on('dispose', async () => {
    if (messageBatch.length > 0) await triggerAnalysis();
  });
}
