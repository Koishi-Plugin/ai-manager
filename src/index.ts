import { Context, Schema, h } from 'koishi'

export const name = 'ai-manager'
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
  userName:string;
  channelId: string;
  guildId: string;
  messageId: string;
  content: string;
  timestamp: number;
}

/**
 * @description 代表一个全局的待处理消息批次。
 * @property {MessageInfo[]} messages - 缓存的消息数组。
 * @property {NodeJS.Timeout | null} inactivityTimer - 用于处理不活跃超时的计时器。
 * @property {NodeJS.Timeout | null} maxWaitTimer - 用于处理最大等待时间的计时器。
 */
interface MessageBatch {
  messages: MessageInfo[];
  inactivityTimer: NodeJS.Timeout | null;
  maxWaitTimer: NodeJS.Timeout | null;
}

/**
 * @description AI 服务返回的违规对象结构。
 * @property {string} messageId - 违规消息的ID。
 * @property {string} userId - 违规用户的ID。
 * @property {string} reason - 违规原因的文字说明。
 * @property {number} [mute] - (可选) 建议的禁言时长（秒）。
 */
interface Violation {
  messageId: string;
  userId: string;
  reason: string;
  mute?: number;
}

/**
 * @description 代表发送给 AI 的单条消息的结构化对象，支持递归嵌套以处理转发消息。
 * @property {string} id - 消息的唯一ID。
 * @property {string} channelId - 消息来源的频道ID。
 * @property {object} user - 发送者信息。
 * @property {string} user.id - 发送者的唯一ID。
 * @property {string} user.name - 发送者的昵称。
 * @property {Array<{ type: 'text'; text: string } | { type: 'image'; url: string }>} content - 消息内容，由文本和图片片段组成。
 * @property {AiMessage[]} [forwards] - (可选) 包含的转发消息数组。
 */
interface AiMessage {
  id: string;
  channelId: string;
  user: {
    id: string;
    name: string;
  };
  content: ({ type: 'text'; text: string } | { type: 'image'; url: string })[];
  forwards?: AiMessage[];
}

/**
 * @description 插件的配置接口。
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

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    Endpoint: Schema.string().required().description('端点 (Endpoint)'),
    ApiKey: Schema.string().role('secret').required().description('密钥 (Key)'),
    Model: Schema.string().description('模型 (Model)'),
    Debug: Schema.boolean().default(false).description('调试模式'),
    Rule: Schema.string().role('textarea').description('检测规则'),
  }).description('模型配置'),
  Schema.object({
    Action: Schema.array(Schema.union(['recall', 'mute', 'forward'])).role('checkbox').description('执行操作'),
    Target: Schema.string().description('转发目标').default('onebot:123456789'),
  }).description('审查操作'),
  Schema.object({
    maxBatchSize: Schema.number().min(1).max(128).default(60).description('最多消息数量'),
    inactivityTimeout: Schema.number().min(5).max(600).default(60).description('最大静默超时'),
    maxBatchWaitTime: Schema.number().min(60).max(3600).default(300).description('连续消息超时'),
    whitelist: Schema.array(String).default([]).description('白名单用户'),
  }).description('消息配置'),
])

/**
 * @description 插件的主入口函数，用于注册中间件和定义核心逻辑。
 * @param {Context} ctx - Koishi 的上下文对象。
 * @param {Config} config - 插件的配置对象。
 */
export function apply(ctx: Context, config: Config) {
  let globalBatch: MessageBatch = { messages: [], inactivityTimer: null, maxWaitTimer: null };

  /**
   * @description 发送给 AI 的系统提示词 (System Prompt)。
   * 它定义了 AI 的角色、任务、需要遵守的规则，以及输出的 JSON 格式。
   */
  const SYSTEM_PROMPT = `你是一个专业的内容审查 AI。请分析用户提供的消息对象 JSON 数组，并根据以下规则识别违规行为。每条消息都包含了 channelId 字段，代表其来源频道。

规则:
---
${config.Rule}
---

你的回答**必须且只能**是一个包裹在 \`\`\`json ... \`\`\` 代码块中的 JSON 对象，不包含任何解释性文字。该 JSON 对象必须符合以下格式规范，其中只包含一个键 "violations"，其值为一个违规对象的数组。如果没有发现违规行为，请返回一个空数组 \`"violations": []\`。

输出格式规范:
{
  "violations": [
    {
      "messageId": "string", // 违规消息的 'id'
      "userId": "string",    // 发送该消息用户的 'id'
      "reason": "string",    // 对违规行为的简明扼要的解释
      "mute": "number"       // (可选) 建议的禁言时长（秒）。仅在强烈建议禁言时才包含此字段
    }
  ]
}`;

  /**
   * @description 将 Koishi 的消息元素 (h 元素) 递归转换为标准化的 AiMessage JSON 对象。
   * @param {string} messageId - 原始消息的 ID。
   * @param {string} channelId - 消息所在的频道 ID。
   * @param {string} userId - 消息发送者的用户 ID。
   * @param {string} userName - 消息发送者的用户名或昵称。
   * @param {h[]} elements - 从 session.elements 解析出的 h 元素数组。
   * @returns {AiMessage} 构建好的、可直接序列化为 JSON 的 AiMessage 对象。
   */
  const hToAiMessage = (messageId: string, channelId: string, userId: string, userName: string, elements: h[]): AiMessage => {
    const message: AiMessage = { id: messageId, channelId: channelId, user: { id: userId, name: userName }, content: [] };
    let currentText = '';
    const pushText = () => {
      if (currentText) {
        message.content.push({ type: 'text', text: currentText.trim() });
        currentText = '';
      }
    };
    for (const el of elements) {
      if (el.type === 'text') {
        currentText += el.attrs.content;
      } else if ((el.type === 'img' || el.type === 'image') && (el.attrs.src || el.attrs.url)) {
        pushText();
        message.content.push({ type: 'image', url: el.attrs.src || el.attrs.url });
      } else if (el.type === 'forward') {
        pushText();
        if (!message.forwards) message.forwards = [];
        for (const msgNode of el.children) if (msgNode.type === 'message') message.forwards.push(hToAiMessage(messageId, channelId, msgNode.attrs.userId, msgNode.attrs.nickname, msgNode.children));
      }
    }
    pushText();
    return message;
  };

  /**
   * @description 调用AI服务进行内容审查。
   * @param {MessageInfo[]} messages - 待分析的 MessageInfo 对象数组。
   * @returns {Promise<Violation[]>} AI 识别出的 Violation 对象数组。如果请求失败或未发现违规，则返回空数组。
   */
  const callAI = async (messages: MessageInfo[]): Promise<Violation[]> => {
    if (messages.length === 0) return [];
    const aiMessages: AiMessage[] = messages.map(msg => hToAiMessage(msg.messageId, msg.channelId, msg.userId, msg.userName, h.parse(msg.content)));
    const maxRetries = 3;
    let lastError: Error | null = null;
    if (config.Debug) ctx.logger.info('准备请求模型:', JSON.stringify(aiMessages, null, 2));
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await ctx.http.post<{ choices: { message: { content: string } }[] }>(
          `${config.Endpoint.replace(/\/$/, '')}/chat/completions`,
          {
            model: config.Model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(aiMessages, null, 2) }
            ],
          },
          {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.ApiKey}` },
            timeout: 600000
          }
        );
        const responseContent: string = response?.choices?.[0]?.message?.content;
        if (!responseContent?.trim()) return [];
        const candidates: string[] = [];
        const jsonBlockMatch = responseContent.match(/```json\s*([\s\S]*?)\s*```/i);
        if (jsonBlockMatch && jsonBlockMatch[1]) candidates.push(jsonBlockMatch[1]);
        candidates.push(responseContent);
        const firstBrace = responseContent.indexOf('{');
        const lastBrace = responseContent.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(responseContent.substring(firstBrace, lastBrace + 1));
        for (const candidate of [...new Set(candidates)]) {
          try {
            const parsed = JSON.parse(candidate);
            return parsed.violations || [];
          } catch (parseError) { /* 忽略解析错误 */ }
        }
        ctx.logger.warn('原始响应:', JSON.stringify(response, null, 2));
        continue;
      } catch (e) {
        lastError = e;
        if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
    ctx.logger.error('调用模型失败:', lastError);
    return [];
  };

  /**
   * @description 处理 AI 返回的违规结果，并根据配置执行相应的操作（撤回、禁言、转发）。
   * @param {Violation[]} violations - 从 AI 服务获取的违规对象数组。
   * @param {MessageInfo[]} originalMessages - 原始的消息批次，用于查找完整消息内容和来源频道。
   */
  const processViolations = async (violations: Violation[], originalMessages: MessageInfo[]) => {
    if (config.Action.length === 0 || violations.length === 0) return;
    if (config.Debug) ctx.logger.info('模型返回:\n%s', JSON.stringify(violations, null, 2));
    const messageMap = new Map<string, MessageInfo>(originalMessages.map(msg => [msg.messageId, msg]));
    const forwardElements: h[] = [];
    const sortedViolations = violations
      .map(v => ({ violation: v, msg: messageMap.get(v.messageId) }))
      .filter(item => !!item.msg)
      .sort((a, b) => a.msg.timestamp - b.msg.timestamp)
      .map(item => item.violation);
    for (const violation of sortedViolations) {
      const originalMessage = messageMap.get(violation.messageId);
      if (!originalMessage) continue;
      const { channelId, guildId, userId, userName, messageId, content, timestamp } = originalMessage;
      const [platform] = channelId.split(':', 1);
      const bot = ctx.bots.find(b => b.platform === platform);
      if (!bot) continue;
      if (config.Action.includes('recall')) await bot.deleteMessage(channelId, messageId).catch(e => ctx.logger.warn(`撤回消息 [${messageId}] 失败: ${e.message}`));
      if (config.Action.includes('mute') && violation.mute > 0) await bot.muteGuildMember(guildId, userId, violation.mute * 1000).catch(e => ctx.logger.warn(`禁言用户 [${userId}] 失败: ${e.message}`));
      if (config.Action.includes('forward')) {
        const headerText = `[${new Date(timestamp).toLocaleString('zh-CN')}] ${channelId}:${userId}\n原因: ${violation.reason}`;
        const authorElement = h('author', { userId: userId, name: userName });
        const headerNode = h('message', {}, [authorElement, h.text(headerText)]);
        const messageNode = h('message', { timestamp: Math.floor(timestamp / 1000) }, [authorElement, ...h.parse(content)]);
        forwardElements.push(headerNode, messageNode);
      }
    }
    if (config.Action.includes('forward') && config.Target && forwardElements.length > 0) {
      const forwardMessage = h('message', { forward: true }, forwardElements);
      await ctx.broadcast([config.Target], [forwardMessage]).catch(e => ctx.logger.error(`转发消息失败: ${e.message}`));
    }
  };

  /**
   * @description 协调单个批次的分析和后续处理流程。
   * @param {MessageInfo[]} messages - 要分析的消息数组。
   */
  const analyzeAndAct = async (messages: MessageInfo[]) => {
    if (messages.length === 0) return;
    const violations = await callAI(messages);
    if (violations.length > 0) await processViolations(violations, messages);
  };

  /**
   * @description 智能触发对全局批次的分析。
   * 当满足以下任一条件时触发：
   * 1. 批次大小达到 `maxBatchSize`。
   * 2. 距离上一条消息超过 `inactivityTimeout` 秒。
   * 3. 批次中的第一条消息已等待超过 `maxBatchWaitTime` 秒。
   * @param {boolean} [isFinalTrigger=false] - 标记是否由超时（不活跃/最大等待）强制触发。
   */
  const triggerAnalysis = (isFinalTrigger: boolean = false) => {
    if (globalBatch.messages.length === 0) return;
    if (globalBatch.inactivityTimer) clearTimeout(globalBatch.inactivityTimer);
    if (globalBatch.maxWaitTimer) clearTimeout(globalBatch.maxWaitTimer);
    globalBatch.inactivityTimer = globalBatch.maxWaitTimer = null;
    if (isFinalTrigger) {
      const messagesToAnalyze = [...globalBatch.messages];
      globalBatch.messages = [];
      analyzeAndAct(messagesToAnalyze);
      return;
    }
    while (globalBatch.messages.length >= config.maxBatchSize) {
      const messagesToAnalyze = globalBatch.messages.splice(0, config.maxBatchSize);
      analyzeAndAct(messagesToAnalyze);
    }
    if (globalBatch.messages.length > 0) {
      globalBatch.inactivityTimer = setTimeout(() => triggerAnalysis(true), config.inactivityTimeout * 1000);
      if (!globalBatch.maxWaitTimer) globalBatch.maxWaitTimer = setTimeout(() => triggerAnalysis(true), config.maxBatchWaitTime * 1000);
    }
  };

  /**
   * @description 注册中间件，作为插件的核心驱动。
   * 它会监听所有符合条件的消息，并将其放入全局批处理队列中。
   */
  ctx.middleware(async (session, next) => {
    if (session.isDirect || !session.guildId || session.author.isBot || config.whitelist.includes(session.author.id) || session.cid === config.Target) return next();
    if (globalBatch.messages.length === 0) globalBatch.maxWaitTimer = setTimeout(() => triggerAnalysis(true), config.maxBatchWaitTime * 1000);
    if (globalBatch.inactivityTimer) clearTimeout(globalBatch.inactivityTimer);
    globalBatch.inactivityTimer = setTimeout(() => triggerAnalysis(true), config.inactivityTimeout * 1000);
    globalBatch.messages.push({
      userId: session.author.id,
      userName: session.author.name || session.author.id,
      channelId: session.cid,
      guildId: session.guildId,
      messageId: session.messageId,
      content: session.content,
      timestamp: Date.now(),
    });
    if (globalBatch.messages.length >= config.maxBatchSize) triggerAnalysis(false);
    return next();
  });
}
