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
 * 存储单条消息的关键信息，用于后续处理。
 */
interface MessageInfo {
  userId: string;
  userName: string;
  channelId: string;
  guildId: string;
  messageId: string;
  elements: h[];
  timestamp: number;
}

/**
 * 代表一个按用户和原因聚合的违规记录。
 */
interface ViolationGroup {
  user: string;
  reason: string;
  action: number;
  ids: string[];
}

/**
 * 插件的配置项接口。
 */
export interface Config {
  batchMode: boolean;
  maxBatchSize: number;
  maxBatchTime: number;
  whitelist: string[];
  Action: ('recall' | 'mute' | 'forward' | 'kick')[];
  Target: string;
  forwardRaw: boolean;
  Endpoint: string;
  ApiKey: string;
  Model: string;
  Rule: string;
  Debug: boolean;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    Endpoint: Schema.string().required().description('API 端点 (Endpoint)'),
    ApiKey: Schema.string().role('secret').required().description('API 密钥 (Key)'),
    Model: Schema.string().description('模型 (Model)'),
    Rule: Schema.string().role('textarea').description('审查规则'),
    Debug: Schema.boolean().default(false).description('输出原始请求与响应'),
  }).description('模型配置'),
  Schema.object({
    Action: Schema.array(Schema.union(['recall', 'mute', 'forward', 'kick'])).role('select').description('执行操作'),
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
 * @param ctx - Koishi 的上下文对象。
 * @param config - 插件的配置对象。
 */
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('ai-manager');

  let messageBatch: MessageInfo[] = [];
  let batchTimer: NodeJS.Timeout | null = null;
  let batchStartTime: number | null = null;
  let retryTime = 0;

  const SYSTEM_PROMPT = `<role>你是一个具备高级上下文理解能力的内容审查AI。你的任务是精确、严格、高效地分析给定的对话片段，识别违反规则的行为，并仅以指定的JSON格式返回违规结果。</role>
<instructions>
1. 综合上下文进行分析: 你将收到的消息数组是按时间顺序排列的。你必须综合上下文来判断。特别注意识别由同一用户连续的多条消息所构成的违规，例如刷屏、骚扰、或逐渐升级的争吵，此外避免单一消息的误判。
2. 返回所有相关结果: 当一个用户的多条消息共同构成一种违规时（例如刷屏），你必须在一个违规组中，通过 \`ids\` 字段报告所有相关的消息ID。你的目标是完整地记录构成违规行为的所有消息。
3. 在原因中解释上下文: 在返回的 "reason" 字段中，必须清晰说明违规原因。如果判断基于多条消息的上下文，请明确指出，例如：“用户连续发布多条相似内容，构成刷屏”或“在对话中持续对他人进行人身攻击”。
4. 严格的JSON输出: 你的回答必须是合法的JSON数组格式。绝对禁止在JSON内容之外添加任何解释、问候、思考或其他非JSON的内容，只需要输出一个JSON数组。如果未发现违规，必须返回空数组 \`[]\`。
</instructions>
<input_format>你将收到一个JSON数组，其中每个对象代表一条消息：[{ "id": "消息的唯一ID", "guildId": "群组ID", "userId": "用户ID", "content": "消息的元素化数组" }]</input_format>
<output_format>你必须返回一个JSON数组，其中每个对象代表一个违规记录：[{ "user": "违规用户的ID", "reason": "违规原因", "action": 数字（正数代表禁言秒数，负数代表踢出）, "ids": ["相关消息的ID列表"] }]</output_format>
<rules>${config.Rule}</rules>`;

  /**
   * 触发对当前消息批次的完整分析流程。
   * 包含：调用AI -> 解析结果 -> 执行惩罚 -> 转发通报
   */
  const triggerAnalysis = async () => {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = null;
    batchStartTime = null;
    if (messageBatch.length === 0) return;
    const messagesToAnalyze = [...messageBatch];
    messageBatch = [];
    let violations: ViolationGroup[] = [];
    const aiPayload = messagesToAnalyze.map(msg => ({ id: msg.messageId, guildId: msg.guildId, userId: msg.userId, content: msg.elements }));
    if (config.Debug) logger.info('请求模型:', JSON.stringify(aiPayload, null, 2));
    let attempt = 0;
    let success = false;
    while (!success) {
      if (Date.now() < retryTime) await new Promise(resolve => setTimeout(resolve, retryTime - Date.now()));
      try {
        const response = await ctx.http.post<{ choices: { message: { content: string } }[] }>(
          `${config.Endpoint.replace(/\/$/, '')}/chat/completions`,
          { model: config.Model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(aiPayload) }] },
          { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.ApiKey}` }, timeout: 600000 }
        );
        const content = response?.choices?.[0]?.message?.content;
        if (!content) throw new Error('No content in AI response');
        const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
        const jsonString = jsonMatch ? jsonMatch[1].trim() : content.trim();
        try {
          const parsed = JSON.parse(jsonString);
          if (Array.isArray(parsed)) violations = parsed as ViolationGroup[];
        } catch {
          const firstBracket = jsonString.indexOf('[');
          const lastBracket = jsonString.lastIndexOf(']');
          if (firstBracket !== -1 && lastBracket > firstBracket) {
            try {
              const parsed = JSON.parse(jsonString.substring(firstBracket, lastBracket + 1));
              if (Array.isArray(parsed)) violations = parsed as ViolationGroup[];
            } catch { /* 解析失败 */ }
          }
        }
        if (violations) {
          retryTime = 0;
          success = true;
          if (config.Debug) logger.info('模型返回:', JSON.stringify(violations, null, 2));
        } else {
           throw new Error;
        }
      } catch (e) {
        attempt++;
        retryTime = Date.now() + 20000 + attempt * 10000;
        logger.error(`第 ${attempt} 次请求失败: ${e.message}`);
      }
    }
    if (config.Action.length === 0 || violations.length === 0) return;
    const messageMap = new Map<string, MessageInfo>(messagesToAnalyze.map(msg => [msg.messageId, msg]));
    let allForwardElements: h[] = [];
    for (const violation of violations) {
      const firstValidMsgId = violation.ids.find(id => messageMap.has(id));
      if (!firstValidMsgId) continue;
      const representativeMsg = messageMap.get(firstValidMsgId);
      const bot = ctx.bots.find(b => b.platform === representativeMsg.channelId.split(':', 1)[0]);
      if (!bot) continue;
      if (violation.action > 0 && config.Action.includes('mute')) {
        await bot.muteGuildMember(representativeMsg.guildId, violation.user, violation.action * 1000).catch(e => logger.warn(`禁言 [${violation.user}] 失败: ${e.message}`));
      } else if (violation.action < 0 && config.Action.includes('kick')) {
        await bot.kickGuildMember(representativeMsg.guildId, violation.user).catch(e => logger.warn(`踢出 [${violation.user}] 失败: ${e.message}`));
      }
      if (config.Action.includes('recall')) {
        for (const msgId of violation.ids) {
          if (messageMap.has(msgId)) {
            const msg = messageMap.get(msgId);
            await bot.deleteMessage(msg.channelId, msg.messageId).catch(e => logger.warn(`撤回 [${msg.messageId}] 失败: ${e.message}`));
          }
        }
      }
      if (config.Action.includes('forward')) {
        const author = h('author', { id: representativeMsg.userId, name: representativeMsg.userName });
        allForwardElements.push(h('message', {}, [author, h.text(`时间: ${new Date(representativeMsg.timestamp).toLocaleString('zh-CN')}\n用户: ${representativeMsg.userName} (${representativeMsg.guildId}:${violation.user})\n原因: ${violation.reason}`)]));
        const sortedMsgIds = violation.ids.filter(id => messageMap.has(id)).sort((a, b) => messageMap.get(a).timestamp - messageMap.get(b).timestamp);
        for (const msgId of sortedMsgIds) {
          const msg = messageMap.get(msgId);
          allForwardElements.push(h('message', {}, [h('author', { id: msg.userId, name: msg.userName }), ...msg.elements]));
          if (config.forwardRaw) {
            allForwardElements.push(h('message', {}, [
              author,
              h.text(inspect(msg.elements.map(element => {
                if (element.type === 'json' && typeof element.attrs.data === 'string') return { ...element, attrs: { ...element.attrs, data: JSON.parse(element.attrs.data) } };
                return element;
              }), { depth: Infinity, colors: false }))
            ]));
          }
        }
      }
    }
    if (allForwardElements.length > 0 && config.Target) await ctx.broadcast([config.Target], h('message', { forward: true }, allForwardElements)).catch(e => logger.error(`转发消息失败: ${e.message}`));
  };

  /**
   * 中间件，用于捕获和批处理消息。
   */
  ctx.middleware(async (session, next) => {
    if (session.isDirect || !session.guildId || session.author.isBot || config.whitelist.includes(session.userId) || session.cid === config.Target) return next();
    messageBatch.push({
      userId: session.userId, userName: session.author.name ?? session.userId,
      channelId: session.cid, guildId: session.guildId, messageId: session.messageId,
      elements: session.elements, timestamp: Date.now(),
    });
    if (messageBatch.length >= config.maxBatchSize) {
      await triggerAnalysis();
    } else if (config.batchMode) {
      if (messageBatch.length === 1) batchStartTime = Date.now();
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(triggerAnalysis, Math.max(0, (config.maxBatchTime * 1000) - (Date.now() - batchStartTime)));
    }
    return next();
  });

  /**
   * 在插件停用时，处理剩余的消息。
   */
  ctx.on('dispose', async () => {
    if (batchTimer) clearTimeout(batchTimer);
    if (messageBatch.length > 0) await triggerAnalysis();
  });
}
